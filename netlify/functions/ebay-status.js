// ebay-status.js
// Checks the live status of eBay listings — whether each is active, sold out, or ended.
// Uses the Browse API (get_item) which is available without partner-level access.
// POST /.netlify/functions/ebay-status
// Body: { listingIds: ["12345", "67890", ...] }

const { getValidToken } = require('./ebay-refresh');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { listingIds } = body;
  if (!listingIds?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing listingIds' }) };
  }

  let access_token;
  try { access_token = await getValidToken(); }
  catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'eBay auth: ' + err.message }) };
  }

  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Accept': 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_MOTORS',
  };

  const statusMap = {};

  // Check each listing via Browse API item lookup.
  // We batch with Promise.all but cap concurrency to avoid rate limits.
  const BATCH = 5;
  for (let i = 0; i < listingIds.length; i += BATCH) {
    const batch = listingIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (rawId) => {
      const id = String(rawId);
      // Browse API uses "v1|{itemId}|0" format for legacy item IDs
      const legacyId = `v1|${id}|0`;
      try {
        const res = await fetch(
          `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(legacyId)}`,
          { headers }
        );

        if (res.status === 404) {
          // Listing no longer exists — ended or removed
          statusMap[id] = { status: 'ended', reason: 'not_found' };
          return;
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const reason = err?.errors?.[0]?.errorId;

          // 11001 / 11006 = item not found or not available
          if (reason === 11001 || reason === 11006 || res.status === 410) {
            statusMap[id] = { status: 'ended', reason: 'unavailable' };
          } else {
            statusMap[id] = { status: 'unknown', reason: `api_error_${res.status}` };
          }
          return;
        }

        const item = await res.json();

        // Determine status from item fields
        const buyingOptions  = item.buyingOptions || [];
        const availableQty   = item.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity ?? null;
        const soldQty        = item.estimatedAvailabilities?.[0]?.estimatedSoldQuantity ?? null;
        const endDate        = item.itemEndDate || null;
        const isAuction      = buyingOptions.includes('AUCTION');
        const now            = new Date();
        const ended          = endDate && new Date(endDate) < now;

        let status;
        if (ended) {
          status = 'ended';
        } else if (availableQty !== null && availableQty === 0) {
          status = 'sold_out';
        } else {
          status = 'active';
        }

        statusMap[id] = {
          status,
          availableQty,
          soldQty,
          endDate,
          title:    item.title || null,
          price:    item.price?.value ? parseFloat(item.price.value) : null,
          imageUrl: item.image?.imageUrl || null,
          isAuction,
        };

      } catch (err) {
        statusMap[id] = { status: 'unknown', reason: err.message };
      }
    }));

    // Small pause between batches
    if (i + BATCH < listingIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statusMap }),
  };
};

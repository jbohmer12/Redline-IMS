// ebay-store-sync.js
// Scans the ridersmiamiadventuremoto eBay store and returns all active listings.
// The frontend matches these against existing parts by OEM/title and updates ebayStatus.

const { getValidToken } = require('./ebay-refresh');

const SELLER = 'ridersmiamiadventuremoto';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  let token;
  try { token = await getValidToken(); }
  catch(e) { return { statusCode: 500, body: JSON.stringify({ error: 'Auth: ' + e.message }) }; }

  const h = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Accept-Language': 'en-US'
  };
  const BASE = 'https://api.ebay.com';

  try {
    // Use Sell Inventory API — fetch all YOUR offers directly (no Browse API needed)
    const allOffers = [];
    let offset = 0;
    while (true) {
      const res = await fetch(
        `${BASE}/sell/inventory/v1/offer?limit=100&offset=${offset}`,
        { headers: h }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`Offers ${res.status}: ${JSON.stringify(data)}`);
      const offers = data.offers || [];
      allOffers.push(...offers);
      if (offers.length < 100 || allOffers.length >= (data.total || 0)) break;
      offset += 100;
    }

    // Build a lookup: listingId → { title, price, status, sku, categoryId, oemNum }
    const listings = [];
    for (const offer of allOffers) {
      if (!offer.sku) continue;
      const listingId = offer.listing?.listingId || null;
      const status = listingId ? 'active' : 'unlisted';

      // Get inventory item for title + OEM
      try {
        const invRes = await fetch(
          `${BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`,
          { headers: h }
        );
        if (!invRes.ok) continue;
        const inv = await invRes.json();
        const product = inv.product || {};

        listings.push({
          sku: offer.sku,
          listingId,
          listingUrl: listingId ? `https://www.ebay.com/itm/${listingId}` : null,
          status,
          title: product.title || offer.sku,
          price: parseFloat(offer.pricingSummary?.price?.value || '0'),
          oemNum: product.mpn || product.aspects?.['Manufacturer Part Number']?.[0] || null,
          imageUrls: product.imageUrls || [],
          categoryId: offer.categoryId || null,
        });
      } catch(e) { console.warn('Skip SKU', offer.sku, e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, count: listings.length, listings })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};

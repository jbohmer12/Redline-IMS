// ebay-sync.js — checks eBay orders and returns sold quantities per listing
// POST /.netlify/functions/ebay-sync
// Body: { listingIds: ["12345", "67890", ...] }
// Uses the server-side eBay token (EBAY_REFRESH_TOKEN), like the other eBay functions.

const { requireUser } = require('../lib/auth');
const { getValidToken } = require('../lib/ebay-refresh');
exports.handler = async (event) => {
  // Signed-in users only; see netlify/lib/auth.js
  const auth = await requireUser(event, {});
  if (auth.error) return auth.error;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { listingIds } = body;

  if (!Array.isArray(listingIds) || !listingIds.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing listingIds' }) };
  }

  let access_token;
  try { access_token = await getValidToken(); }
  catch (e) { return { statusCode: 500, body: JSON.stringify({ error: 'eBay connection is not set up on the server.' }) }; }

  const BASE = 'https://api.ebay.com';

  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };

  try {
    // Fetch orders from the last 90 days
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // eBay Fulfillment API — get all orders
    // Follow `next` links so busy stores don't lose sales past the first page (max 10 pages x 200).
    const orders = [];
    let pageUrl = `${BASE}/sell/fulfillment/v1/order?limit=200&filter=creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS|FULFILLED}`;
    for (let page = 0; pageUrl && page < 10; page++) {
      const ordersRes = await fetch(pageUrl, { headers });
      if (!ordersRes.ok) {
        const err = await ordersRes.json().catch(() => ({}));
        throw new Error(`Orders API failed (${ordersRes.status}): ${JSON.stringify(err.errors?.[0] || err)}`);
      }
      const ordersData = await ordersRes.json();
      orders.push(...(ordersData.orders || []));
      pageUrl = ordersData.next || null;
    }

    // Build a map: listingId → { qtySold, orders[] }
    const soldMap = {};

    for (const order of orders) {
      for (const lineItem of (order.lineItems || [])) {
        const legacyItemId = lineItem.legacyItemId;
        if (!legacyItemId) continue;
        if (!listingIds.includes(String(legacyItemId))) continue;

        if (!soldMap[legacyItemId]) {
          soldMap[legacyItemId] = { qtySold: 0, orders: [] };
        }

        soldMap[legacyItemId].qtySold += lineItem.quantity || 1;
        soldMap[legacyItemId].orders.push({
          orderId:       order.orderId,
          createdAt:     order.creationDate,
          status:        order.orderFulfillmentStatus,
          qty:           lineItem.quantity || 1,
          salePrice:     lineItem.lineItemCost?.value || null
        });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, soldMap, totalOrders: orders.length })
    };

  } catch (err) {
    console.error('eBay sync error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};

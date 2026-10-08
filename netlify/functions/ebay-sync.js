// ebay-sync.js — checks eBay orders and returns sold quantities per listing
// POST /.netlify/functions/ebay-sync
// Body: { access_token, env, listingIds: ["12345", "67890", ...] }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { access_token, env, listingIds } = body;

  if (!access_token || !listingIds?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing access_token or listingIds' }) };
  }

  const isSandbox = env !== 'production';
  const BASE = isSandbox
    ? 'https://api.sandbox.ebay.com'
    : 'https://api.ebay.com';

  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };

  try {
    // Fetch orders from the last 90 days
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // eBay Fulfillment API — get all orders
    const ordersRes = await fetch(
      `${BASE}/sell/fulfillment/v1/order?filter=creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS|FULFILLED}`,
      { headers }
    );

    if (!ordersRes.ok) {
      const err = await ordersRes.json().catch(() => ({}));
      throw new Error(`Orders API failed (${ordersRes.status}): ${JSON.stringify(err.errors?.[0] || err)}`);
    }

    const ordersData = await ordersRes.json();
    const orders = ordersData.orders || [];

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
          buyerUsername: order.buyer?.username || 'unknown',
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

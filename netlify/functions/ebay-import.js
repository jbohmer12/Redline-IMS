const { getValidToken } = require('./ebay-refresh');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  let token;
  try { token = await getValidToken(); }
  catch(e) { return { statusCode: 500, body: JSON.stringify({ error: 'Auth: ' + e.message }) }; }

  const BASE = 'https://api.ebay.com';
  // Must include Accept-Language: en-US — Node fetch auto-generates an invalid value otherwise
  const h = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Accept-Language': 'en-US'
  };
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const allItems = [];
    let offset = 0;
    while (true) {
      const res = await fetch(`${BASE}/sell/inventory/v1/inventory_item?limit=100&offset=${offset}`, { headers: h });
      const data = await res.json();
      if (!res.ok) throw new Error(`Inventory API ${res.status}: ${JSON.stringify(data)}`);
      const items = data.inventoryItems || [];
      allItems.push(...items);
      if (items.length < 100 || allItems.length >= (data.total || 0)) break;
      offset += 100;
    }

    if (allItems.length === 0) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, count: 0, parts: [], message: 'No inventory items found' }) };
    }

    const condMap = { 'NEW':'New','USED_EXCELLENT':'Used','USED_GOOD':'Used','USED_FAIR':'Used','USED_POOR':'Used','FOR_PARTS_OR_NOT_WORKING':'Damaged' };
    const parts = [];

    for (const item of allItems) {
      const sku = item.sku;
      if (!sku) continue;
      try {
        const offerRes = await fetch(`${BASE}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`, { headers: h });
        const offerData = offerRes.ok ? await offerRes.json() : { offers: [] };
        const offer = (offerData.offers || []).find(o => o.listing?.listingId);
        const product = item.product || {};
        const title = product.title || sku;
        parts.push({
          id: ('EBAY-' + sku).replace(/[^a-zA-Z0-9-]/g, '-').substring(0, 20),
          name: title,
          category: mapCat(offer?.categoryId),
          condition: condMap[item.condition] || 'Used',
          make: product.aspects?.Brand?.[0] || extractMake(title),
          model: product.aspects?.Fit?.[0] || '',
          year: product.aspects?.Year?.[0] || extractYear(title),
          oemnum: product.mpn || product.aspects?.['Manufacturer Part Number']?.[0] || '',
          price: parseFloat(offer?.pricingSummary?.price?.value || '0'),
          qty: item.availability?.shipToLocationAvailability?.quantity || 1,
          notes: item.conditionDescription || '',
          location: '',
          imageUrls: product.imageUrls || [],
          ebayListingId: offer?.listing?.listingId || null,
          ebayListingUrl: offer?.listing?.listingId ? `https://www.ebay.com/itm/${offer.listing.listingId}` : null,
          ebayStatus: offer?.listing?.listingId ? 'active' : null,
        });
      } catch(e) { console.warn('Skip', sku, e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, count: parts.length, totalItems: allItems.length, parts })
    };
  } catch(e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

function mapCat(id) {
  const m = {'10063':'Exhaust','35560':'Body/Fairings','35561':'Body/Fairings','33566':'Brakes','33580':'Suspension','6684':'Engine','33742':'Engine','26562':'Electrical','178026':'Electrical','178027':'Electrical','66830':'Drivetrain','179844':'Body/Fairings'};
  return m[String(id)] || 'Other';
}
function extractMake(t) {
  for (const m of ['Honda','Yamaha','Kawasaki','Suzuki','Ducati','BMW','KTM','Triumph','Aprilia','Husqvarna'])
    if ((t||'').toLowerCase().includes(m.toLowerCase())) return m;
  return '';
}
function extractYear(t) { const m=(t||'').match(/\b(19|20)\d{2}(-\d{2,4})?\b/); return m?m[0]:''; }

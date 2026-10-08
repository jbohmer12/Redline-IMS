const { getValidToken } = require('./ebay-refresh');

// Known non-leaf (parent) category IDs in eBay Motors tree 100 — never use these
const PARENT_CATEGORY_IDS = new Set([
  '6028',  // Parts & Accessories
  '10063', // Exhaust & Exhaust Systems (parent)
  '35544', // Body & Frame (parent)
  '35561', // Fenders (parent — has subcategories)
  '33559', // Brakes (parent)
  '50450', // Handlebars, Grips & Controls (parent)
  '33573', // Suspension & Handling (parent)
  '6684',  // Engines & Engine Parts (parent)
  '33736', // Air Intake & Fuel Delivery (parent)
  '26557', // Electrical & Ignition (parent)
  '178016',// Lighting & Lamps (parent)
  '66830', // Wheels, Tires & Parts (parent)
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { part, listing } = body;
  if (!part || !listing) return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };

  let access_token;
  try { access_token = await getValidToken(); }
  catch(err) { return { statusCode: 500, body: JSON.stringify({ error: 'eBay auth: ' + err.message }) }; }

  const BASE = 'https://api.ebay.com';
  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Content-Language': 'en-US',
    'Accept-Language': 'en-US'
  };

  const sku = (part.id || `PART-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
  const MARKETPLACE = 'EBAY_MOTORS';

  let categoryId;
  if (listing.categoryId) {
    categoryId = String(listing.categoryId);
    console.log(`Using caller-supplied categoryId: "${categoryId}"`);
  } else {
    categoryId = await fetchCategoryId(BASE, headers, listing.title, part);
    console.log(`Resolved categoryId: "${categoryId}" for "${listing.title}"`);
  }

  try {
    // 1. Delete any existing offer for this SKU
    const existingRes = await fetch(`${BASE}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`, { headers });
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      for (const offer of (existingData.offers || [])) {
        await fetch(`${BASE}/sell/inventory/v1/offer/${offer.offerId}`, { method: 'DELETE', headers }).catch(() => {});
      }
    }

    // 2. Delete existing inventory item
    await fetch(`${BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'DELETE', headers
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // 3. Ensure merchant location
    await ensureMerchantLocation(BASE, headers);

    // 4. Auto-fetch business policies
    const policies = await fetchPolicies(BASE, headers, MARKETPLACE);

    // 5. Create inventory item
    const conditionMap = { 'New': 'NEW', 'Used': 'USED_EXCELLENT', 'Damaged': 'FOR_PARTS_OR_NOT_WORKING' };
    const inventoryItem = {
      availability: { shipToLocationAvailability: { quantity: listing.quantity || part.qty || 1 } },
      condition: conditionMap[part.condition] || 'USED_EXCELLENT',
      conditionDescription: listing.conditionDescription || '',
      product: {
        title: listing.title,
        description: listing.description,
        aspects: buildAspects(part),
        brand: part.make || undefined,
        mpn: part.oemnum ? part.oemnum.split(',')[0].trim() : undefined,
        imageUrls: listing.imageUrls || []
      },
      packageWeightAndSize: {
        dimensions: { height: 1, length: 1, width: 1, unit: 'INCH' },
        weight: { value: 1, unit: 'POUND' }
      }
    };

    const invRes = await fetch(`${BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT', headers, body: JSON.stringify(inventoryItem)
    });
    if (!invRes.ok && invRes.status !== 204) {
      const err = await invRes.json().catch(() => ({}));
      throw new Error(`Inventory item failed (${invRes.status}): ${JSON.stringify(err.errors?.[0] || err)}`);
    }

    // 6. Create offer
    const listingPolicies = {};
    if (policies.fulfillmentPolicyId) listingPolicies.fulfillmentPolicyId = policies.fulfillmentPolicyId;
    if (policies.paymentPolicyId)     listingPolicies.paymentPolicyId     = policies.paymentPolicyId;
    if (policies.returnPolicyId)      listingPolicies.returnPolicyId      = policies.returnPolicyId;

    const offerBody = {
      sku,
      marketplaceId: MARKETPLACE,
      format: 'FIXED_PRICE',
      availableQuantity: listing.quantity || part.qty || 1,
      categoryId,
      listingDescription: listing.description,
      listingPolicies,
      merchantLocationKey: 'riders-miami-warehouse',
      pricingSummary: { price: { value: String(listing.price || '0.00'), currency: 'USD' } }
    };

    const offerRes = await fetch(`${BASE}/sell/inventory/v1/offer`, {
      method: 'POST', headers, body: JSON.stringify(offerBody)
    });
    const offerData = await offerRes.json();
    if (!offerRes.ok) throw new Error(`Offer failed (${offerRes.status}): ${JSON.stringify(offerData.errors?.[0] || offerData)}`);

    // 7. Publish
    const pubRes = await fetch(`${BASE}/sell/inventory/v1/offer/${offerData.offerId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({})
    });
    const pubData = await pubRes.json();
    if (!pubRes.ok) throw new Error(`Publish failed (${pubRes.status}): ${JSON.stringify(pubData.errors?.[0] || pubData)}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        listingId: pubData.listingId,
        listingUrl: `https://www.ebay.com/itm/${pubData.listingId}`,
        offerId: offerData.offerId,
        sku,
        categoryId,
        marketplace: MARKETPLACE
      })
    };

  } catch (err) {
    console.error('eBay listing error:', err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};

// Fetch category from eBay Taxonomy API, skipping known parent IDs
async function fetchCategoryId(BASE, headers, title, part) {
  try {
    const query = buildCategoryQuery(title, part);
    const res = await fetch(
      `${BASE}/commerce/taxonomy/v1/category_tree/100/get_category_suggestions?q=${encodeURIComponent(query)}`,
      { headers: { 'Authorization': headers.Authorization, 'Accept': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const suggestions = data.categorySuggestions || [];
      // Walk suggestions and return first non-parent category ID
      for (const s of suggestions) {
        const id = s.category?.categoryId;
        if (id && !PARENT_CATEGORY_IDS.has(String(id))) {
          console.log(`Taxonomy API: using categoryId=${id} (${s.category?.categoryName})`);
          return String(id);
        }
      }
      console.warn('All taxonomy suggestions were parent categories, using local fallback');
    } else {
      console.warn(`Taxonomy API ${res.status}, using local fallback`);
    }
  } catch(e) {
    console.warn('Taxonomy fetch failed:', e.message);
  }
  return findLeafCategoryLocal(title, part);
}

function buildCategoryQuery(title, part) {
  const parts = [title];
  if (part.make) parts.push(part.make);
  if (part.model) parts.push(part.model);
  const q = parts.join(' ');
  return q.toLowerCase().includes('motorcycle') ? q : `motorcycle ${q}`;
}

// Verified eBay Motors leaf category IDs (fallback only)
function findLeafCategoryLocal(title, part) {
  const categoryMap = [
    { keywords: ['license plate', 'plate holder', 'plate frame', 'plate bracket'], id: '179747' },
    { keywords: ['fender eliminator'], id: '179844' },
    { keywords: ['fairing', 'bodywork', 'body kit'], id: '35560' },
    { keywords: ['tail light', 'taillight', 'brake light', 'rear light'], id: '178026' },
    { keywords: ['turn signal', 'indicator light'], id: '178023' },
    { keywords: ['headlight', 'head light'], id: '178027' },
    { keywords: ['fender', 'rear fender', 'front fender'], id: '179753' },
    { keywords: ['exhaust', 'muffler', 'slip on', 'full system', 'header'], id: '10063' },
    { keywords: ['brake caliper', 'brake rotor', 'brake disc', 'brake pad', 'brake lever'], id: '33566' },
    { keywords: ['clutch lever', 'clutch cable', 'clutch kit'], id: '33741' },
    { keywords: ['handlebar', 'grip', 'bar end', 'throttle', 'mirror'], id: '50454' },
    { keywords: ['fork', 'shock', 'suspension', 'spring'], id: '33580' },
    { keywords: ['engine', 'piston', 'valve', 'gasket', 'cylinder'], id: '6684' },
    { keywords: ['air filter', 'intake', 'carburetor', 'carb', 'fuel injector'], id: '33742' },
    { keywords: ['ignition', 'ecu', 'wire harness', 'battery', 'starter motor'], id: '26562' },
    { keywords: ['wheel', 'rim', 'tire', 'tube', 'sprocket', 'chain'], id: '66830' },
    { keywords: ['seat', 'saddle'], id: '79897' },
  ];
  const text = `${title} ${part.category || ''} ${part.notes || ''}`.toLowerCase();
  for (const { keywords, id } of categoryMap) {
    if (keywords.some(k => text.includes(k))) return id;
  }
  return '179753'; // Other Motorcycle & Scooter Parts
}

async function ensureMerchantLocation(BASE, headers) {
  const key = 'riders-miami-warehouse';
  const checkRes = await fetch(`${BASE}/sell/inventory/v1/location/${key}`, { headers });
  if (checkRes.ok) return;
  await fetch(`${BASE}/sell/inventory/v1/location/${key}`, {
    method: 'POST', headers,
    body: JSON.stringify({
      location: { address: { addressLine1: '1000 NW 57th Ct', city: 'Miami', stateOrProvince: 'FL', postalCode: '33126', country: 'US' } },
      locationInstructions: 'Riders Miami Motorsports',
      name: 'Riders Miami Warehouse',
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE']
    })
  }).catch(() => {});
}

async function fetchPolicies(BASE, headers, marketplace) {
  const result = {};
  // Try preferred marketplace first, fall back to EBAY_US (where most accounts have policies)
  const marketplacesToTry = marketplace === 'EBAY_US' ? ['EBAY_US'] : [marketplace, 'EBAY_US'];
  try {
    for (const mid of marketplacesToTry) {
      const q = `marketplace_id=${mid}`;
      const [fulfillRes, paymentRes, returnRes] = await Promise.all([
        fetch(`${BASE}/sell/account/v1/fulfillment_policy?${q}`, { headers }),
        fetch(`${BASE}/sell/account/v1/payment_policy?${q}`, { headers }),
        fetch(`${BASE}/sell/account/v1/return_policy?${q}`, { headers })
      ]);
      if (fulfillRes.ok) { const d = await fulfillRes.json(); const p = d.fulfillmentPolicies?.[0]; if (p) result.fulfillmentPolicyId = p.fulfillmentPolicyId; }
      if (paymentRes.ok) { const d = await paymentRes.json(); const p = d.paymentPolicies?.[0]; if (p) result.paymentPolicyId = p.paymentPolicyId; }
      if (returnRes.ok)  { const d = await returnRes.json(); const p = d.returnPolicies?.[0]; if (p) result.returnPolicyId = p.returnPolicyId; }
      // If we got all three, no need to try fallback
      if (result.fulfillmentPolicyId && result.paymentPolicyId && result.returnPolicyId) {
        console.log(`Policies resolved from marketplace: ${mid}`);
        break;
      }
    }
  } catch(e) { console.error('Policy fetch error:', e); }
  console.log('Policies found:', JSON.stringify(result));
  return result;
}

function buildAspects(part) {
  const aspects = {};
  if (part.make)   aspects['Brand']                    = [part.make];
  if (part.model)  aspects['Fit']                      = [part.model];
  if (part.year)   aspects['Year']                     = [part.year];
  if (part.oemnum) aspects['Manufacturer Part Number'] = [part.oemnum.split(',')[0].trim()];
  return aspects;
}

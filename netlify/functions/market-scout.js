// market-scout.js — V5
// Returns verified-active listings with sold count, listing age, and active status.

const { getValidToken } = require('./ebay-refresh');

const CATEGORY_MAP = {
  all:        null,
  exhaust:    '10063',
  bodywork:   '35544',
  brakes:     '33559',
  controls:   '50450',
  suspension: '33573',
  engine:     '6684',
  electrical: '26557',
  lighting:   '178016',
  wheels:     '66830',
  intake:     '33736',
  mirrors:    '177876',
};

const SORT_MAP = {
  bestMatch:   'BEST_MATCH',
  priceLow:    'price',
  priceHigh:   '-price',
  newlyListed: 'newlyListed',
  endingSoon:  'endingSoon',
};

// Verify a single item is active and collect richer detail fields
async function verifyItem(itemId, headers) {
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}?fieldgroups=ADDITIONAL_SELLER_DETAILS`,
      { headers }
    );

    if (res.status === 404) return { active: false, reason: 'not_found' };
    if (!res.ok)            return { active: false, reason: `http_${res.status}` };

    const d = await res.json();

    // Check if listing has ended
    if (d.itemEndDate && new Date(d.itemEndDate) < new Date()) {
      return { active: false, reason: 'ended', endDate: d.itemEndDate };
    }

    if (!d.buyingOptions || d.buyingOptions.length === 0) {
      return { active: false, reason: 'no_buying_options' };
    }

    const avail    = d.estimatedAvailabilities?.[0];
    const availQty = avail?.estimatedAvailableQuantity ?? null;
    const soldQty  = avail?.estimatedSoldQuantity      ?? null;

    if (availQty !== null && availQty <= 0) {
      return { active: false, reason: 'sold_out' };
    }

    const unavailable = d.adornments?.some(a =>
      a.type === 'LISTING_ENDED' || a.type === 'ITEM_UNAVAILABLE'
    );
    if (unavailable) return { active: false, reason: 'unavailable_adornment' };

    // listingDate is returned by the item detail endpoint (not the search summary)
    const listingDate = d.listingDate || null;

    return {
      active:       true,
      soldCount:    soldQty,
      availableQty: availQty,
      endDate:      d.itemEndDate  || null,
      listingDate,                          // <-- when the listing was created
      condition:    d.condition    || null,
      listingType:  d.buyingOptions?.[0]   || null,
    };

  } catch (err) {
    return { active: true, verified: false, reason: 'network_error' };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    category   = 'all',
    keywords   = '',
    minPrice   = 0,
    maxPrice   = 9999,
    maxResults = 40,
    sortBy     = 'bestMatch',
  } = body;

  let access_token;
  try { access_token = await getValidToken(); }
  catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'eBay auth: ' + err.message }) };
  }

  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Accept':        'application/json',
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_MOTORS',
    'X-EBAY-C-ENDUSERCTX':    'contextualLocation=country%3DUS',
  };

  const sort = SORT_MAP[sortBy] || 'BEST_MATCH';

  const filters = [];
  if (minPrice > 0 || maxPrice < 9999) {
    filters.push(`price:[${minPrice}..${maxPrice}],priceCurrency:USD`);
  }
  const catId = CATEGORY_MAP[category];
  filters.push(catId ? `categoryIds:{${catId}}` : 'categoryIds:{6028}');
  filters.push('buyingOptions:{FIXED_PRICE|AUCTION}');
  filters.push('itemLocationCountry:US');

  const fetchLimit = Math.min(maxResults * 3, 200);

  const params = new URLSearchParams({
    q:           keywords.trim() || 'motorcycle parts',
    filter:      filters.join(','),
    sort,
    limit:       String(fetchLimit),
    fieldgroups: 'EXTENDED',
  });

  let searchData;
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      { headers }
    );
    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: 'eBay Browse API error', detail: errText }) };
    }
    searchData = await res.json();
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Fetch failed: ' + err.message }) };
  }

  const rawItems = searchData.itemSummaries || [];

  const CONCURRENCY = 8;
  const verified  = [];
  const skipped   = [];

  for (let i = 0; i < rawItems.length && verified.length < maxResults; i += CONCURRENCY) {
    const batch = rawItems.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(item => verifyItem(item.itemId, headers).then(v => ({ item, v })))
    );

    for (const { item, v } of results) {
      if (verified.length >= maxResults) break;
      if (!v.active) { skipped.push({ id: item.itemId, reason: v.reason }); continue; }

      const watchCount = typeof item.watchCount === 'number' ? item.watchCount : null;
      const soldCount  = v.soldCount ?? item.soldQuantity ?? null;

      const demandScore =
        (soldCount  ?? 0) * 10 +
        (watchCount ?? 0) * 2 +
        (item.topRatedBuyingExperience ? 5 : 0) +
        (item.shippingOptions?.some(s => s.shippingCostType === 'FREE') ? 3 : 0);

      // Compute listing age in days from listingDate
      let listingAgeDays = null;
      if (v.listingDate) {
        const ms = Date.now() - new Date(v.listingDate).getTime();
        listingAgeDays = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
      }

      verified.push({
        id:             item.itemId,
        title:          item.title,
        price:          item.price?.value ? parseFloat(item.price.value) : null,
        currency:       item.price?.currency || 'USD',
        condition:      v.condition || item.condition || null,
        watchCount,
        soldCount,
        availableQty:   v.availableQty ?? null,
        listingAgeDays,                           // days since listing was created
        listingDate:    v.listingDate || null,
        endDate:        v.endDate || item.itemEndDate || null,
        listingType:    v.listingType || item.buyingOptions?.[0] || null,
        isAuction:      (v.listingType || item.buyingOptions?.[0]) === 'AUCTION',
        demandScore,
        imageUrl:       item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
        itemWebUrl:     item.itemWebUrl,
        seller:         item.seller?.username || null,
        sellerFeedback: item.seller?.feedbackPercentage
                          ? parseFloat(item.seller.feedbackPercentage) : null,
        shippingCost:   item.shippingOptions?.[0]?.shippingCost?.value != null
                          ? parseFloat(item.shippingOptions[0].shippingCost.value) : null,
        freeShipping:   item.shippingOptions?.some(s => s.shippingCostType === 'FREE') || false,
        topRated:       item.topRatedBuyingExperience || false,
        verified:       v.verified !== false,
      });
    }
  }

  if (sortBy === 'bestMatch') {
    verified.sort((a, b) => b.demandScore - a.demandScore);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      total:    searchData.total || rawItems.length,
      returned: verified.length,
      filtered: skipped.length,
      category,
      keywords: keywords.trim() || 'motorcycle parts',
      items:    verified,
    }),
  };
};

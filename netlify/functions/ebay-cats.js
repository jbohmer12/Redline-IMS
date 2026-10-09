// ebay-cats.js — debug: get category suggestions from eBay Taxonomy API
// Usage: /.netlify/functions/ebay-cats?q=motorcycle+rear+fender+assembly
// Shows top suggestions from tree 100 (eBay Motors) — same tree used by ebay-list.js

const { getValidToken } = require('../lib/ebay-refresh');

const { requireUser } = require('../lib/auth');
exports.handler = async (event) => {
  // Signed-in users only (admins); see netlify/lib/auth.js
  const auth = await requireUser(event, { role: 'admin' });
  if (auth.error) return auth.error;

  const q = event.queryStringParameters?.q || 'motorcycle parts';
  let token;
  try { token = await getValidToken(); } catch(e) {
    return { statusCode: 500, body: e.message };
  }

  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

  // Fetch from tree 100 (eBay Motors) — must match EBAY_MOTORS marketplace used in ebay-list.js
  const res = await fetch(
    `https://api.ebay.com/commerce/taxonomy/v1/category_tree/100/get_category_suggestions?q=${encodeURIComponent(q)}`,
    { headers: authHeaders }
  );
  const data = await res.json();
  const suggestions = (data.categorySuggestions || []).slice(0, 10).map(s => ({
    id: s.category?.categoryId,
    name: s.category?.categoryName,
    path: s.categoryTreeNodeAncestors?.map(a => a.categoryName).reverse().join(' > ')
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: q,
      tree: '100 (eBay Motors — matches EBAY_MOTORS marketplace)',
      note: 'Top result [0] is what ebay-list.js will use when no categoryId is supplied',
      suggestions
    }, null, 2)
  };
};

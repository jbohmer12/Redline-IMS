// ebay-token.js — redirects to eBay login with tokenGen flag in state
// The callback (ebay-callback.js) detects this and shows tokens instead of redirecting to app

exports.handler = async (event) => {
  const clientId = process.env.EBAY_PROD_CLIENT_ID;
  const ruName   = process.env.EBAY_PROD_RUNAME;

  if (!clientId || !ruName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing EBAY_PROD_CLIENT_ID or EBAY_PROD_RUNAME env vars' })
    };
  }

  const SCOPES = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  ].join(' ');

  // Include tokenGen=true in state so callback knows to show tokens
  const state = Buffer.from(JSON.stringify({ env: 'production', tokenGen: true, ts: Date.now() })).toString('base64');

  const authUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(ruName)}&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

  return { statusCode: 302, headers: { Location: authUrl }, body: '' };
};

// ebay-auth.js — starts the eBay OAuth 2.0 flow

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');

exports.handler = async (event) => {
  const env = event.queryStringParameters?.env || 'sandbox';
  const isSandbox = env !== 'production';

  const clientId = isSandbox
    ? process.env.EBAY_SANDBOX_CLIENT_ID
    : process.env.EBAY_PROD_CLIENT_ID;

  // eBay requires the RuName as redirect_uri, not the actual callback URL
  const ruName = isSandbox
    ? process.env.EBAY_SANDBOX_RUNAME
    : process.env.EBAY_PROD_RUNAME;

  if (!clientId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Missing env var: ${isSandbox ? 'EBAY_SANDBOX_CLIENT_ID' : 'EBAY_PROD_CLIENT_ID'}` })
    };
  }

  if (!ruName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Missing env var: ${isSandbox ? 'EBAY_SANDBOX_RUNAME' : 'EBAY_PROD_RUNAME'}` })
    };
  }

  const authBase = isSandbox
    ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
    : 'https://auth.ebay.com/oauth2/authorize';

  const state = Buffer.from(JSON.stringify({ env, ts: Date.now() })).toString('base64');

  const authUrl = `${authBase}?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(ruName)}&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: ''
  };
};

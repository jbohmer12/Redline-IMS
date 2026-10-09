// ebay-refresh.js — always gets a fresh token using the refresh token

exports.getValidToken = async () => {
  const refreshToken  = process.env.EBAY_REFRESH_TOKEN;
  const clientId      = process.env.EBAY_PROD_CLIENT_ID;
  const clientSecret  = process.env.EBAY_PROD_CLIENT_SECRET;
  const ruName        = process.env.EBAY_PROD_RUNAME;

  if (!refreshToken) throw new Error('EBAY_REFRESH_TOKEN not set in Netlify environment variables');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      redirect_uri:  ruName
    }).toString()
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Token refresh failed: ' + (data.error_description || JSON.stringify(data)));
  }

  return data.access_token;
};

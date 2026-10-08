// ebay-callback.js — handles OAuth redirect for both app auth and token generation

exports.handler = async (event) => {
  const { code, state, error, error_description } = event.queryStringParameters || {};

  if (error) {
    return redirect(`/?ebay_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return redirect('/?ebay_error=No+authorization+code+received');
  }

  // Decode state
  let env = 'production';
  let isTokenGen = false;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    env = decoded.env || 'production';
    isTokenGen = decoded.tokenGen === true;
  } catch (e) {}

  const isSandbox = env !== 'production';
  const clientId     = isSandbox ? process.env.EBAY_SANDBOX_CLIENT_ID     : process.env.EBAY_PROD_CLIENT_ID;
  const clientSecret = isSandbox ? process.env.EBAY_SANDBOX_CLIENT_SECRET  : process.env.EBAY_PROD_CLIENT_SECRET;
  const ruName       = isSandbox ? process.env.EBAY_SANDBOX_RUNAME         : process.env.EBAY_PROD_RUNAME;
  const siteUrl      = process.env.URL || 'https://ridersinventory.netlify.app';

  if (!clientId || !clientSecret) {
    return redirect(`/?ebay_error=Missing+eBay+credentials`);
  }

  const tokenUrl = isSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: ruName
      }).toString()
    });

    const data = await res.json();

    if (!res.ok || !data.access_token) {
      return redirect(`/?ebay_error=${encodeURIComponent(data.error_description || 'Token exchange failed')}`);
    }

    // Token generation mode — show tokens on screen
    if (isTokenGen) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `<html><body style="font-family:sans-serif;padding:20px;background:#111;color:#fff;max-width:700px;margin:0 auto;">
          <h2>✓ eBay Tokens Generated</h2>
          <p style="color:#aaa">Add these to <a href="https://app.netlify.com" target="_blank" style="color:#e53238;">Netlify → Environment Variables</a> then redeploy:</p>
          <hr style="border-color:#333">
          <p><strong>EBAY_ACCESS_TOKEN</strong></p>
          <textarea style="width:100%;height:80px;font-size:11px;background:#000;color:#0f0;border:1px solid #333;padding:8px;box-sizing:border-box;">${data.access_token}</textarea>
          <p><strong>EBAY_REFRESH_TOKEN</strong></p>
          <textarea style="width:100%;height:80px;font-size:11px;background:#000;color:#0f0;border:1px solid #333;padding:8px;box-sizing:border-box;">${data.refresh_token}</textarea>
          <p style="color:#888;font-size:13px;">Access token expires in ${Math.round(data.expires_in/3600)}h · Refresh token lasts ~18 months</p>
          <p style="color:#888;font-size:13px;">After adding to Netlify, change the eBay auth accepted URL back to:<br>
          <code style="color:#0f0;">${siteUrl}/.netlify/functions/ebay-callback</code></p>
        </body></html>`
      };
    }

    // Normal app auth mode — pass token back to app
    const tokenPayload = encodeURIComponent(JSON.stringify({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
      env
    }));

    return redirect(`/?ebay_token=${tokenPayload}`);

  } catch (err) {
    return redirect(`/?ebay_error=${encodeURIComponent(err.message)}`);
  }
};

function redirect(path) {
  return { statusCode: 302, headers: { Location: path }, body: '' };
}

// netlify/lib/auth.js — shared sign-in check for Netlify functions.
//
// The browser sends the signed-in user's Supabase access token as
// `Authorization: Bearer <token>`. We ask Supabase who that is (GET /auth/v1/user)
// and read the role from app_metadata, which only the service role / SQL can change.
//
// Required Netlify env vars: SUPABASE_URL, SUPABASE_ANON_KEY (the public anon key).

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Returns { user, role } on success, or { error: <Netlify response> } to return as-is.
// Pass { role: 'admin' } to require an admin.
async function requireUser(event, { role } = {}) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return { error: json(500, { error: 'Server sign-in check is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).' }) };
  }

  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { error: json(401, { error: 'Sign in required.' }) };

  let user;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { error: json(401, { error: 'Your session expired. Sign in again.' }) };
    user = await res.json();
  } catch (e) {
    return { error: json(503, { error: 'Could not verify your sign-in. Try again.' }) };
  }

  const userRole = user?.app_metadata?.role === 'admin' ? 'admin' : 'logger';
  if (role === 'admin' && userRole !== 'admin') {
    return { error: json(403, { error: 'Only admins can do that.' }) };
  }
  return { user, role: userRole };
}

module.exports = { requireUser, json };

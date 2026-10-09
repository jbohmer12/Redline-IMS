// ai-lookup.js
// Server-side proxy for Anthropic API — keeps the key out of the browser
// POST /.netlify/functions/ai-lookup
// Body (pick one mode):
//   { mode: "lookup",  oem: "part-number[, part-number…]", isAssembly: bool }   (default mode)
//   { mode: "search",  query: "what the user typed", inventory: "id|name|…\n…" }
//   { mode: "listing", part: { name, make, model, year, category, condition, oemnum, notes } }

const { requireUser } = require('../lib/auth');

const MODEL = 'claude-sonnet-4-6';
const CATEGORIES = 'Engine, Suspension, Brakes, Electrical, Body/Fairings, Exhaust, Drivetrain, Frame/Chassis, Accessories, Other';

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const clip = (v, n) => String(v ?? '').slice(0, n);

function buildPrompt(body) {
  const mode = body.mode || 'lookup';

  if (mode === 'lookup') {
    const oem = clip(body.oem, 200).trim();
    if (!oem) return { error: 'Missing oem field' };
    const assembly = body.isAssembly === true;
    return { mode, maxTokens: 700, prompt: `You are a motorcycle parts expert. ${assembly
        ? `These OEM part numbers form one motorcycle assembly: "${oem}". Identify the assembly.`
        : `Identify the motorcycle OEM part number "${oem}".`}

Return ONLY a JSON object (no markdown, no explanation) with these fields:
{
  "name": "Full descriptive part name",
  "make": "Manufacturer (e.g. Honda, Yamaha, Kawasaki, Suzuki, Ducati, BMW, KTM)",
  "model": "Specific model(s) this fits",
  "year": "Year range (e.g. 2019-2022)",
  "category": "One of: ${CATEGORIES}",
  "notes": "Brief technical description${assembly ? ', including which components the assembly contains' : ''}",
  "price_usd": "Typical current used-market price in USD as a number, or 0 if you don't know",
  "confidence": "high, medium, or low"
}

If you cannot identify the part, return: {"error": "Part not found"}` };
  }

  if (mode === 'search') {
    const query = clip(body.query, 300).trim();
    const inventory = clip(body.inventory, 60000);
    if (!query || !inventory) return { error: 'Missing query or inventory' };
    return { mode, maxTokens: 1000, prompt: `Inventory, one part per line (id|name|category|condition|make|model|year|location|oem):
${inventory}

Search request: "${query}"

Return ONLY a JSON object: {"ids": ["PART-ABC123", ...]} listing the ids of every part that matches the request. Use an empty array if none match.` };
  }

  if (mode === 'listing') {
    const p = body.part || {};
    const part = {};
    for (const k of ['name', 'make', 'model', 'year', 'category', 'condition', 'oemnum', 'notes']) part[k] = clip(p[k], 500);
    if (!part.name) return { error: 'Missing part name' };
    return { mode, maxTokens: 1200, prompt: `Write an eBay listing for this motorcycle part. Return ONLY a JSON object, no markdown:
{
  "title": "max 80 chars, keyword-rich eBay title",
  "description": "plain text description for eBay, no HTML tags — 2-4 short paragraphs covering what it is, compatibility, condition, and what's included",
  "categoryId": "the most specific eBay leaf category ID for this part type. Examples: Exhaust Systems=35615, Handlebars/Grips/Levers=50454, Air Intake/Fuel Delivery=33742, Brakes=33566, Engines/Engine Parts=6684, Electrical/Ignition=26562, Body/Frame=46092, Suspension=66803, Wheels/Tires=66830, General Motorcycle Parts=66471",
  "conditionDescription": "1-2 sentence condition note"
}

Only describe what the part data supports; don't invent fitment or condition details.

Part data: ${JSON.stringify(part)}` };
  }

  return { error: 'Unknown mode' };
}

exports.handler = async (event) => {
  // Signed-in users only; see netlify/lib/auth.js
  const auth = await requireUser(event, {});
  if (auth.error) return auth.error;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'API key not configured on server' });

  let body;
  try { body = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const built = buildPrompt(body || {});
  if (built.error) return json(400, { error: built.error });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Only needed for API keys that aren't scoped to a workspace.
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: built.maxTokens,
        messages: [{ role: 'user', content: built.prompt }],
      }),
    });

    if (!res.ok) {
      console.error('Anthropic API error', res.status, await res.text());
      const busy = res.status === 429 || res.status === 529;
      return json(busy ? 429 : 502, { error: busy ? 'RATE_LIMIT' : 'AI service error' });
    }

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return json(502, { error: 'Could not parse response' });

    let result;
    try { result = JSON.parse(jsonMatch[0]); }
    catch { return json(502, { error: 'Could not parse response' }); }

    if (built.mode === 'lookup' && result.price_usd !== undefined) {
      result.price_usd = Number(result.price_usd) || 0;
    }
    return json(200, result);

  } catch (err) {
    console.error('ai-lookup error:', err);
    return json(500, { error: 'AI lookup failed' });
  }
};

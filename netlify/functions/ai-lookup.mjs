// ai-lookup.mjs
// Server-side proxy for Anthropic API (via Netlify AI Gateway) — keeps the key out of the browser
// POST /.netlify/functions/ai-lookup
// Body: { oem: "part-number", existingParts: [...] }

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  if (!apiKey) {
    return json({ error: 'API key not configured on server' }, 500);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { oem, existingParts = [] } = body || {};
  if (!oem) {
    return json({ error: 'Missing oem field' }, 400);
  }

  const prompt = `You are a motorcycle parts expert. Given this OEM/part number: "${oem}"

Identify the part and return ONLY a JSON object (no markdown, no explanation) with these fields:
{
  "name": "Full descriptive part name",
  "make": "Manufacturer (e.g. Honda, Yamaha, Kawasaki, Suzuki, Ducati, BMW, KTM)",
  "model": "Specific model(s) this fits",
  "year": "Year range (e.g. 2019-2022)",
  "category": "One of: Engine, Suspension, Brakes, Electrical, Body/Fairings, Exhaust, Drivetrain, Frame/Chassis, Accessories, Other",
  "notes": "Brief technical description of the part and its function"
}

If you cannot identify the part with confidence, return: {"error": "Part not found"}`;

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return json({ error: 'Anthropic API error', detail: err }, res.status);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ error: 'Could not parse response' });
    }

    return json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

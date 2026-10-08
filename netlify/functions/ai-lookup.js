// ai-lookup.js
// Server-side proxy for Anthropic API — keeps the key out of the browser
// POST /.netlify/functions/ai-lookup
// Body: { oem: "part-number", existingParts: [...] }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API key not configured on server' })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { oem, existingParts = [] } = body;
  if (!oem) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing oem field' }) };
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      return { statusCode: res.status, body: JSON.stringify({ error: 'Anthropic API error', detail: err }) };
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { statusCode: 200, body: JSON.stringify({ error: 'Could not parse response' }) };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

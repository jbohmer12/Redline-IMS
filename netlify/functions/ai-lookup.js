// ai-lookup.js v3
// Server-side proxy for Anthropic API with web search tool
// Looks up real-time part data instead of relying on training data alone

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

  const { oem, isAssembly } = body;
  if (!oem) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing oem field' }) };
  }

  const prompt = `Search for the motorcycle OEM part number: "${oem}"

Use web search to find the exact part. Look for:
1. What part this number refers to (exact name)
2. Which motorcycle make, model, and year it fits
3. Current market price (retail or used dealer price in USD)

Then return ONLY a JSON object with no markdown or explanation:
{
  "name": "Exact part name from manufacturer",
  "make": "Manufacturer brand (Honda, Yamaha, Ducati, etc.)",
  "model": "Specific model(s) this fits",
  "year": "Year range (e.g. 2019-2022)",
  "category": "One of: Engine, Suspension, Brakes, Electrical, Body/Fairings, Exhaust, Drivetrain, Frame/Chassis, Accessories, Other",
  "price_usd": 0,
  "notes": "Brief description of what this part is and what it does",
  "confidence": "high"
}

For price_usd: use the actual retail or used market price you find. If the part is used/aftermarket, estimate 40-60% of retail. If you find no price, use 0.
Set confidence to "high" if web search confirmed the part, "medium" if partially confirmed, "low" if guessing.
If you truly cannot find any information, return: {"error": "Part not found"}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          }
        ],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: 'Anthropic API error', detail: err })
      };
    }

    const data = await res.json();

    // Extract text from response — may be after tool use blocks
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.text).join('');

    if (!text) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: 'No response from AI' })
      };
    }

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: 'Could not parse response' })
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};

// Use Edge Runtime — runs on Cloudflare's global network, much better connectivity
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-hf-token',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const buffer = await req.arrayBuffer();

    // Get token from headers, fallback to environment variable
    const hfToken = req.headers.get('x-hf-token') || process.env.HF_TOKEN || '';

    // Try multiple endpoints
    const API_URLS = [
      'https://router.huggingface.co/hf-inference/models/umm-maybe/AI-image-detector',
      'https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector',
    ];

    let lastError = null;

    for (const API_URL of API_URLS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 28000);

        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfToken}`,
            'Content-Type': 'application/octet-stream',
          },
          body: buffer,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 503) {
          const txt = await response.text();
          return new Response(
            JSON.stringify({ error: 'Model is loading. Please wait 20 seconds and try again.' }),
            { status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
          );
        }

        if (!response.ok) {
          lastError = `HTTP ${response.status}: ${await response.text()}`;
          continue;
        }

        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });

      } catch (fetchErr) {
        lastError = fetchErr.message || String(fetchErr);
        continue;
      }
    }

    return new Response(
      JSON.stringify({ error: `All API endpoints failed. Last error: ${lastError}` }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || 'Internal Server Error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}

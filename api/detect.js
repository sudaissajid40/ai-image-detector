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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const buffer = await req.arrayBuffer();

    // Get token: prefer header sent by browser, then fall back to server env var
    const headerToken = req.headers.get('x-hf-token') || '';
    const envToken = process.env.HF_TOKEN || '';
    const hfToken = headerToken || envToken;

    if (!hfToken) {
      return new Response(
        JSON.stringify({ error: 'No Hugging Face token configured. Please open Settings (gear icon) and enter your HF_TOKEN.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    const API_URL = 'https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28000);

    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hfToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      return new Response(
        JSON.stringify({ error: `Network error contacting Hugging Face: ${fetchErr.message}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired Hugging Face token. Please update your token in Settings.' }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    if (response.status === 503) {
      const body = await response.text();
      let waitTime = 20;
      try {
        const parsed = JSON.parse(body);
        if (parsed.estimated_time) waitTime = Math.ceil(parsed.estimated_time);
      } catch (e) { /* ignore */ }
      return new Response(
        JSON.stringify({ error: `Model is loading on Hugging Face. Please wait ${waitTime} seconds and try again.` }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    if (!response.ok) {
      const body = await response.text();
      return new Response(
        JSON.stringify({ error: `Hugging Face API error (${response.status}): ${body}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

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

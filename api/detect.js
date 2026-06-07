// Edge Runtime runs on Cloudflare's global network — can reach api-inference.huggingface.co
export const config = {
  runtime: 'edge',
};

async function queryModel(modelId, token, buffer) {
  try {
    const response = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
        signal: AbortSignal.timeout(25000),
      }
    );

    if (response.status === 503) {
      let est = 20;
      try {
        const body = await response.json();
        if (body.estimated_time) est = Math.ceil(body.estimated_time);
      } catch (_) {}
      return { status: 503, wait: est };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: response.status, error: 'Invalid or expired Hugging Face token. Update it in Settings (⚙️).' };
    }

    if (!response.ok) {
      const text = await response.text();
      return { status: response.status, error: text.slice(0, 200) };
    }

    const data = await response.json();
    return { status: 200, data };

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { status: 504, error: 'Request timed out' };
    }
    return { status: 500, error: err.message || String(err) };
  }
}

function extractAIScore(data, isSDXL = false) {
  if (!data || !Array.isArray(data)) return 0.5;
  const fake = data.find(i =>
    i.label.toLowerCase().includes('artificial') ||
    i.label.toLowerCase().includes('fake') ||
    (isSDXL && (i.label.toLowerCase().includes('sdxl') || i.label.toLowerCase().includes('generated')))
  );
  if (fake) return fake.score;
  const real = data.find(i => i.label.toLowerCase().includes('human') || i.label.toLowerCase().includes('real'));
  return real ? 1 - real.score : 0.5;
}

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-hf-token',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const buffer = await req.arrayBuffer();
    const hfToken = (req.headers.get('x-hf-token') || process.env.HF_TOKEN || '').trim();

    if (!hfToken) {
      return new Response(
        JSON.stringify({ error: 'No Hugging Face token. Open Settings (⚙️) and enter your HF token.' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Query both models in parallel using Edge fetch (Cloudflare network)
    const [m1, m2] = await Promise.all([
      queryModel('umm-maybe/AI-image-detector', hfToken, buffer),
      queryModel('Organika/sdxl-detector', hfToken, buffer),
    ]);

    if (m1.status === 503 || m2.status === 503) {
      const wait = Math.max(m1.wait || 0, m2.wait || 0);
      return new Response(
        JSON.stringify({ error: `Models loading. Wait ${wait}s and retry.` }),
        { status: 503, headers: corsHeaders }
      );
    }

    if (m1.status === 401 || m2.status === 401) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired Hugging Face token. Update in Settings (⚙️).' }),
        { status: 401, headers: corsHeaders }
      );
    }

    const d1 = m1.status === 200 ? m1.data : null;
    const d2 = m2.status === 200 ? m2.data : null;

    if (!d1 && !d2) {
      return new Response(
        JSON.stringify({
          error: `Inference failed. M1(${m1.status}): ${m1.error || '?'} | M2(${m2.status}): ${m2.error || '?'}`,
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const s1 = extractAIScore(d1, false);
    const s2 = extractAIScore(d2, true);
    const final = (d1 && d2) ? (s1 + s2) / 2 : (d1 ? s1 : s2);

    return new Response(
      JSON.stringify([
        { label: 'artificial', score: final },
        { label: 'human', score: 1 - final },
      ]),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: corsHeaders }
    );
  }
}

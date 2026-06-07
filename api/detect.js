// Standard Node.js runtime (more compatible than Edge for external API calls)
export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-hf-token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Get token from header or env var
    const hfToken = req.headers['x-hf-token'] || process.env.HF_TOKEN || '';

    if (!hfToken) {
      return res.status(401).json({
        error: 'No Hugging Face token configured. Open Settings (⚙️) and enter your HF token.',
      });
    }

    // Try the model with a 25-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    let hfRes;
    try {
      hfRes = await fetch(
        'https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': 'application/octet-stream',
          },
          body: buffer,
          signal: controller.signal,
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      return res.status(502).json({
        error: `Could not reach Hugging Face API: ${fetchErr.message}`,
      });
    }

    clearTimeout(timeoutId);

    const bodyText = await hfRes.text();

    if (hfRes.status === 401 || hfRes.status === 403) {
      return res.status(401).json({
        error: 'Invalid or expired Hugging Face token. Please update it in Settings (⚙️).',
      });
    }

    if (hfRes.status === 503) {
      let waitSecs = 20;
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed.estimated_time) waitSecs = Math.ceil(parsed.estimated_time);
      } catch (_) {}
      return res.status(503).json({
        error: `Model is loading. Please wait ${waitSecs} seconds and try again.`,
      });
    }

    if (!hfRes.ok) {
      return res.status(502).json({
        error: `Hugging Face returned ${hfRes.status}: ${bodyText.slice(0, 200)}`,
      });
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (_) {
      return res.status(502).json({ error: `Invalid JSON from Hugging Face: ${bodyText.slice(0, 200)}` });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[detect] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

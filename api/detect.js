import https from 'https';

export const config = {
  maxDuration: 30,
};

// Resolve hostname using Cloudflare's DNS-over-HTTPS (HTTP request, not UDP port 53)
// This works from inside Vercel's sandboxed serverless environment
async function resolveViaDoH(hostname) {
  const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
  
  try {
    const response = await fetch(dohUrl, {
      headers: { 'Accept': 'application/dns-json' },
    });
    const data = await response.json();
    
    // Find first A record
    const aRecord = data.Answer?.find(r => r.type === 1);
    if (aRecord?.data) return aRecord.data;
    
    // Try CNAME chain — resolve the CNAME target
    const cnameRecord = data.Answer?.find(r => r.type === 5);
    if (cnameRecord?.data) {
      return resolveViaDoH(cnameRecord.data.replace(/\.$/, ''));
    }
    
    throw new Error(`No A record found for ${hostname}`);
  } catch (err) {
    throw new Error(`DoH resolution failed: ${err.message}`);
  }
}

// Query a single Hugging Face model
async function queryModel(modelId, token, buffer) {
  let ip;
  try {
    ip = await resolveViaDoH('api-inference.huggingface.co');
  } catch (dnsErr) {
    return { status: 500, error: `DNS (DoH) failed: ${dnsErr.message}` };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: ip,
      port: 443,
      path: `/models/${modelId}`,
      method: 'POST',
      headers: {
        'Host': 'api-inference.huggingface.co',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
      },
      timeout: 25000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 503) {
          let est = 20;
          try { const p = JSON.parse(body); if (p.estimated_time) est = Math.ceil(p.estimated_time); } catch (_) {}
          resolve({ status: 503, wait: est });
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ status: res.statusCode, error: 'Invalid or expired Hugging Face token.' });
        } else if (res.statusCode !== 200) {
          resolve({ status: res.statusCode, error: body.slice(0, 200) });
        } else {
          try { resolve({ status: 200, data: JSON.parse(body) }); }
          catch (_) { resolve({ status: 500, error: 'Invalid JSON from model' }); }
        }
      });
    });

    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, error: 'Timeout' }); });
    req.write(buffer);
    req.end();
  });
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-hf-token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const hfToken = (req.headers['x-hf-token'] || process.env.HF_TOKEN || '').trim();
    if (!hfToken) {
      return res.status(401).json({
        error: 'No Hugging Face token. Open Settings (⚙️) and enter your HF token.',
      });
    }

    // Query both models in parallel
    const [m1, m2] = await Promise.all([
      queryModel('umm-maybe/AI-image-detector', hfToken, buffer),
      queryModel('Organika/sdxl-detector', hfToken, buffer),
    ]);

    if (m1.status === 503 || m2.status === 503) {
      const wait = Math.max(m1.wait || 0, m2.wait || 0);
      return res.status(503).json({ error: `Models loading. Wait ${wait}s and retry.` });
    }

    const d1 = m1.status === 200 ? m1.data : null;
    const d2 = m2.status === 200 ? m2.data : null;

    if (!d1 && !d2) {
      return res.status(502).json({
        error: `Inference failed. M1(${m1.status}): ${m1.error || '?'} | M2(${m2.status}): ${m2.error || '?'}`,
      });
    }

    const s1 = extractAIScore(d1, false);
    const s2 = extractAIScore(d2, true);
    const final = (d1 && d2) ? (s1 + s2) / 2 : (d1 ? s1 : s2);

    return res.status(200).json([
      { label: 'artificial', score: final },
      { label: 'human', score: 1 - final },
    ]);

  } catch (err) {
    console.error('[detect]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

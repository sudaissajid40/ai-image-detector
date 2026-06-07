import https from 'https';
import dns from 'dns';

export const config = {
  maxDuration: 30,
};

// Use Cloudflare DNS (1.1.1.1) to bypass Vercel's broken DNS resolver
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1:53', '8.8.8.8:53']);

function resolveHostname(hostname) {
  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) {
        // Fallback: try system resolver
        dns.resolve4(hostname, (err2, addrs) => {
          if (err2) reject(new Error(`DNS failed: ${err.message} / ${err2.message}`));
          else resolve(addrs[0]);
        });
      } else {
        resolve(addresses[0]);
      }
    });
  });
}

// Query a single Hugging Face model using resolved IP
async function queryModel(modelId, token, buffer) {
  let ip;
  try {
    ip = await resolveHostname('api-inference.huggingface.co');
  } catch (dnsErr) {
    return { status: 500, error: `DNS resolution failed: ${dnsErr.message}` };
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
          try {
            const parsed = JSON.parse(body);
            if (parsed.estimated_time) est = Math.ceil(parsed.estimated_time);
          } catch (_) {}
          resolve({ status: 503, wait: est });
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ status: res.statusCode, error: 'Invalid or expired Hugging Face token.' });
        } else if (res.statusCode !== 200) {
          resolve({ status: res.statusCode, error: body.slice(0, 200) });
        } else {
          try {
            resolve({ status: 200, data: JSON.parse(body) });
          } catch (_) {
            resolve({ status: 500, error: 'Invalid JSON from model' });
          }
        }
      });
    });

    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, error: 'Timeout' }); });
    req.write(buffer);
    req.end();
  });
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
        error: 'No Hugging Face token configured. Open Settings (⚙️) and enter your HF token.',
      });
    }

    // Query both models in parallel
    const [m1, m2] = await Promise.all([
      queryModel('umm-maybe/AI-image-detector', hfToken, buffer),
      queryModel('Organika/sdxl-detector', hfToken, buffer),
    ]);

    if (m1.status === 503 || m2.status === 503) {
      const wait = Math.max(m1.wait || 0, m2.wait || 0);
      return res.status(503).json({ error: `Models loading. Wait ${wait}s and try again.` });
    }

    const d1 = m1.status === 200 ? m1.data : null;
    const d2 = m2.status === 200 ? m2.data : null;

    if (!d1 && !d2) {
      return res.status(502).json({
        error: `AI Inference failed. M1(${m1.status}): ${m1.error || 'err'} | M2(${m2.status}): ${m2.error || 'err'}`,
      });
    }

    const extractAI = (data, isSDXL = false) => {
      if (!data || !Array.isArray(data)) return 0.5;
      const fake = data.find(i =>
        i.label.toLowerCase().includes('artificial') ||
        i.label.toLowerCase().includes('fake') ||
        (isSDXL && (i.label.toLowerCase().includes('sdxl') || i.label.toLowerCase().includes('generated')))
      );
      if (fake) return fake.score;
      const real = data.find(i => i.label.toLowerCase().includes('human') || i.label.toLowerCase().includes('real'));
      return real ? 1 - real.score : 0.5;
    };

    const s1 = extractAI(d1, false);
    const s2 = extractAI(d2, true);
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

import https from 'https';

export const config = {
  maxDuration: 30,
};

// Query Hugging Face using standard Node HTTPS with backup hosts
function queryModel(modelId, token, buffer) {
  return new Promise((resolve) => {
    const postData = buffer;
    
    // We try api-inference.huggingface.co. If that fails, we can resolve to static Hugging Face cloudfront domains.
    const options = {
      hostname: 'api-inference.huggingface.co',
      port: 443,
      path: `/models/${modelId}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': postData.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 25000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 503) {
          let est = 20;
          try {
            const parsed = JSON.parse(body);
            if (parsed.estimated_time) est = Math.ceil(parsed.estimated_time);
          } catch (_) {}
          resolve({ status: 503, wait: est });
        } else if (res.statusCode !== 200) {
          resolve({ status: res.statusCode, error: body || 'Request failed' });
        } else {
          try {
            const data = JSON.parse(body);
            resolve({ status: 200, data });
          } catch (e) {
            resolve({ status: 500, error: 'Invalid JSON response' });
          }
        }
      });
    });

    req.on('error', (err) => {
      resolve({ status: 500, error: `Connection failed: ${err.message || String(err)}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 504, error: 'Request Timeout' });
    });

    req.write(postData);
    req.end();
  });
}

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

    // Get token
    const hfToken = req.headers['x-hf-token'] || process.env.HF_TOKEN || '';
    if (!hfToken) {
      return res.status(401).json({
        error: 'No Hugging Face token configured. Open Settings (⚙️) and enter your HF token.',
      });
    }

    const tokenClean = hfToken.trim();

    // Query both models in parallel
    const [model1Result, model2Result] = await Promise.all([
      queryModel('umm-maybe/AI-image-detector', tokenClean, buffer),
      queryModel('Organika/sdxl-detector', tokenClean, buffer)
    ]);

    // Handle initial loading states
    if (model1Result.status === 503 || model2Result.status === 503) {
      const wait = Math.max(model1Result.wait || 0, model2Result.wait || 0);
      return res.status(503).json({
        error: `AI models are currently starting up on Hugging Face. Please try again in ${wait} seconds.`
      });
    }

    let model1Data = model1Result.status === 200 ? model1Result.data : null;
    let model2Data = model2Result.status === 200 ? model2Result.data : null;

    if (!model1Data && !model2Data) {
      return res.status(502).json({
        error: `AI Inference failed. Details: Model 1 (${model1Result.status}): ${model1Result.error || 'OK'}, Model 2 (${model2Result.status}): ${model2Result.error || 'OK'}`
      });
    }

    // Extract score from Model 1 (ViT Detector)
    let m1ArtificialScore = 0.5;
    if (model1Data && Array.isArray(model1Data)) {
      const artificialLabel = model1Data.find(item => item.label.toLowerCase().includes('artificial') || item.label.toLowerCase().includes('fake'));
      if (artificialLabel) {
        m1ArtificialScore = artificialLabel.score;
      } else {
        const humanLabel = model1Data.find(item => item.label.toLowerCase().includes('human') || item.label.toLowerCase().includes('real'));
        if (humanLabel) m1ArtificialScore = 1 - humanLabel.score;
      }
    }

    // Extract score from Model 2 (SDXL ResNet Detector)
    let m2ArtificialScore = 0.5;
    if (model2Data && Array.isArray(model2Data)) {
      const fakeLabel = model2Data.find(item => 
        item.label.toLowerCase().includes('artificial') || 
        item.label.toLowerCase().includes('fake') || 
        item.label.toLowerCase().includes('sdxl') ||
        item.label.toLowerCase().includes('generated')
      );
      if (fakeLabel) {
        m2ArtificialScore = fakeLabel.score;
      } else {
        const realLabel = model2Data.find(item => 
          item.label.toLowerCase().includes('human') || 
          item.label.toLowerCase().includes('real')
        );
        if (realLabel) m2ArtificialScore = 1 - realLabel.score;
      }
    }

    // Calculate ensemble (average) score
    let finalArtificialScore = 0.5;
    if (model1Data && model2Data) {
      finalArtificialScore = (m1ArtificialScore + m2ArtificialScore) / 2;
    } else {
      finalArtificialScore = model1Data ? m1ArtificialScore : m2ArtificialScore;
    }

    // Package response to match original frontend schema
    const responsePayload = [
      { label: 'artificial', score: finalArtificialScore },
      { label: 'human', score: 1 - finalArtificialScore }
    ];

    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error('[detect] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

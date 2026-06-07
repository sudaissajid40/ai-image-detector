// Standard Node.js runtime
export const config = {
  maxDuration: 30,
};

// Query a single Hugging Face model
async function queryModel(modelId, token, buffer) {
  const url = `https://api-inference.huggingface.co/models/${modelId}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 503) {
      const text = await response.text();
      let est = 20;
      try {
        const parsed = JSON.parse(text);
        if (parsed.estimated_time) est = Math.ceil(parsed.estimated_time);
      } catch (_) {}
      return { status: 503, wait: est };
    }

    if (!response.ok) {
      return { status: response.status, error: await response.text().catch(() => 'Unknown error') };
    }

    const data = await response.json();
    return { status: 200, data };

  } catch (err) {
    clearTimeout(timeoutId);
    return { status: 500, error: err.message || String(err) };
  }
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

    // Fall back to whichever model succeeded if one failed
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
      // SDXL detector uses labels like "artificial" or "fake" and "human" or "real" or "sdxl"
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
      // Average both inputs for robust analysis
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

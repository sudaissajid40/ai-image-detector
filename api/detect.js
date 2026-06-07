import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get Auth JWT from headers
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in to analyze images.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verify user JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired user session.' });
    }

    // Get user limits
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User profile not found. Please sign out and sign back in.' });
    }

    // Check daily limits (start of today UTC)
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const { count: dailyUsage } = await supabase
      .from('usage_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', startOfToday.toISOString());

    if ((dailyUsage || 0) >= profile.daily_limit) {
      return res.status(429).json({ error: `Daily limit reached (${profile.daily_limit} scans). Try again tomorrow.` });
    }

    // Check monthly limits (start of month UTC)
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const { count: monthlyUsage } = await supabase
      .from('usage_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', startOfMonth.toISOString());

    if ((monthlyUsage || 0) >= profile.monthly_limit) {
      return res.status(429).json({ error: `Monthly limit reached (${profile.monthly_limit} scans).` });
    }

    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Get token exclusively from server-side environment variable (never exposed to users)
    const hfToken = process.env.HF_TOKEN || '';

    if (!hfToken) {
      return res.status(500).json({
        error: 'Server configuration error: HF_TOKEN environment variable is not set.',
      });
    }

    // Try multiple API URLs for resilience (both standard and modern Hugging Face routers)
    const API_URLS = [
      'https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector',
      'https://router.huggingface.co/hf-inference/models/umm-maybe/AI-image-detector'
    ];

    let lastError = null;
    let hfRes = null;

    for (const apiEntry of API_URLS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      try {
        hfRes = await fetch(apiEntry, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hfToken.trim()}`,
            'Content-Type': 'application/octet-stream',
          },
          body: buffer,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        if (hfRes.ok || hfRes.status === 503 || hfRes.status === 401 || hfRes.status === 403) {
          break; // Stop trying URLs if we got a definitive model or auth response
        }
        lastError = `Status ${hfRes.status}: ${await hfRes.text().catch(() => '')}`;
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        lastError = fetchErr.message || String(fetchErr);
      }
    }

    if (!hfRes) {
      return res.status(502).json({
        error: `Could not reach Hugging Face API. Last connection error: ${lastError}`,
      });
    }

    const bodyText = await hfRes.text();

    if (hfRes.status === 401 || hfRes.status === 403) {
      return res.status(500).json({
        error: 'Server configuration error: Hugging Face token is invalid or expired.',
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

    // Log the successful usage
    await supabase.from('usage_logs').insert({ user_id: user.id });

    return res.status(200).json(data);

  } catch (err) {
    console.error('[detect] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

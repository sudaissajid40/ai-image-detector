import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Verify Admin authorization
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized credentials' });
    }

    // Check if requester has admin role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || profile.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admins only' });
    }

    if (req.method === 'GET') {
      // List all profiles
      const { data: users, error: listError } = await supabase
        .from('profiles')
        .select('*')
        .order('email', { ascending: true });

      if (listError) throw listError;
      return res.status(200).json({ users });
    }

    if (req.method === 'POST') {
      // Modify user limits
      const { targetUserId, dailyLimit, monthlyLimit } = req.body;

      if (!targetUserId || dailyLimit === undefined || monthlyLimit === undefined) {
        return res.status(400).json({ error: 'Missing targetUserId, dailyLimit, or monthlyLimit' });
      }

      const { data: updated, error: updateError } = await supabase
        .from('profiles')
        .update({
          daily_limit: parseInt(dailyLimit, 10),
          monthly_limit: parseInt(monthlyLimit, 10),
          updated_at: new Date().toISOString()
        })
        .eq('id', targetUserId)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.status(200).json({ message: 'Limits updated successfully', user: updated });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[admin] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

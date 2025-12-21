import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { data, error } = await supabase
      .from('role')
      .select('id, name, excluded_features')
      .eq('name', 'Public')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.json({ excluded_features: [] });
      }
      console.error('Error fetching Public role:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ 
      excluded_features: data?.excluded_features || [],
      role_id: data?.id
    });
  } catch (error) {
    console.error('Public role exclusions fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch public role exclusions' });
  }
}

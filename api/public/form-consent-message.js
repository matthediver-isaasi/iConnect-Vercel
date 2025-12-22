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
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'form_default_consent_message')
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching form consent message:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: data?.setting_value || '' });
  } catch (error) {
    console.error('Form consent message fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch consent message' });
  }
}

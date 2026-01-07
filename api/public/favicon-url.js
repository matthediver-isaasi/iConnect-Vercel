import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (!supabase) {
    return res.status(200).json({ faviconUrl: null });
  }

  try {
    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'site_favicon_url')
      .single();

    return res.status(200).json({ faviconUrl: data?.setting_value || null });
  } catch (error) {
    return res.status(200).json({ faviconUrl: null });
  }
}

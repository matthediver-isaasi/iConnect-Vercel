import { supabase } from '../_lib/database.js';

const DEFAULT_PLATFORM_BRANDING = {
  platformBrandingText: 'Powered by isaasi',
  platformBrandingUrl: 'https://isaasi.co.uk'
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { data, error } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'platform_defaults')
      .single();

    if (error || !data) {
      return res.json(DEFAULT_PLATFORM_BRANDING);
    }

    const defaults = data.value ?? DEFAULT_PLATFORM_BRANDING;
    res.json({
      ...DEFAULT_PLATFORM_BRANDING,
      ...defaults
    });
  } catch (error) {
    console.error('[Public] Platform defaults error:', error);
    res.json(DEFAULT_PLATFORM_BRANDING);
  }
}

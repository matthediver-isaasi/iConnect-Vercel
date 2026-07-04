import { supabase } from '../_lib/database.js';

const DEFAULT_PERSONA = {
  name: 'Dougal',
  avatarUrl: ''
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.json(DEFAULT_PERSONA);
  }

  try {
    const { data, error } = await supabase
      .from('platform_preferences')
      .select('value')
      .eq('key', 'ai_help_persona')
      .single();

    if (error || !data || !data.value) {
      return res.json(DEFAULT_PERSONA);
    }

    return res.json({
      ...DEFAULT_PERSONA,
      ...data.value
    });
  } catch (err) {
    console.error('[Public] AI help persona error:', err);
    return res.json(DEFAULT_PERSONA);
  }
}

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
  const { id } = req.query;

  try {
    const { data, error } = await supabase
      .from('preference_field')
      .select('id, label, field_type, options, entity_scope')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error) {
      console.error('Error fetching custom field:', error);
      return res.status(404).json({ error: 'Custom field not found' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Public custom field fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch custom field' });
  }
}

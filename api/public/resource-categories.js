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
    // Include categories where is_active is true OR null (treat null as active)
    const { data, error } = await supabase
      .from('resource_category')
      .select('id, name, description, subcategories, applies_to_content_types')
      .or('is_active.eq.true,is_active.is.null')
      .order('display_order', { ascending: true });

    if (error) {
      console.error('Error fetching resource categories:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (error) {
    console.error('Public resource categories fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource categories' });
  }
}

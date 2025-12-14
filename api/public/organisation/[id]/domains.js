import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Organisation ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { data, error } = await supabase
      .from('organization')
      .select('id, name, domain, additional_verified_domains')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching organisation domains:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Public organisation domains fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisation domains' });
  }
}

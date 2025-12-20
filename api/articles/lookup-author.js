import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { handle } = req.query;

  if (!handle) {
    return res.status(400).json({ error: 'Handle is required' });
  }

  try {
    console.log('[Author Lookup] Searching for handle:', handle);

    // Try to find member by handle first
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, first_name, last_name, handle, organization_id')
      .eq('handle', handle)
      .single();

    if (member && !memberError) {
      console.log('[Author Lookup] Found member:', member.id);
      
      // Fetch organization if member has one
      let organizationName = null;
      if (member.organization_id) {
        const { data: org } = await supabase
          .from('organization')
          .select('name')
          .eq('zoho_account_id', member.organization_id)
          .single();
        
        if (org) {
          organizationName = org.name;
        }
      }

      return res.json({
        type: 'member',
        id: member.id,
        name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Author',
        organization: organizationName
      });
    }

    // Try guest writer by handle
    const { data: guestWriter, error: gwError } = await supabase
      .from('guest_writer')
      .select('id, full_name, handle, organization')
      .eq('handle', handle)
      .single();

    if (guestWriter && !gwError) {
      console.log('[Author Lookup] Found guest writer:', guestWriter.id);
      return res.json({
        type: 'guest_writer',
        id: guestWriter.id,
        name: guestWriter.full_name || 'Unknown Author',
        organization: guestWriter.organization
      });
    }

    // Author not found
    console.log('[Author Lookup] Author not found for handle:', handle);
    return res.status(404).json({ error: 'Author not found' });
  } catch (error) {
    console.error('[Author Lookup] Error:', error);
    return res.status(500).json({ error: 'Failed to lookup author' });
  }
}

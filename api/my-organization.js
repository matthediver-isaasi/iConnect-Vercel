import { getSessionMember } from './_lib/session.js';
import { supabase } from './_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Get the member's organization_id
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('organization_id')
      .eq('id', sessionMember.id)
      .single();

    if (memberError || !member?.organization_id) {
      console.error('[Update My Org] Member lookup error:', memberError);
      return res.status(404).json({ error: 'Member or organization not found' });
    }

    const orgId = member.organization_id;
    const rawUpdates = req.body;

    // Fields that members can update on their own organization (name excluded)
    const allowedFields = [
      'description', 'website_url', 'logo_url',
      'phone', 'invoicing_email', 'invoicing_address'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (rawUpdates[field] !== undefined) {
        updates[field] = rawUpdates[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data: updatedOrg, error: updateError } = await supabase
      .from('organization')
      .update(updates)
      .eq('id', orgId)
      .select()
      .single();

    if (updateError) {
      console.error('[Update My Org] Error:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    return res.json(updatedOrg);
  } catch (error) {
    console.error('[Update My Org] Error:', error);
    return res.status(500).json({ error: 'Failed to update organization' });
  }
}

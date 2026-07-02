import { getSession } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionResult = await getSession(req);

    if (!sessionResult || !sessionResult.data) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = sessionResult.data;
    if (!session.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { emailId, is_pinned, is_flagged } = req.body;

    if (!emailId) {
      return res.status(400).json({ error: 'emailId is required' });
    }

    const updateFields = {};
    if (typeof is_pinned === 'boolean') updateFields.is_pinned = is_pinned;
    if (typeof is_flagged === 'boolean') updateFields.is_flagged = is_flagged;

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('member_email')
      .update(updateFields)
      .eq('id', emailId)
      .eq('tenant_id', session.tenantId)
      .select('id, is_pinned, is_flagged');

    if (error) {
      console.error('[Outlook Email Update] Database error:', error);
      return res.status(500).json({ error: 'Failed to update email' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('[Outlook Email Update] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isAdmin = await hasAdminAccess(tenantContext);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantContext;
  const { email, excludeId } = req.body;

  if (!email) {
    return res.json({ valid: false, reason: 'Email is required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    let ewQuery = supabase
      .from('external_writer')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('email', normalizedEmail);

    if (excludeId) {
      ewQuery = ewQuery.neq('id', excludeId);
    }

    const { data: existingWriters, error: ewError } = await ewQuery.limit(1);

    if (ewError) {
      console.error('[Validate Email] External writer check error:', ewError);
      return res.status(500).json({ error: 'Validation failed' });
    }

    if (existingWriters && existingWriters.length > 0) {
      return res.json({ valid: false, reason: 'An external writer with this email already exists' });
    }

    const { data: existingMembers, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('email', normalizedEmail)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .limit(1);

    if (memberError) {
      console.error('[Validate Email] Member check error:', memberError);
      return res.status(500).json({ error: 'Validation failed' });
    }

    if (existingMembers && existingMembers.length > 0) {
      return res.json({ valid: false, reason: 'This email belongs to an existing member' });
    }

    return res.json({ valid: true });
  } catch (err) {
    console.error('[Validate Email] Error:', err);
    return res.status(500).json({ error: 'Validation failed' });
  }
}

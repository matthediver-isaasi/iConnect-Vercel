import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const DEFAULT_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx || !tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!tenantCtx.tenantUserId) {
    return res.status(403).json({ error: 'Tenant admin access required' });
  }

  const callerTenantId = tenantCtx.tenantId;
  if (!callerTenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }

  try {
    const { data: membersWithOrg, error: orgError } = await supabase
      .from('member')
      .select('id, organization_id, organization:organization_id(tenant_id)')
      .is('tenant_id', null)
      .not('organization_id', 'is', null);

    if (orgError) {
      console.error('[BackfillMemberTenantId] Error fetching members with org:', orgError);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    let updatedFromOrg = 0;
    for (const member of (membersWithOrg || [])) {
      const tenantId = member.organization?.tenant_id;
      if (tenantId) {
        const { error } = await supabase
          .from('member')
          .update({ tenant_id: tenantId })
          .eq('id', member.id);
        if (!error) updatedFromOrg++;
      }
    }

    let updatedDefault = 0;
    if (callerTenantId === DEFAULT_TENANT_ID) {
      const { data: membersNoOrg, error: noOrgError } = await supabase
        .from('member')
        .select('id')
        .is('tenant_id', null);

      if (noOrgError) {
        console.error('[BackfillMemberTenantId] Error fetching remaining members:', noOrgError);
        return res.status(500).json({ error: 'Failed to fetch remaining members' });
      }

      for (const member of (membersNoOrg || [])) {
        const { error } = await supabase
          .from('member')
          .update({ tenant_id: DEFAULT_TENANT_ID })
          .eq('id', member.id);
        if (!error) updatedDefault++;
      }
    }

    console.log(`[BackfillMemberTenantId] Complete: ${updatedFromOrg} from org, ${updatedDefault} default`);

    return res.json({
      success: true,
      updatedFromOrganization: updatedFromOrg,
      updatedWithDefault: updatedDefault,
      totalUpdated: updatedFromOrg + updatedDefault
    });
  } catch (err) {
    console.error('[BackfillMemberTenantId] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

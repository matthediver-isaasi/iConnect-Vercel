import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { submissionId, ownerMemberId, ownerName } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission:form_submission_id(form_id)')
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (ownerMemberId) {
      const formId = existing.form_submission?.form_id;
      if (formId) {
        const { data: config } = await supabase
          .from('form_due_diligence_config')
          .select('owner_role_ids')
          .eq('form_id', formId)
          .eq('tenant_id', tenantCtx.tenantId)
          .single();

        const allowedRoles = config?.owner_role_ids || [];
        if (allowedRoles.length > 0) {
          const { data: memberCheck } = await supabase
            .from('member')
            .select('id, role_id')
            .eq('id', ownerMemberId)
            .eq('tenant_id', tenantCtx.tenantId)
            .single();

          if (!memberCheck || !allowedRoles.includes(memberCheck.role_id)) {
            return res.status(400).json({ error: 'Selected member does not have an allowed owner role' });
          }
        }
      }
    }

    const updateData = {
      owner_member_id: ownerMemberId || null,
      owner_name: ownerName || null
    };

    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update(updateData)
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[update-owner] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update owner' });
    }

    return res.json({ success: true, owner_member_id: updateData.owner_member_id, owner_name: updateData.owner_name });
  } catch (err) {
    console.error('[update-owner] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

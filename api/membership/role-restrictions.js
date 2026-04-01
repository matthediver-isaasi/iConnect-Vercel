import { supabase } from '../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  const context = await getTenantContext(req);
  if (!context?.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = context.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context not available' });
  }

  const memberId = context.memberId;
  if (!memberId) {
    return res.status(400).json({ error: 'Member context not available' });
  }

  try {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, organization_id')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();

    if (memberError || !member || !member.organization_id) {
      return res.status(400).json({ error: 'Member or organization not found' });
    }

    const organizationId = member.organization_id;

    if (req.method === 'GET') {
      const { data: org, error: orgError } = await supabase
        .from('organization')
        .select('training_fund_allowed_role_ids, voucher_allowed_role_ids')
        .eq('id', organizationId)
        .eq('tenant_id', tenantId)
        .single();

      if (orgError) {
        throw new Error(orgError.message);
      }

      return res.json({
        data: {
          training_fund_allowed_role_ids: org?.training_fund_allowed_role_ids || [],
          voucher_allowed_role_ids: org?.voucher_allowed_role_ids || []
        }
      });
    }

    if (req.method === 'PUT') {
      const { isAdmin } = await checkCrossOrgPermissions(context.roleId);
      if (!isAdmin) {
        return res.status(403).json({ error: 'Only administrators can update role restrictions' });
      }

      const { training_fund_allowed_role_ids, voucher_allowed_role_ids } = req.body;

      const updateData = {};

      if (training_fund_allowed_role_ids !== undefined) {
        if (!Array.isArray(training_fund_allowed_role_ids)) {
          return res.status(400).json({ error: 'training_fund_allowed_role_ids must be an array' });
        }
        if (training_fund_allowed_role_ids.length > 0) {
          const { data: validRoles, error: rolesError } = await supabase
            .from('role')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('id', training_fund_allowed_role_ids);

          if (rolesError) {
            throw new Error(rolesError.message);
          }

          const validRoleIds = new Set((validRoles || []).map(r => r.id));
          const invalidIds = training_fund_allowed_role_ids.filter(id => !validRoleIds.has(id));
          if (invalidIds.length > 0) {
            return res.status(400).json({ error: `Invalid role IDs for training fund: ${invalidIds.join(', ')}` });
          }
        }
        updateData.training_fund_allowed_role_ids = training_fund_allowed_role_ids.length > 0 ? training_fund_allowed_role_ids : null;
      }

      if (voucher_allowed_role_ids !== undefined) {
        if (!Array.isArray(voucher_allowed_role_ids)) {
          return res.status(400).json({ error: 'voucher_allowed_role_ids must be an array' });
        }
        if (voucher_allowed_role_ids.length > 0) {
          const { data: validRoles, error: rolesError } = await supabase
            .from('role')
            .select('id')
            .eq('tenant_id', tenantId)
            .in('id', voucher_allowed_role_ids);

          if (rolesError) {
            throw new Error(rolesError.message);
          }

          const validRoleIds = new Set((validRoles || []).map(r => r.id));
          const invalidIds = voucher_allowed_role_ids.filter(id => !validRoleIds.has(id));
          if (invalidIds.length > 0) {
            return res.status(400).json({ error: `Invalid role IDs for vouchers: ${invalidIds.join(', ')}` });
          }
        }
        updateData.voucher_allowed_role_ids = voucher_allowed_role_ids.length > 0 ? voucher_allowed_role_ids : null;
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const { error: updateError } = await supabase
        .from('organization')
        .update(updateData)
        .eq('id', organizationId)
        .eq('tenant_id', tenantId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      return res.json({
        success: true,
        data: {
          training_fund_allowed_role_ids: updateData.training_fund_allowed_role_ids || [],
          voucher_allowed_role_ids: updateData.voucher_allowed_role_ids || []
        }
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Role Restrictions] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to process role restrictions' });
  }
}

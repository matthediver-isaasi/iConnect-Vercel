import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { fetchXeroInvoicePdf } from '../_lib/xero.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantContext = await getTenantContext(req);
  const sessionMember = await getSessionMember(req);

  if (!tenantContext?.isAuthenticated && !sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { recordId } = req.query;

  if (!recordId) {
    return res.status(400).json({ error: 'Record ID required' });
  }

  try {
    const appTenantId = tenantContext?.tenantId || sessionMember?.tenant_id;
    if (!appTenantId) {
      console.error('[membership-invoice] Cannot determine tenant for Xero PDF fetch');
      return res.status(500).json({ error: 'Cannot determine tenant context for invoice' });
    }

    const isAdmin = await hasAdminAccess(tenantContext);
    const memberOrganizationId = sessionMember?.organization_id || null;
    let record;

    if (isAdmin) {
      const { data, error } = await supabase
        .from('organisation_membership_history')
        .select('id, xero_invoice_id, xero_invoice_number, organization_id, tenant_id')
        .eq('id', recordId)
        .eq('tenant_id', appTenantId)
        .maybeSingle();

      if (error) {
        console.error('[membership-invoice] Error fetching org record (tenant admin):', error);
        return res.status(500).json({ error: 'Failed to fetch membership record' });
      }

      if (data) {
        if (!data.xero_invoice_id) {
          return res.status(404).json({ error: 'Invoice not found for this membership record' });
        }
        record = data;
      } else {
        const { data: memberData, error: memberErr } = await supabase
          .from('member_membership_history')
          .select('id, xero_invoice_id, xero_invoice_number, member_id, tenant_id')
          .eq('id', recordId)
          .eq('tenant_id', appTenantId)
          .maybeSingle();

        if (memberErr) {
          console.error('[membership-invoice] Error fetching member record (tenant admin):', memberErr);
          return res.status(500).json({ error: 'Failed to fetch membership record' });
        }

        if (!memberData || !memberData.xero_invoice_id) {
          return res.status(404).json({ error: 'Invoice not found for this membership record' });
        }

        record = memberData;
      }
    } else if (memberOrganizationId) {
      const { data, error } = await supabase
        .from('organisation_membership_history')
        .select('id, xero_invoice_id, xero_invoice_number, organization_id, tenant_id')
        .eq('id', recordId)
        .eq('tenant_id', appTenantId)
        .maybeSingle();

      if (error) {
        console.error('[membership-invoice] Error fetching org record:', error);
        return res.status(500).json({ error: 'Failed to fetch membership record' });
      }

      if (!data || !data.xero_invoice_id) {
        return res.status(404).json({ error: 'Invoice not found for this membership record' });
      }

      if (data.organization_id !== memberOrganizationId) {
        return res.status(403).json({ error: 'Not authorized to view this invoice' });
      }

      record = data;
    } else {
      const { data, error } = await supabase
        .from('member_membership_history')
        .select('id, xero_invoice_id, xero_invoice_number, member_id, tenant_id')
        .eq('id', recordId)
        .eq('tenant_id', appTenantId)
        .maybeSingle();

      if (error) {
        console.error('[membership-invoice] Error fetching member record:', error);
        return res.status(500).json({ error: 'Failed to fetch membership record' });
      }

      if (!data || !data.xero_invoice_id) {
        return res.status(404).json({ error: 'Invoice not found for this membership record' });
      }

      if (data.member_id !== sessionMember.id) {
        return res.status(403).json({ error: 'Not authorized to view this invoice' });
      }

      record = data;
    }

    const pdfBuffer = await fetchXeroInvoicePdf(record.xero_invoice_id, appTenantId);

    const inline = req.query.inline === 'true';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);

    if (inline) {
      res.setHeader('Content-Disposition', `inline; filename="membership-invoice-${record.xero_invoice_number || recordId}.pdf"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="membership-invoice-${record.xero_invoice_number || recordId}.pdf"`);
    }

    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[membership-invoice] Error serving invoice PDF:', error);
    return res.status(500).json({ error: 'Failed to fetch invoice from Xero' });
  }
}

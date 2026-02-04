import { supabase } from '../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../_lib/tenantContext.js';
import { getValidXeroAccessToken } from '../_lib/xero.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const effectiveTenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
  
  if (!effectiveTenantId) {
    if (tenantCtx.organizationId) {
      const { data: org } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', tenantCtx.organizationId)
        .single();
      if (org?.tenant_id) {
        tenantCtx.effectiveTenantId = org.tenant_id;
      }
    }
  }
  
  const tenantId = tenantCtx.tenantId || tenantCtx.effectiveTenantId;
  
  if (!tenantId) {
    return res.status(403).json({ error: 'Cannot determine tenant context' });
  }

  const isTenantAdmin = !!tenantCtx.tenantUserId;
  let hasAccess = isTenantAdmin;
  
  if (!hasAccess && tenantCtx.roleId) {
    const { hasCrossOrgAccess } = await checkCrossOrgPermissions(tenantCtx.roleId);
    hasAccess = hasCrossOrgAccess;
  }
  
  if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied. This report requires admin permissions.' });
  }

  try {
    if (req.method === 'GET') {
      const { action } = req.query;
      
      // Handle special GET actions
      if (action === 'get_settings') {
        const { data: tenant, error: tenantError } = await supabase
          .from('tenant')
          .select('settings')
          .eq('id', tenantId)
          .single();
        
        if (tenantError) {
          console.error('[PendingPO] Error fetching tenant settings:', tenantError);
          return res.status(500).json({ error: 'Failed to fetch settings' });
        }
        
        const settings = tenant?.settings?.poReminderSettings || {
          reminderDays: [],
          emailTemplateId: null
        };
        
        return res.json(settings);
      }
      
      if (action === 'get_email_templates') {
        const { data: templates, error: templatesError } = await supabase
          .from('email_template')
          .select('id, name, subject')
          .eq('tenant_id', tenantId)
          .order('name');
        
        if (templatesError) {
          console.error('[PendingPO] Error fetching email templates:', templatesError);
          return res.status(500).json({ error: 'Failed to fetch email templates' });
        }
        
        return res.json(templates || []);
      }
      
      const { data: tenantOrgs, error: orgsError } = await supabase
        .from('organization')
        .select('id, name')
        .eq('tenant_id', tenantId);
      
      if (orgsError) {
        console.error('[PendingPO] Error fetching orgs:', orgsError);
        return res.status(500).json({ error: 'Failed to fetch organizations' });
      }
      
      const orgMap = {};
      const tenantOrgIds = (tenantOrgs || []).map(o => {
        orgMap[o.id] = o.name;
        return o.id;
      });
      
      if (tenantOrgIds.length === 0) {
        return res.json({ records: [], organizations: {} });
      }

      const { data: transactions, error: txError } = await supabase
        .from('program_ticket_transaction')
        .select('id, organization_id, program_name, xero_invoice_id, xero_invoice_number, xero_invoice_pdf_uri, created_date, quantity, total_cost_before_discount, member_email, transaction_type, status, purchase_order_number')
        .in('organization_id', tenantOrgIds);
      
      if (txError) {
        console.error('[PendingPO] Error fetching transactions:', txError);
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }

      const { data: bookingsWithOrg, error: bookingError } = await supabase
        .from('booking')
        .select('id, organization_id, member_id, event_id, xero_invoice_id, xero_invoice_number, created_at, ticket_price, attendee_email, payment_method, status, purchase_order_number, po_to_follow, booking_group_reference')
        .in('organization_id', tenantOrgIds);
      
      if (bookingError) {
        console.error('[PendingPO] Error fetching bookings with org:', bookingError);
        return res.status(500).json({ error: 'Failed to fetch bookings' });
      }

      const { data: membersInTenant } = await supabase
        .from('member')
        .select('id, organization_id')
        .in('organization_id', tenantOrgIds);
      
      const memberIdsInTenant = (membersInTenant || []).map(m => m.id);

      let bookingsWithNullOrg = [];
      if (memberIdsInTenant.length > 0) {
        const { data: nullOrgBookings } = await supabase
          .from('booking')
          .select('id, organization_id, member_id, event_id, xero_invoice_id, xero_invoice_number, created_at, ticket_price, attendee_email, payment_method, status, purchase_order_number, po_to_follow, booking_group_reference')
          .is('organization_id', null)
          .in('member_id', memberIdsInTenant);
        
        bookingsWithNullOrg = nullOrgBookings || [];
      }

      const existingBookingIds = new Set((bookingsWithOrg || []).map(b => b.id));
      const bookings = [
        ...(bookingsWithOrg || []),
        ...bookingsWithNullOrg.filter(b => !existingBookingIds.has(b.id))
      ];

      const eventIds = [...new Set((bookings || []).map(b => b.event_id).filter(Boolean))];
      let eventMap = {};
      if (eventIds.length > 0) {
        const { data: events } = await supabase
          .from('event')
          .select('id, title')
          .in('id', eventIds);
        eventMap = (events || []).reduce((acc, e) => {
          acc[e.id] = e.title;
          return acc;
        }, {});
      }

      const memberIds = [...new Set((bookings || []).map(b => b.member_id).filter(Boolean))];
      let memberMap = {};
      if (memberIds.length > 0) {
        const { data: members } = await supabase
          .from('member')
          .select('id, email, organization_id')
          .in('id', memberIds);
        memberMap = (members || []).reduce((acc, m) => {
          acc[m.id] = m;
          return acc;
        }, {});
      }

      const records = [];
      
      (transactions || []).forEach(t => {
        const hasInvoice = (t.xero_invoice_id && t.xero_invoice_id.trim() !== '') || 
                           (t.xero_invoice_number && t.xero_invoice_number.trim() !== '');
        const missingPO = !t.purchase_order_number || t.purchase_order_number.trim() === '';
        const isPurchase = t.transaction_type === 'purchase';
        const isActive = t.status !== 'cancelled';
        
        if (hasInvoice && missingPO && isPurchase && isActive) {
          records.push({
            id: t.id,
            entityType: 'transaction',
            organization_id: t.organization_id,
            source_name: t.program_name || 'Program',
            source_type: 'Program',
            xero_invoice_id: t.xero_invoice_id,
            xero_invoice_number: t.xero_invoice_number,
            xero_invoice_pdf_uri: t.xero_invoice_pdf_uri,
            created_date: t.created_date,
            quantity: t.quantity,
            total_cost: t.total_cost_before_discount,
            member_email: t.member_email,
          });
        }
      });
      
      (bookings || []).forEach(b => {
        const hasInvoice = (b.xero_invoice_id && b.xero_invoice_id.trim() !== '') || 
                           (b.xero_invoice_number && b.xero_invoice_number.trim() !== '');
        const missingPO = !b.purchase_order_number || b.purchase_order_number.trim() === '';
        const isAccountPayment = b.payment_method === 'account' || b.po_to_follow === true;
        const isActive = b.status !== 'cancelled';
        
        if (hasInvoice && missingPO && isAccountPayment && isActive) {
          const member = memberMap[b.member_id];
          const orgId = b.organization_id || member?.organization_id;
          
          records.push({
            id: b.id,
            entityType: 'booking',
            organization_id: orgId,
            source_name: eventMap[b.event_id] || 'Event',
            source_type: 'Event',
            xero_invoice_id: b.xero_invoice_id,
            xero_invoice_number: b.xero_invoice_number,
            xero_invoice_pdf_uri: null,
            created_date: b.created_at,
            quantity: 1,
            total_cost: b.ticket_price,
            member_email: b.attendee_email || member?.email,
            booking_group_reference: b.booking_group_reference,
          });
        }
      });

      // Check Xero for invoice payment status and exclude paid invoices
      let filteredRecords = records;
      let xeroCheckPerformed = false;
      let xeroError = null;
      
      const invoiceIdsToCheck = [...new Set(records.map(r => r.xero_invoice_id).filter(Boolean))];
      
      if (invoiceIdsToCheck.length > 0) {
        try {
          const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);
          
          // Xero allows fetching multiple invoices by IDs (comma-separated)
          // Batch in groups of 50 to avoid URL length limits
          const paidInvoiceIds = new Set();
          const batchSize = 50;
          
          for (let i = 0; i < invoiceIdsToCheck.length; i += batchSize) {
            const batch = invoiceIdsToCheck.slice(i, i + batchSize);
            const idsParam = batch.join(',');
            
            const invoiceResponse = await fetch(
              `https://api.xero.com/api.xro/2.0/Invoices?IDs=${encodeURIComponent(idsParam)}`,
              {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'xero-tenant-id': xeroTenantId,
                  'Accept': 'application/json'
                }
              }
            );
            
            if (invoiceResponse.ok) {
              const invoiceData = await invoiceResponse.json();
              const invoices = invoiceData.Invoices || [];
              
              invoices.forEach(inv => {
                if (inv.Status === 'PAID') {
                  paidInvoiceIds.add(inv.InvoiceID);
                }
              });
            } else {
              console.error('[PendingPO] Xero batch fetch error:', invoiceResponse.status);
            }
          }
          
          // Filter out records with paid invoices
          filteredRecords = records.filter(r => !paidInvoiceIds.has(r.xero_invoice_id));
          xeroCheckPerformed = true;
          
          console.log(`[PendingPO] Xero check: ${records.length} records, ${paidInvoiceIds.size} paid, ${filteredRecords.length} remaining`);
          
        } catch (xeroErr) {
          console.error('[PendingPO] Xero status check error:', xeroErr.message);
          xeroError = xeroErr.message;
          // Continue with unfiltered records if Xero check fails
        }
      }

      return res.json({ 
        records: filteredRecords, 
        organizations: orgMap,
        xeroCheckPerformed,
        xeroError,
        totalBeforeFilter: records.length,
        paidExcluded: records.length - filteredRecords.length
      });
      
    } else if (req.method === 'POST') {
      const { action, entityType, entityId, xeroInvoiceId, purchaseOrderNumber, reminderDays, emailTemplateId } = req.body;
      
      // Handle settings save
      if (action === 'save_settings') {
        // Validate reminderDays is an array of valid day numbers (0-6)
        if (!Array.isArray(reminderDays)) {
          return res.status(400).json({ error: 'reminderDays must be an array' });
        }
        
        const validDays = reminderDays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
        
        // Get current tenant settings
        const { data: tenant, error: fetchError } = await supabase
          .from('tenant')
          .select('settings')
          .eq('id', tenantId)
          .single();
        
        if (fetchError) {
          console.error('[PendingPO] Error fetching tenant:', fetchError);
          return res.status(500).json({ error: 'Failed to fetch tenant' });
        }
        
        const currentSettings = tenant?.settings || {};
        const updatedSettings = {
          ...currentSettings,
          poReminderSettings: {
            reminderDays: validDays,
            emailTemplateId: emailTemplateId || null
          }
        };
        
        const { error: updateError } = await supabase
          .from('tenant')
          .update({ settings: updatedSettings })
          .eq('id', tenantId);
        
        if (updateError) {
          console.error('[PendingPO] Error saving settings:', updateError);
          return res.status(500).json({ error: 'Failed to save settings' });
        }
        
        return res.json({ success: true, settings: updatedSettings.poReminderSettings });
      }
      
      const { data: tenantOrgs } = await supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId);
      
      const tenantOrgIds = (tenantOrgs || []).map(o => o.id);
      
      if (tenantOrgIds.length === 0) {
        return res.status(403).json({ error: 'No organizations found for tenant' });
      }
      
      if (!['booking', 'transaction'].includes(entityType)) {
        return res.status(400).json({ error: 'Invalid entity type' });
      }
      
      const tableName = entityType === 'booking' ? 'booking' : 'program_ticket_transaction';
      
      const { data: existingRecord, error: fetchError } = await supabase
        .from(tableName)
        .select('id, organization_id, member_id')
        .eq('id', entityId)
        .single();
      
      if (fetchError || !existingRecord) {
        return res.status(404).json({ error: 'Record not found' });
      }
      
      let recordBelongsToTenant = tenantOrgIds.includes(existingRecord.organization_id);
      
      if (!recordBelongsToTenant && entityType === 'booking' && existingRecord.member_id) {
        const { data: memberData } = await supabase
          .from('member')
          .select('organization_id')
          .eq('id', existingRecord.member_id)
          .single();
        
        if (memberData && tenantOrgIds.includes(memberData.organization_id)) {
          recordBelongsToTenant = true;
        }
      }
      
      if (!recordBelongsToTenant) {
        return res.status(403).json({ error: 'Access denied. Record does not belong to this tenant.' });
      }
      
      if (action === 'update_po') {
        if (!purchaseOrderNumber || !purchaseOrderNumber.trim()) {
          return res.status(400).json({ error: 'Purchase order number required' });
        }
        
        const updateData = { purchase_order_number: purchaseOrderNumber.trim() };
        if (entityType === 'booking') {
          updateData.po_to_follow = false;
        }
        
        const { error: updateError } = await supabase
          .from(tableName)
          .update(updateData)
          .eq('id', entityId);
        
        if (updateError) {
          console.error('[PendingPO] Error updating PO:', updateError);
          return res.status(500).json({ error: 'Failed to update purchase order number' });
        }
        
        return res.json({ success: true, purchase_order_number: purchaseOrderNumber.trim() });
        
      } else if (action === 'verify') {
        if (!xeroInvoiceId) {
          return res.status(400).json({ error: 'Xero invoice ID required' });
        }
        
        try {
          const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);
          
          const invoiceResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'xero-tenant-id': xeroTenantId,
              'Accept': 'application/json'
            }
          });
          
          if (!invoiceResponse.ok) {
            console.error('[PendingPO] Xero API error:', invoiceResponse.status);
            return res.status(500).json({ error: 'Failed to fetch invoice from Xero' });
          }
          
          const invoiceData = await invoiceResponse.json();
          const invoice = invoiceData.Invoices?.[0];
          
          if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found in Xero' });
          }
          
          const xeroReference = invoice.Reference || '';
          const isTBC = xeroReference.trim().toUpperCase() === 'TBC';
          
          if (xeroReference && xeroReference.trim() !== '' && !isTBC) {
            const updateData = { purchase_order_number: xeroReference.trim() };
            if (entityType === 'booking') {
              updateData.po_to_follow = false;
            }
            
            const { error: updateError } = await supabase
              .from(tableName)
              .update(updateData)
              .eq('id', entityId);
            
            if (updateError) {
              console.error('[PendingPO] Error updating record:', updateError);
              return res.status(500).json({ error: 'Failed to update record' });
            }
            
            return res.json({ 
              found: true, 
              purchase_order_number: xeroReference.trim(),
              updated: true 
            });
          } else {
            const message = isTBC 
              ? 'PO reference is TBC (ignored)' 
              : 'No PO reference found in Xero invoice';
            return res.json({ found: false, message });
          }
          
        } catch (xeroError) {
          console.error('[PendingPO] Xero error:', xeroError.message);
          return res.status(500).json({ error: xeroError.message });
        }
      }
      
      return res.status(400).json({ error: 'Invalid action' });
      
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[PendingPO] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

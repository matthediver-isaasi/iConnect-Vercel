import { supabase } from '../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../_lib/tenantContext.js';
import { getValidXeroAccessToken } from '../_lib/xero.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { replacePlaceholders } from '../_lib/emailService.js';

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

      // Paginated fetch helper. Supabase JS caps a single response at 1000 rows,
      // so we page through results until we get a short page.
      const PAGE_SIZE = 1000;
      const paginationStats = {};
      const fetchAllPages = async (label, buildQuery) => {
        const all = [];
        let from = 0;
        let pageCount = 0;
        while (true) {
          const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
          if (error) {
            console.error(`[PendingPO] Error paginating ${label} (page ${pageCount}):`, error);
            paginationStats[label] = { pagesFetched: pageCount, scannedRows: all.length, error: error.message };
            throw error;
          }
          pageCount += 1;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < PAGE_SIZE) break;
          from += PAGE_SIZE;
        }
        console.log(`[PendingPO] Fetched ${all.length} ${label} rows across ${pageCount} page(s)`);
        paginationStats[label] = { pagesFetched: pageCount, scannedRows: all.length };
        return all;
      };

      // Push the report's filters down to the database so we don't get hit by the
      // 1000-row default cap. Predicates:
      //   - has invoice (xero_invoice_id OR xero_invoice_number not null)
      //   - missing PO (purchase_order_number is null OR empty string)
      //   - not cancelled
      //   - transactions: transaction_type = 'purchase'
      //   - bookings: payment_method = 'account' OR po_to_follow = true
      const HAS_INVOICE_OR = 'xero_invoice_id.not.is.null,xero_invoice_number.not.is.null';
      const MISSING_PO_OR = 'purchase_order_number.is.null,purchase_order_number.eq.';

      let transactions;
      try {
        transactions = await fetchAllPages('program_ticket_transaction', () => supabase
          .from('program_ticket_transaction')
          .select('id, organization_id, program_name, xero_invoice_id, xero_invoice_number, xero_invoice_pdf_uri, created_date, quantity, total_cost_before_discount, member_email, transaction_type, status, purchase_order_number')
          .in('organization_id', tenantOrgIds)
          .eq('transaction_type', 'purchase')
          .neq('status', 'cancelled')
          .or(HAS_INVOICE_OR)
          .or(MISSING_PO_OR)
          .order('id', { ascending: true }));
      } catch (txError) {
        return res.status(500).json({ error: 'Failed to fetch transactions' });
      }

      let bookingsWithOrg;
      try {
        bookingsWithOrg = await fetchAllPages('booking (with org)', () => supabase
          .from('booking')
          .select('id, organization_id, member_id, event_id, xero_invoice_id, xero_invoice_number, created_at, ticket_price, attendee_email, payment_method, status, purchase_order_number, po_to_follow, booking_group_reference')
          .in('organization_id', tenantOrgIds)
          .neq('status', 'cancelled')
          .or('payment_method.eq.account,po_to_follow.eq.true')
          .or(HAS_INVOICE_OR)
          .or(MISSING_PO_OR)
          .order('id', { ascending: true }));
      } catch (bookingError) {
        return res.status(500).json({ error: 'Failed to fetch bookings' });
      }

      let membersInTenant = [];
      try {
        membersInTenant = await fetchAllPages('member (tenant org members)', () => supabase
          .from('member')
          .select('id, organization_id')
          .in('organization_id', tenantOrgIds)
          .order('id', { ascending: true }));
      } catch (memberError) {
        // Non-fatal: we still return org-bound bookings/transactions
        membersInTenant = [];
      }

      const memberIdsInTenant = membersInTenant.map(m => m.id);

      let bookingsWithNullOrg = [];
      if (memberIdsInTenant.length > 0) {
        // Member id list can also be large; page through it in chunks to keep the
        // .in() filter under sensible URL/length limits, and paginate each chunk.
        const MEMBER_CHUNK = 500;
        try {
          for (let i = 0; i < memberIdsInTenant.length; i += MEMBER_CHUNK) {
            const memberChunk = memberIdsInTenant.slice(i, i + MEMBER_CHUNK);
            const chunkRows = await fetchAllPages(`booking (null org, member chunk ${i / MEMBER_CHUNK})`, () => supabase
              .from('booking')
              .select('id, organization_id, member_id, event_id, xero_invoice_id, xero_invoice_number, created_at, ticket_price, attendee_email, payment_method, status, purchase_order_number, po_to_follow, booking_group_reference')
              .is('organization_id', null)
              .in('member_id', memberChunk)
              .neq('status', 'cancelled')
              .or('payment_method.eq.account,po_to_follow.eq.true')
              .or(HAS_INVOICE_OR)
              .or(MISSING_PO_OR)
              .order('id', { ascending: true }));
            bookingsWithNullOrg.push(...chunkRows);
          }
        } catch (nullOrgErr) {
          // Non-fatal — already logged inside fetchAllPages
        }
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

      // Annotate each record with its current Xero status (PAID, AUTHORISED, etc.)
      // so the UI can show a "Paid in Xero" badge. We deliberately no longer drop
      // paid-in-Xero rows from the report — the report's purpose is to chase
      // missing PO numbers regardless of payment state.
      let xeroCheckPerformed = false;
      let xeroError = null;
      let paidCount = 0;

      const invoiceIdsToCheck = [...new Set(records.map(r => r.xero_invoice_id).filter(Boolean))];

      if (invoiceIdsToCheck.length > 0) {
        try {
          const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);

          const xeroStatusById = new Map();
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
                if (inv.InvoiceID) {
                  xeroStatusById.set(inv.InvoiceID, inv.Status || null);
                }
              });
            } else {
              console.error('[PendingPO] Xero batch fetch error:', invoiceResponse.status);
            }
          }

          records.forEach(r => {
            if (r.xero_invoice_id && xeroStatusById.has(r.xero_invoice_id)) {
              r.xero_status = xeroStatusById.get(r.xero_invoice_id);
              if (r.xero_status === 'PAID') paidCount += 1;
            } else {
              r.xero_status = null;
            }
          });

          xeroCheckPerformed = true;
          console.log(`[PendingPO] Xero annotation: ${records.length} records, ${paidCount} paid in Xero (kept in report)`);
        } catch (xeroErr) {
          console.error('[PendingPO] Xero status check error:', xeroErr.message);
          xeroError = xeroErr.message;
          // Continue with un-annotated records if Xero check fails
        }
      }

      console.log(`[PendingPO] Report ready for tenant ${tenantId}: ${records.length} records (${transactions.length} tx + ${bookings.length} bookings scanned), xeroChecked=${xeroCheckPerformed}, paidInXero=${paidCount}`);

      return res.json({
        records,
        organizations: orgMap,
        xeroCheckPerformed,
        xeroError,
        totalBeforeFilter: records.length,
        // Kept for backward compatibility with the existing UI badge.
        // We no longer drop paid invoices, so this is always 0 when annotation
        // succeeds. `paidInXero` exposes the new annotated count.
        paidExcluded: 0,
        paidInXero: paidCount,
        pagination: paginationStats,
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
      
      // Handle send_reminder action
      if (action === 'send_reminder') {
        const { recordId, entityType: reminderEntityType, emailTemplateId: reminderTemplateId } = req.body;
        
        if (!recordId || !reminderEntityType || !reminderTemplateId) {
          return res.status(400).json({ error: 'recordId, entityType, and emailTemplateId are required' });
        }
        
        // Validate entityType strictly
        if (!['booking', 'transaction'].includes(reminderEntityType)) {
          return res.status(400).json({ error: 'Invalid entityType. Must be "booking" or "transaction"' });
        }
        
        // Fetch email template
        const { data: template, error: templateError } = await supabase
          .from('email_template')
          .select('id, name, subject, body')
          .eq('id', reminderTemplateId)
          .eq('tenant_id', tenantId)
          .single();
        
        if (templateError || !template) {
          console.error('[PendingPO] Template not found:', templateError);
          return res.status(404).json({ error: 'Email template not found' });
        }
        
        // Fetch the record details based on entity type
        const tableName = reminderEntityType === 'booking' ? 'booking' : 'program_ticket_transaction';
        const { data: record, error: recordError } = await supabase
          .from(tableName)
          .select(`
            id, organization_id, member_id, xero_invoice_number, xero_invoice_id,
            ${reminderEntityType === 'booking' 
              ? 'event_id, created_at, total, number_of_tickets' 
              : 'program_ticket_id, amount, quantity, created_at'}
          `)
          .eq('id', recordId)
          .single();
        
        if (recordError || !record) {
          console.error('[PendingPO] Record not found:', recordError);
          return res.status(404).json({ error: 'Record not found' });
        }
        
        // Verify record belongs to tenant
        const { data: org, error: orgError } = await supabase
          .from('organization')
          .select('id, name, tenant_id')
          .eq('id', record.organization_id)
          .single();
        
        if (orgError || !org || org.tenant_id !== tenantId) {
          return res.status(403).json({ error: 'Access denied' });
        }
        
        // Check if invoice is already paid in Xero before sending reminder
        if (record.xero_invoice_id) {
          try {
            const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);
            
            const invoiceResponse = await fetch(
              `https://api.xero.com/api.xro/2.0/Invoices/${record.xero_invoice_id}`,
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
              const invoice = invoiceData.Invoices?.[0];
              
              if (invoice?.Status === 'PAID') {
                return res.status(400).json({ 
                  error: 'Cannot send reminder - this invoice has already been paid in Xero' 
                });
              }
            }
          } catch (xeroErr) {
            console.error('[PendingPO] Xero check error for reminder:', xeroErr.message);
            // Continue if Xero check fails - we still want to allow manual reminders
          }
        }
        
        // Get member details if available
        let memberData = null;
        if (record.member_id) {
          const { data: member } = await supabase
            .from('member')
            .select('id, email, first_name, last_name')
            .eq('id', record.member_id)
            .single();
          memberData = member;
        }
        
        // Get event or program name
        let sourceName = 'Unknown';
        if (reminderEntityType === 'booking' && record.event_id) {
          const { data: event } = await supabase
            .from('event')
            .select('title')
            .eq('id', record.event_id)
            .single();
          sourceName = event?.title || 'Unknown Event';
        } else if (reminderEntityType === 'transaction' && record.program_ticket_id) {
          const { data: ticket } = await supabase
            .from('program_ticket')
            .select('name, program:program_id(name)')
            .eq('id', record.program_ticket_id)
            .single();
          sourceName = ticket?.program?.name || ticket?.name || 'Unknown Program';
        }
        
        // Determine recipient email - use organization's primary contact or booker's email
        const { data: orgContacts } = await supabase
          .from('member')
          .select('email, first_name, last_name')
          .eq('organization_id', record.organization_id)
          .eq('is_primary_contact', true)
          .limit(1);
        
        const recipientEmail = orgContacts?.[0]?.email || memberData?.email;
        
        if (!recipientEmail) {
          return res.status(400).json({ error: 'No recipient email found for this organization' });
        }
        
        // Build placeholder data
        const placeholderData = {
          organization_name: org.name,
          invoice_number: record.xero_invoice_number || 'N/A',
          invoice_date: record.created_at ? new Date(record.created_at).toLocaleDateString() : 'N/A',
          source_name: sourceName,
          source_type: reminderEntityType === 'booking' ? 'Event' : 'Program',
          member_email: memberData?.email || '',
          member_first_name: memberData?.first_name || '',
          member_last_name: memberData?.last_name || '',
          member_name: memberData ? `${memberData.first_name || ''} ${memberData.last_name || ''}`.trim() : '',
          amount: reminderEntityType === 'booking' 
            ? (record.total || 0) 
            : (record.amount || 0),
          quantity: reminderEntityType === 'booking'
            ? (record.number_of_tickets || 1)
            : (record.quantity || 1),
        };
        
        // Process placeholders in subject and body
        const processedSubject = replacePlaceholders(template.subject, 'record', placeholderData);
        const processedBody = replacePlaceholders(template.body, 'record', placeholderData);
        
        // Send email
        try {
          await sendTenantEmail({
            tenantId,
            to: recipientEmail,
            subject: processedSubject,
            html: processedBody,
          });
          
          console.log(`[PendingPO] Reminder sent to ${recipientEmail} for ${reminderEntityType} ${recordId}`);
          return res.json({ success: true, sentTo: recipientEmail });
          
        } catch (emailError) {
          console.error('[PendingPO] Email send error:', emailError);
          return res.status(500).json({ error: 'Failed to send reminder email' });
        }
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

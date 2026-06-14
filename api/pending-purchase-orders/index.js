import { supabase } from '../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../_lib/tenantContext.js';
import { getAccountingProvider } from '../_lib/accountingProvider.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import {
  applyInvoicePoUpdate,
  ensurePendingPoTokenTable,
  summariseInvoice,
  resolveReminderGreetingName,
  computePendingPoInvoices,
  prepareReminderForInvoice,
  evaluateReminderSchedule,
} from '../_lib/pendingPoInvoice.js';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

// Parse a consolidated record id from the GET response. Format is either
//   id:<xero_invoice_uuid>      — preferred, present whenever Xero pushed a
//                                 GUID to our local row
//   num:<xero_invoice_number>   — fallback when only the human number exists
// Anything else is treated as not-an-invoice (legacy per-row id).
function parseInvoiceKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('id:')) return { xeroInvoiceId: key.slice(3) };
  if (key.startsWith('num:')) return { xeroInvoiceNumber: key.slice(4) };
  return null;
}

// Legacy local helper retained only for the GET path's existing callers.
// Reminder/update logic now uses the shared helpers in api/_lib/pendingPoInvoice.js.
async function findInvoiceRowsForTenant(client, tenantId, invoiceKey) {
  const parsed = parseInvoiceKey(invoiceKey);
  if (!parsed) return null;

  const { data: tenantOrgs } = await client
    .from('organization')
    .select('id')
    .eq('tenant_id', tenantId);
  const tenantOrgIds = (tenantOrgs || []).map((o) => o.id);
  if (tenantOrgIds.length === 0) {
    return { bookings: [], transactions: [], xeroInvoiceId: null, xeroInvoiceNumber: null };
  }

  const { data: tenantMembers } = await client
    .from('member')
    .select('id')
    .in('organization_id', tenantOrgIds);
  const tenantMemberIds = (tenantMembers || []).map((m) => m.id);

  const matchInvoice = (q) => {
    if (parsed.xeroInvoiceId) return q.eq('xero_invoice_id', parsed.xeroInvoiceId);
    return q.eq('xero_invoice_number', parsed.xeroInvoiceNumber);
  };

  const bookingsByOrg = matchInvoice(
    client
      .from('booking')
      .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, created_at, purchase_order_number')
      .in('organization_id', tenantOrgIds)
      .neq('status', 'cancelled'),
  );
  const { data: bookingsOrgRows } = await bookingsByOrg;

  let bookingsByMember = [];
  if (tenantMemberIds.length > 0) {
    // Chunk member id list to avoid URL-length issues, mirroring the GET path.
    const MEMBER_CHUNK = 500;
    for (let i = 0; i < tenantMemberIds.length; i += MEMBER_CHUNK) {
      const chunk = tenantMemberIds.slice(i, i + MEMBER_CHUNK);
      const { data } = await matchInvoice(
        client
          .from('booking')
          .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, created_at, purchase_order_number')
          .is('organization_id', null)
          .in('member_id', chunk)
          .neq('status', 'cancelled'),
      );
      if (data) bookingsByMember.push(...data);
    }
  }

  const seenBooking = new Set();
  const bookings = [...(bookingsOrgRows || []), ...bookingsByMember].filter((b) => {
    if (seenBooking.has(b.id)) return false;
    seenBooking.add(b.id);
    return true;
  });

  const { data: transactions } = await matchInvoice(
    client
      .from('program_ticket_transaction')
      .select('id, organization_id, xero_invoice_id, xero_invoice_number, member_email, program_name, total_cost_before_discount, quantity, created_date, purchase_order_number')
      .in('organization_id', tenantOrgIds)
      .eq('transaction_type', 'purchase')
      .neq('status', 'cancelled'),
  );

  // Resolve canonical Xero invoice id from any matching row so we can push
  // to Xero even when the consolidated key was the human-readable number.
  const firstWithId = bookings.find((b) => b.xero_invoice_id) || (transactions || []).find((t) => t.xero_invoice_id);
  const xeroInvoiceId = parsed.xeroInvoiceId || firstWithId?.xero_invoice_id || null;
  const firstWithNum = bookings.find((b) => b.xero_invoice_number) || (transactions || []).find((t) => t.xero_invoice_number);
  const xeroInvoiceNumber = parsed.xeroInvoiceNumber || firstWithNum?.xero_invoice_number || null;

  return {
    bookings: bookings || [],
    transactions: transactions || [],
    xeroInvoiceId,
    xeroInvoiceNumber,
  };
}

// Pick a single representative row for invoice-level reminder sending.
// Bookings preferred over transactions; oldest first so the placeholder data
// reflects the original sign-up.
async function resolveInvoiceRepresentative(client, tenantId, invoiceKey) {
  const found = await findInvoiceRowsForTenant(client, tenantId, invoiceKey);
  if (!found) return null;
  const sortedBookings = (found.bookings || []).slice().sort((a, b) => {
    const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ad - bd;
  });
  if (sortedBookings.length > 0) return { entityType: 'booking', id: sortedBookings[0].id };
  const sortedTx = (found.transactions || []).slice().sort((a, b) => {
    const ad = a.created_date ? new Date(a.created_date).getTime() : 0;
    const bd = b.created_date ? new Date(b.created_date).getTime() : 0;
    return ad - bd;
  });
  if (sortedTx.length > 0) return { entityType: 'transaction', id: sortedTx[0].id };
  return null;
}

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
        
        const settings = tenant?.settings?.poReminderSettings || {};

        return res.json({
          reminderDays: settings.reminderDays || [],
          sendAfterDays: Number.isInteger(settings.sendAfterDays) ? settings.sendAfterDays : 7,
          repeatEveryDays: Number.isInteger(settings.repeatEveryDays) ? settings.repeatEveryDays : 7,
          maxSends: Number.isInteger(settings.maxSends) ? settings.maxSends : 3,
        });
      }
      
      let computed;
      try {
        computed = await computePendingPoInvoices({ client: supabase, tenantId });
      } catch (computeError) {
        console.error('[PendingPO] Failed to compute pending invoices:', computeError);
        return res.status(500).json({ error: 'Failed to load pending purchase orders' });
      }

      // Annotate each invoice line with how many reminders have been sent and
      // when the next one is due, using the same schedule logic the cron uses.
      try {
        const { data: tenantRow } = await supabase
          .from('tenant')
          .select('settings')
          .eq('id', tenantId)
          .single();
        const reminderSettings = tenantRow?.settings?.poReminderSettings || {};

        const invoiceKeys = computed.records.map((r) => r.id).filter(Boolean);
        const sendCountByKey = new Map();
        const lastSentByKey = new Map();

        // Batch the reminder-log lookup (chunked to keep the IN list short)
        // rather than querying per invoice row.
        const KEY_CHUNK = 200;
        for (let i = 0; i < invoiceKeys.length; i += KEY_CHUNK) {
          const chunk = invoiceKeys.slice(i, i + KEY_CHUNK);
          const { data: logRows, error: logErr } = await supabase
            .from('po_reminder_log')
            .select('invoice_key, sent_at')
            .eq('tenant_id', tenantId)
            .in('invoice_key', chunk)
            .order('sent_at', { ascending: false });
          if (logErr) {
            console.error('[PendingPO] Failed to load reminder log:', logErr);
            continue;
          }
          (logRows || []).forEach((row) => {
            sendCountByKey.set(row.invoice_key, (sendCountByKey.get(row.invoice_key) || 0) + 1);
            // Rows are sent_at DESC, so the first seen per key is the latest.
            if (!lastSentByKey.has(row.invoice_key)) {
              lastSentByKey.set(row.invoice_key, row.sent_at);
            }
          });
        }

        const nowForSchedule = new Date();
        computed.records.forEach((r) => {
          const priorCount = sendCountByKey.get(r.id) || 0;
          const lastSentAt = lastSentByKey.get(r.id) || null;
          const schedule = evaluateReminderSchedule({
            reminderDays: reminderSettings.reminderDays,
            sendAfterDays: reminderSettings.sendAfterDays,
            repeatEveryDays: reminderSettings.repeatEveryDays,
            maxSends: reminderSettings.maxSends,
            createdDate: r.created_date,
            now: nowForSchedule,
            priorCount,
            lastSentAt,
          });
          r.remindersSent = priorCount;
          r.lastReminderAt = lastSentAt;
          r.nextReminderStatus = schedule.status;
          r.nextReminderAt = schedule.nextReminderAt
            ? schedule.nextReminderAt.toISOString()
            : null;
        });
      } catch (reminderAnnotateError) {
        console.error('[PendingPO] Failed to annotate reminder status:', reminderAnnotateError);
        // Non-fatal: fall back to records without reminder annotations.
      }

      console.log(`[PendingPO] Report ready for tenant ${tenantId}: ${computed.records.length} invoices, xeroChecked=${computed.xeroCheckPerformed}, paidInXero=${computed.paidInXero}`);

      return res.json({
        records: computed.records,
        organizations: computed.orgMap,
        xeroCheckPerformed: computed.xeroCheckPerformed,
        xeroError: computed.xeroError,
        totalBeforeFilter: computed.totalBeforeFilter,
        // Kept for backward compatibility with the existing UI badge.
        // We no longer drop paid invoices, so this is always 0 when annotation
        // succeeds. `paidInXero` exposes the new annotated count.
        paidExcluded: 0,
        paidInXero: computed.paidInXero,
        voidedExcluded: computed.voidedExcluded,
        xeroPoExcluded: computed.xeroPoExcluded,
        xeroPoBackfilled: computed.xeroPoBackfilled,
        pagination: computed.pagination,
      });
      
    } else if (req.method === 'POST') {
      const { action, entityType, entityId, xeroInvoiceId, purchaseOrderNumber, reminderDays } = req.body;
      
      // Handle settings save
      if (action === 'save_settings') {
        // Validate reminderDays is an array of valid day numbers (0-6)
        if (!Array.isArray(reminderDays)) {
          return res.status(400).json({ error: 'reminderDays must be an array' });
        }
        
        const validDays = reminderDays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);

        // Frequency settings. Coerce to positive integers, fall back to sensible
        // defaults when missing/invalid so the saved object always round-trips.
        const { sendAfterDays, repeatEveryDays, maxSends } = req.body;
        const toPositiveInt = (value, fallback) => {
          const n = Number(value);
          return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : fallback;
        };
        const validSendAfterDays = toPositiveInt(sendAfterDays, 7);
        const validRepeatEveryDays = toPositiveInt(repeatEveryDays, 7);
        const validMaxSends = toPositiveInt(maxSends, 3);
        
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
            sendAfterDays: validSendAfterDays,
            repeatEveryDays: validRepeatEveryDays,
            maxSends: validMaxSends,
            emailTemplateId: null,
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
      

      // Handle preview_reminder — runs all guardrails, mints the token, and
      // returns the rendered email so the UI can show it before the user
      // confirms send. The minted token is reused on the subsequent
      // send_reminder confirm so no second token is created.
      if (action === 'preview_reminder') {
        const { recordId, entityType: previewEntityType } = req.body;
        if (!recordId || !previewEntityType) {
          return res.status(400).json({ error: 'recordId and entityType are required' });
        }
        if (previewEntityType !== 'invoice') {
          return res.status(400).json({ error: 'Reminders can only be sent for consolidated invoices' });
        }

        const prepared = await prepareReminderForInvoice({ client: supabase, tenantId, invoiceKey: recordId });
        if (!prepared.ok) {
          return res.status(prepared.status).json({ error: prepared.error });
        }

        return res.json({
          recipientEmail: prepared.recipientEmail,
          subject: prepared.subject,
          html: prepared.html,
          submitUrl: prepared.submitUrl,
          token: prepared.token,
          expiresAt: prepared.expiresAt,
        });
      }

      // Handle send_reminder action — supports two call shapes:
      //   1. { token } — confirm-send a previously previewed reminder; reuses
      //      the existing token (no second token minted).
      //   2. { recordId, entityType } — legacy single-shot path used by the
      //      bulk sender; mints a token + sends in one call.
      if (action === 'send_reminder') {
        const { recordId, entityType: reminderEntityType, token: providedToken } = req.body;

        // Path 1: send via previously previewed token.
        if (providedToken) {
          await ensurePendingPoTokenTable();
          const { data: tokenRow, error: tokenLookupError } = await supabase
            .from('pending_po_token')
            .select('token, tenant_id, invoice_key, status, recipient_email, expires_at')
            .eq('token', providedToken)
            .maybeSingle();
          if (tokenLookupError) {
            console.error('[PendingPO] Token lookup error:', tokenLookupError);
            return res.status(500).json({ error: 'Failed to look up reminder token' });
          }
          if (!tokenRow || tokenRow.tenant_id !== tenantId) {
            return res.status(404).json({ error: 'Reminder token not found' });
          }
          if (tokenRow.status !== 'pending') {
            return res.status(400).json({ error: 'This reminder link has already been used or is no longer valid' });
          }
          if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
            return res.status(400).json({ error: 'This reminder link has expired' });
          }
          if (!tokenRow.recipient_email) {
            return res.status(400).json({ error: 'No recipient email found for this reminder' });
          }

          // Re-derive subject/html from the invoice summary so the email body
          // is consistent with what was previewed. We deliberately reuse the
          // stored token rather than minting a new one.
          const summary = await summariseInvoice(supabase, tenantId, tokenRow.invoice_key);
          if (!summary || summary.rowCount === 0) {
            return res.status(404).json({ error: 'Invoice not found for this tenant' });
          }
          if (summary.existingPoNumber) {
            return res.status(400).json({ error: 'A purchase order number has already been recorded for this invoice.' });
          }

          const { data: tenant } = await supabase
            .from('tenant')
            .select('name, slug, primary_color')
            .eq('id', tenantId)
            .single();
          const tenantSlug = tenant?.slug;
          const tenantName = tenant?.name || 'Organisation';
          const primaryColor = tenant?.primary_color || '#5C0085';
          const submitUrl = tenantSlug
            ? `https://${tenantSlug}.${APP_DOMAIN}/submit-po/${tokenRow.token}`
            : `https://${APP_DOMAIN}/submit-po/${tokenRow.token}`;
          const expiresAtDate = tokenRow.expires_at ? new Date(tokenRow.expires_at) : new Date();
          const invoiceDateText = summary.invoiceDate
            ? new Date(summary.invoiceDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'N/A';
          const totalText = `\u00a3${Number(summary.totalCost || 0).toFixed(2)}`;
          const greetingName = await resolveReminderGreetingName(supabase, summary);
          const invoiceNumber = summary.invoiceNumber || 'N/A';
          const sourceLine = summary.sourceName
            ? `${summary.sourceType ? summary.sourceType + ': ' : ''}${summary.sourceName}`
            : '';
          const subject = `Purchase order required for invoice ${invoiceNumber}`;
          const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="padding: 20px; border: 1px solid #e5e5e5; border-radius: 8px;">
              <h2 style="color: ${primaryColor}; margin-top: 0;">Purchase Order Required</h2>
              <p>Dear ${greetingName},</p>
              <p>The following invoice from <strong>${tenantName}</strong> is awaiting a purchase order number:</p>
              <div style="background: #f9f9f9; padding: 16px; border-radius: 6px; margin: 16px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr><td style="padding: 4px 0; color: #666;">Invoice Number</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${invoiceNumber}</td></tr>
                  <tr><td style="padding: 4px 0; color: #666;">Invoice Date</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${invoiceDateText}</td></tr>
                  ${sourceLine ? `<tr><td style="padding: 4px 0; color: #666;">${summary.sourceType || 'For'}</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${summary.sourceName}</td></tr>` : ''}
                  ${summary.bookerNameDisplay ? `<tr><td style="padding: 4px 0; color: #666;">Booked by</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${summary.bookerNameDisplay}</td></tr>` : ''}
                  <tr><td colspan="2" style="padding: 8px 0 4px 0; border-top: 1px solid #ddd;"></td></tr>
                  <tr><td style="padding: 4px 0; color: #333; font-weight: 600;">Total</td><td style="padding: 4px 0; text-align: right; font-weight: 700; font-size: 18px;">${totalText}</td></tr>
                </table>
              </div>
              <p>Please use the secure link below to submit your purchase order number. The PO number will be applied to this invoice and forwarded to our accounting system automatically.</p>
              <div style="text-align: center; margin: 24px 0;">
                <a href="${submitUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Submit Purchase Order Number</a>
              </div>
              <p style="color: #999; font-size: 12px;">This link expires on ${expiresAtDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
            </div>
            <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
          </div>
        `;

          try {
            await sendTenantEmail({
              tenantId,
              to: tokenRow.recipient_email,
              subject,
              html,
            });
            console.log(`[PendingPO] Reminder (preview-confirm) sent to ${tokenRow.recipient_email} for invoice ${tokenRow.invoice_key}`);
            return res.json({ success: true, sentTo: tokenRow.recipient_email, submitUrl });
          } catch (emailError) {
            console.error('[PendingPO] Email send error:', emailError);
            return res.status(500).json({ error: 'Failed to send reminder email' });
          }
        }

        // Path 2: legacy bulk path — record-based call mints + sends in one shot.
        if (!recordId || !reminderEntityType) {
          return res.status(400).json({ error: 'recordId and entityType (or token) are required' });
        }

        // Reminders are only sent at the consolidated invoice level. Per-row
        // legacy callers are no longer supported.
        if (reminderEntityType !== 'invoice') {
          return res.status(400).json({ error: 'Reminders can only be sent for consolidated invoices' });
        }

        const prepared = await prepareReminderForInvoice({ client: supabase, tenantId, invoiceKey: recordId });
        if (!prepared.ok) {
          return res.status(prepared.status).json({ error: prepared.error });
        }

        try {
          await sendTenantEmail({
            tenantId,
            to: prepared.recipientEmail,
            subject: prepared.subject,
            html: prepared.html,
          });
          console.log(`[PendingPO] Reminder sent to ${prepared.recipientEmail} for invoice ${recordId}`);
          return res.json({ success: true, sentTo: prepared.recipientEmail, submitUrl: prepared.submitUrl });
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
      
      // Invoice-level update_po: write the PO across every booking +
      // transaction row in this tenant that shares the consolidated invoice,
      // then push to Xero exactly once.
      if (entityType === 'invoice' && action === 'update_po') {
        const result = await applyInvoicePoUpdate({
          client: supabase,
          tenantId,
          invoiceKey: entityId,
          purchaseOrderNumber,
          contextLabel: `PendingPO invoice ${entityId}`,
        });
        if (!result.ok) {
          return res.status(result.status || 500).json({ error: result.error });
        }
        return res.json({
          success: true,
          purchase_order_number: result.purchase_order_number,
          bookingsUpdated: result.bookingsUpdated,
          transactionsUpdated: result.transactionsUpdated,
          xeroUpdated: result.xeroUpdated,
          xeroError: result.xeroError,
        });
      }

      if (!['booking', 'transaction'].includes(entityType)) {
        return res.status(400).json({ error: 'Invalid entity type' });
      }
      
      const tableName = entityType === 'booking' ? 'booking' : 'program_ticket_transaction';
      
      const { data: existingRecord, error: fetchError } = await supabase
        .from(tableName)
        .select('id, organization_id, member_id, xero_invoice_id')
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
        
        const trimmedPO = purchaseOrderNumber.trim();
        let xeroUpdated = false;
        let xeroError = null;
        try {
          const _provider = await getAccountingProvider(tenantId);
          const r = await _provider.pushPurchaseOrder({
            appTenantId: tenantId,
            xeroInvoiceId: existingRecord.xero_invoice_id,
            purchaseOrderNumber: trimmedPO,
            contextLabel: `PendingPO ${entityType} ${entityId}`,
          });
          xeroUpdated = r.xeroUpdated;
          xeroError = r.xeroError;
        } catch (provErr) {
          xeroError = provErr.message;
        }

        return res.json({
          success: true,
          purchase_order_number: trimmedPO,
          xeroUpdated,
          xeroError,
        });
        
      } else if (action === 'verify') {
        if (!xeroInvoiceId) {
          return res.status(400).json({ error: 'Xero invoice ID required' });
        }
        
        try {
          const _provider = await getAccountingProvider(tenantId);
          const { accessToken, tenantId: xeroTenantId } = await _provider.getRawAccessToken(tenantId);
          
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

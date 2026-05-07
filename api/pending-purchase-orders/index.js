import { supabase } from '../_lib/database.js';
import { getTenantContext, checkCrossOrgPermissions } from '../_lib/tenantContext.js';
import { getValidXeroAccessToken, pushPurchaseOrderToXero } from '../_lib/xero.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { replacePlaceholders } from '../_lib/emailService.js';

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

// Find every booking + program_ticket_transaction row in this tenant that
// shares the given Xero invoice. Tenant scope is enforced by joining through
// `organization` (and, for null-org bookings, through the booker's member ->
// organization link).
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
      .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total, number_of_tickets, created_at, purchase_order_number')
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
          .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total, number_of_tickets, created_at, purchase_order_number')
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
      .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, member_email, program_ticket_id, amount, quantity, created_date, purchase_order_number')
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
      let voidedExcluded = 0;
      let xeroPoBackfilled = 0;
      let xeroPoExcluded = 0;

      const invoiceIdsToCheck = [...new Set(records.map(r => r.xero_invoice_id).filter(Boolean))];

      if (invoiceIdsToCheck.length > 0) {
        try {
          const { accessToken, tenantId: xeroTenantId } = await getValidXeroAccessToken(tenantId);

          const xeroStatusById = new Map();
          const xeroPoById = new Map();
          const batchSize = 50;

          // Treat Xero's `Reference` field as a PO when it looks like one rather
          // than blindly accepting any free text. Pure whitespace, the literal
          // strings "n/a"/"none"/"tbc"/"tbd" etc. should not auto-clear the row.
          const looksLikePoReference = (raw) => {
            if (!raw) return false;
            const s = String(raw).trim();
            if (!s) return false;
            const lower = s.toLowerCase();
            const blacklist = new Set([
              'n/a', 'na', 'none', 'no po', 'no-po', 'nopo',
              'tbc', 'tbd', 'pending', 'awaiting po', 'awaiting',
              'po to follow', 'po-to-follow', 'tofollow', 'to follow',
              '-', '--', '0',
            ]);
            if (blacklist.has(lower)) return false;
            // Require at least one alphanumeric character.
            return /[a-z0-9]/i.test(s);
          };

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
                  // Prefer Xero's first-class PurchaseOrderNumber field when
                  // present, otherwise fall back to the free-form Reference
                  // (which is where most of our customers actually type the PO).
                  const candidate = (inv.PurchaseOrderNumber && String(inv.PurchaseOrderNumber).trim())
                    || (inv.Reference && String(inv.Reference).trim())
                    || null;
                  if (candidate && looksLikePoReference(candidate)) {
                    xeroPoById.set(inv.InvoiceID, candidate);
                  }
                }
              });
            } else {
              console.error('[PendingPO] Xero batch fetch error:', invoiceResponse.status);
            }
          }

          records.forEach(r => {
            if (r.xero_invoice_id && xeroStatusById.has(r.xero_invoice_id)) {
              r.xero_status = xeroStatusById.get(r.xero_invoice_id);
            } else {
              r.xero_status = null;
            }
          });

          // Drop any record whose Xero invoice has been cancelled in Xero.
          // We only filter when the Xero status was actually resolved — records
          // with unresolved status (no token / API error / batch failure) are
          // left in place since we cannot confirm they are voided.
          for (let i = records.length - 1; i >= 0; i--) {
            const status = records[i].xero_status;
            if (status === 'VOIDED' || status === 'DELETED') {
              records.splice(i, 1);
              voidedExcluded += 1;
            }
          }

          // Auto-clear records when Xero already shows a PO/Reference against
          // the invoice. We backfill the local row's purchase_order_number so
          // the row stays cleared on subsequent loads (and so other reports
          // that key off this column see the value too), then drop the record
          // from the response. Backfill is best-effort: failures are logged
          // but do not block the response.
          const bookingBackfills = [];
          const transactionBackfills = [];
          for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            if (!rec.xero_invoice_id) continue;
            const poFromXero = xeroPoById.get(rec.xero_invoice_id);
            if (!poFromXero) continue;
            if (rec.entityType === 'booking') {
              bookingBackfills.push({ id: rec.id, po: poFromXero });
            } else if (rec.entityType === 'transaction') {
              transactionBackfills.push({ id: rec.id, po: poFromXero });
            }
            records.splice(i, 1);
            xeroPoExcluded += 1;
          }

          const runBackfill = async (table, rows) => {
            // Group ids by PO value so we can issue one UPDATE per distinct PO
            // (typically one per row, but bookings sharing a Xero invoice will
            // share a PO and collapse together).
            const byPo = new Map();
            rows.forEach(({ id, po }) => {
              if (!byPo.has(po)) byPo.set(po, []);
              byPo.get(po).push(id);
            });
            for (const [po, ids] of byPo) {
              // Re-assert the "missing PO" predicate inside the UPDATE so we
              // never clobber a value that another writer has set between our
              // initial SELECT and this backfill. We also avoid no-op writes
              // when the existing value already equals the Xero value.
              const { data: updated, error } = await supabase
                .from(table)
                .update({ purchase_order_number: po })
                .in('id', ids)
                .or('purchase_order_number.is.null,purchase_order_number.eq.')
                .select('id');
              if (error) {
                console.error(`[PendingPO] Backfill ${table} failed for ${ids.length} row(s):`, error.message);
              } else {
                xeroPoBackfilled += (updated || []).length;
              }
            }
          };

          if (bookingBackfills.length > 0) {
            await runBackfill('booking', bookingBackfills);
          }
          if (transactionBackfills.length > 0) {
            await runBackfill('program_ticket_transaction', transactionBackfills);
          }

          // Recompute paidCount from the post-filter set so the summary stays
          // consistent with what we actually return.
          records.forEach(r => {
            if (r.xero_status === 'PAID') paidCount += 1;
          });

          xeroCheckPerformed = true;
          console.log(`[PendingPO] Xero annotation: ${records.length} records after filter, ${paidCount} paid in Xero (kept in report), ${voidedExcluded} voided/deleted excluded, ${xeroPoExcluded} cleared via Xero PO/Reference (${xeroPoBackfilled} backfilled locally)`);
        } catch (xeroErr) {
          console.error('[PendingPO] Xero status check error:', xeroErr.message);
          xeroError = xeroErr.message;
          // Continue with un-annotated records if Xero check fails
        }
      }

      // Consolidate per-row records into one entry per Xero invoice. Multiple
      // bookings under a single invoice (common for multi-attendee event sign
      // ups) collapse into a single card so the chase action is taken once
      // per invoice, not once per attendee.
      const invoiceKeyOf = (r) => {
        if (r.xero_invoice_id) return `id:${r.xero_invoice_id}`;
        if (r.xero_invoice_number) return `num:${r.xero_invoice_number}`;
        return `row:${r.entityType}-${r.id}`;
      };

      const grouped = new Map();
      records.forEach((r) => {
        const key = invoiceKeyOf(r);
        let g = grouped.get(key);
        if (!g) {
          g = {
            id: key,
            entityType: 'invoice',
            organization_id: r.organization_id,
            source_name: r.source_name,
            source_type: r.source_type,
            xero_invoice_id: r.xero_invoice_id || null,
            xero_invoice_number: r.xero_invoice_number || null,
            xero_invoice_pdf_uri: r.xero_invoice_pdf_uri || null,
            xero_status: r.xero_status ?? null,
            created_date: r.created_date || null,
            quantity: 0,
            total_cost: 0,
            member_email: r.member_email || null,
            booking_group_reference: r.booking_group_reference || null,
            attendees: [],
            items: [],
            _sourceNames: new Set(),
            _sourceTypes: new Set(),
            _orgIds: new Set(),
          };
          grouped.set(key, g);
        }
        g.quantity += Number(r.quantity) || 0;
        g.total_cost += Number(r.total_cost) || 0;
        if (r.created_date) {
          if (!g.created_date || new Date(r.created_date) < new Date(g.created_date)) {
            g.created_date = r.created_date;
          }
        }
        if (!g.xero_invoice_pdf_uri && r.xero_invoice_pdf_uri) {
          g.xero_invoice_pdf_uri = r.xero_invoice_pdf_uri;
        }
        if (r.source_name) g._sourceNames.add(r.source_name);
        if (r.source_type) g._sourceTypes.add(r.source_type);
        if (r.organization_id) g._orgIds.add(r.organization_id);
        g.attendees.push({
          email: r.member_email || null,
          source_name: r.source_name || null,
          entityType: r.entityType,
          id: r.id,
        });
        g.items.push({ entityType: r.entityType, id: r.id });
      });

      const consolidatedRecords = [];
      grouped.forEach((g) => {
        if (g._sourceNames.size > 1) {
          g.source_name = `${g._sourceNames.size} items`;
        }
        if (g._sourceTypes.size > 1) {
          g.source_type = 'Mixed';
        }
        // If the constituent rows span more than one organisation we leave
        // organization_id at the first-seen value (the UI will still show one
        // org name). This is rare in practice — invoices are per-org.
        delete g._sourceNames;
        delete g._sourceTypes;
        delete g._orgIds;
        consolidatedRecords.push(g);
      });

      // Recompute paidCount against the consolidated set so the header badge
      // reflects distinct invoices, not constituent bookings.
      paidCount = consolidatedRecords.reduce(
        (n, r) => n + (r.xero_status === 'PAID' ? 1 : 0),
        0,
      );

      console.log(`[PendingPO] Report ready for tenant ${tenantId}: ${consolidatedRecords.length} invoices (${records.length} rows, ${transactions.length} tx + ${bookings.length} bookings scanned), xeroChecked=${xeroCheckPerformed}, paidInXero=${paidCount}`);

      return res.json({
        records: consolidatedRecords,
        organizations: orgMap,
        xeroCheckPerformed,
        xeroError,
        totalBeforeFilter: records.length,
        // Kept for backward compatibility with the existing UI badge.
        // We no longer drop paid invoices, so this is always 0 when annotation
        // succeeds. `paidInXero` exposes the new annotated count.
        paidExcluded: 0,
        paidInXero: paidCount,
        voidedExcluded,
        xeroPoExcluded,
        xeroPoBackfilled,
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
        let { recordId, entityType: reminderEntityType, emailTemplateId: reminderTemplateId } = req.body;
        
        if (!recordId || !reminderEntityType || !reminderTemplateId) {
          return res.status(400).json({ error: 'recordId, entityType, and emailTemplateId are required' });
        }
        
        // Invoice-level reminders: resolve the canonical invoice key to a
        // single representative booking/transaction (preferring bookings) and
        // continue with the existing per-row logic so we send exactly one
        // email per invoice rather than one per attendee.
        if (reminderEntityType === 'invoice') {
          const resolved = await resolveInvoiceRepresentative(supabase, tenantId, recordId);
          if (!resolved) {
            return res.status(404).json({ error: 'Invoice not found for this tenant' });
          }
          recordId = resolved.id;
          reminderEntityType = resolved.entityType;
        }

        // Validate entityType strictly
        if (!['booking', 'transaction'].includes(reminderEntityType)) {
          return res.status(400).json({ error: 'Invalid entityType. Must be "booking", "transaction", or "invoice"' });
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
        
        // Verify record belongs to tenant. Bookings may legitimately have a
        // null organization_id (the report path falls back to the booker's
        // member -> organization link), so mirror that fallback here so that
        // invoice-level reminders for null-org bookings can still send.
        let org = null;
        if (record.organization_id) {
          const { data: orgRow } = await supabase
            .from('organization')
            .select('id, name, tenant_id')
            .eq('id', record.organization_id)
            .single();
          if (orgRow && orgRow.tenant_id === tenantId) org = orgRow;
        }
        if (!org && reminderEntityType === 'booking' && record.member_id) {
          const { data: memberRow } = await supabase
            .from('member')
            .select('organization_id')
            .eq('id', record.member_id)
            .single();
          if (memberRow?.organization_id) {
            const { data: orgRow } = await supabase
              .from('organization')
              .select('id, name, tenant_id')
              .eq('id', memberRow.organization_id)
              .single();
            if (orgRow && orgRow.tenant_id === tenantId) org = orgRow;
          }
        }
        if (!org) {
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
      
      // Invoice-level update_po: write the PO across every booking +
      // transaction row in this tenant that shares the consolidated invoice,
      // then push to Xero exactly once.
      if (entityType === 'invoice' && action === 'update_po') {
        if (!purchaseOrderNumber || !purchaseOrderNumber.trim()) {
          return res.status(400).json({ error: 'Purchase order number required' });
        }
        const found = await findInvoiceRowsForTenant(supabase, tenantId, entityId);
        if (!found) {
          return res.status(400).json({ error: 'Invalid invoice key' });
        }
        if (found.bookings.length === 0 && found.transactions.length === 0) {
          return res.status(404).json({ error: 'Invoice not found for this tenant' });
        }
        const trimmedPO = purchaseOrderNumber.trim();

        // Update every constituent row, but only when the local PO column is
        // still empty so we never clobber a manually-entered value.
        let bookingsUpdated = 0;
        if (found.bookings.length > 0) {
          const ids = found.bookings.map((b) => b.id);
          const { data: updated, error: bErr } = await supabase
            .from('booking')
            .update({ purchase_order_number: trimmedPO, po_to_follow: false })
            .in('id', ids)
            .or('purchase_order_number.is.null,purchase_order_number.eq.')
            .select('id');
          if (bErr) {
            console.error('[PendingPO] Invoice update_po booking error:', bErr);
            return res.status(500).json({ error: 'Failed to update bookings' });
          }
          bookingsUpdated = updated?.length || 0;
        }
        let transactionsUpdated = 0;
        if (found.transactions.length > 0) {
          const ids = found.transactions.map((t) => t.id);
          const { data: updated, error: tErr } = await supabase
            .from('program_ticket_transaction')
            .update({ purchase_order_number: trimmedPO })
            .in('id', ids)
            .or('purchase_order_number.is.null,purchase_order_number.eq.')
            .select('id');
          if (tErr) {
            console.error('[PendingPO] Invoice update_po transaction error:', tErr);
            return res.status(500).json({ error: 'Failed to update transactions' });
          }
          transactionsUpdated = updated?.length || 0;
        }

        let xeroUpdated = false;
        let xeroError = null;
        if (found.xeroInvoiceId) {
          const result = await pushPurchaseOrderToXero({
            appTenantId: tenantId,
            xeroInvoiceId: found.xeroInvoiceId,
            purchaseOrderNumber: trimmedPO,
            contextLabel: `PendingPO invoice ${entityId}`,
          });
          xeroUpdated = result.xeroUpdated;
          xeroError = result.xeroError;
        } else {
          xeroError = 'No Xero invoice ID on file — could not push PO to Xero';
        }

        return res.json({
          success: true,
          purchase_order_number: trimmedPO,
          bookingsUpdated,
          transactionsUpdated,
          xeroUpdated,
          xeroError,
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
        const { xeroUpdated, xeroError } = await pushPurchaseOrderToXero({
          appTenantId: tenantId,
          xeroInvoiceId: existingRecord.xero_invoice_id,
          purchaseOrderNumber: trimmedPO,
          contextLabel: `PendingPO ${entityType} ${entityId}`,
        });

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

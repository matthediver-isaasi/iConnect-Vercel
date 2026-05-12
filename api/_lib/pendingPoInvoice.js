import { supabase as defaultSupabase } from './database.js';
import { pushPurchaseOrderToXero } from './xero.js';

export function parseInvoiceKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('id:')) return { xeroInvoiceId: key.slice(3) };
  if (key.startsWith('num:')) return { xeroInvoiceNumber: key.slice(4) };
  return null;
}

// Paginate through a Supabase query in PAGE_SIZE chunks. Supabase JS caps a
// single response at 1000 rows by default, which is what historically caused
// the helper to silently miss tenant members (and therefore null-org bookings)
// for tenants with many members. Mirrors the report's GET-path behaviour.
const PAGE_SIZE = 1000;
async function fetchAllPages(label, invoiceKey, buildQuery) {
  const all = [];
  let from = 0;
  let pageCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error(
        `[PendingPO] helper paginate error label=${label} invoiceKey=${invoiceKey} page=${pageCount}: ${error.message}`,
      );
      throw new Error(`Failed to load ${label}: ${error.message}`);
    }
    pageCount += 1;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export async function findInvoiceRowsForTenant(client, tenantId, invoiceKey) {
  const parsed = parseInvoiceKey(invoiceKey);
  if (!parsed) return null;

  // 1. All organisations in this tenant (paginated).
  let tenantOrgs;
  try {
    tenantOrgs = await fetchAllPages('organization', invoiceKey, () => client
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true }));
  } catch (err) {
    console.error(`[PendingPO] organization lookup failed for tenant ${tenantId} invoiceKey=${invoiceKey}: ${err.message}`);
    throw err;
  }
  const tenantOrgIds = tenantOrgs.map((o) => o.id);
  const orgNameById = new Map(tenantOrgs.map((o) => [o.id, o.name]));
  if (tenantOrgIds.length === 0) {
    return { bookings: [], transactions: [], xeroInvoiceId: null, xeroInvoiceNumber: null, orgNameById };
  }

  // 2. All members of those organisations (paginated). Required for the
  // null-org booking fallback that the report uses, and now also for the
  // transactions fallback so the helper can resolve any row the report shows.
  let tenantMembers;
  try {
    tenantMembers = await fetchAllPages('member', invoiceKey, () => client
      .from('member')
      .select('id')
      .in('organization_id', tenantOrgIds)
      .order('id', { ascending: true }));
  } catch (err) {
    console.error(`[PendingPO] member lookup failed for tenant ${tenantId} invoiceKey=${invoiceKey}: ${err.message}`);
    throw err;
  }
  const tenantMemberIds = tenantMembers.map((m) => m.id);

  const matchInvoice = (q) => {
    if (parsed.xeroInvoiceId) return q.eq('xero_invoice_id', parsed.xeroInvoiceId);
    return q.eq('xero_invoice_number', parsed.xeroInvoiceNumber);
  };

  // 3. Bookings whose own organization_id is in the tenant.
  let bookingsOrgRows;
  try {
    bookingsOrgRows = await fetchAllPages('booking (org-bound)', invoiceKey, () => matchInvoice(
      client
        .from('booking')
        .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, number_of_tickets, created_at, purchase_order_number')
        .in('organization_id', tenantOrgIds)
        .neq('status', 'cancelled')
        .order('id', { ascending: true }),
    ));
  } catch (err) {
    throw err;
  }

  // 4. Bookings with org_id IS NULL whose member belongs to a tenant org.
  // Iterate the member id list in 500-id chunks (matching the report) so the
  // .in() filter never gets unwieldy, and paginate each chunk's results.
  const MEMBER_CHUNK = 500;
  const bookingsByMember = [];
  if (tenantMemberIds.length > 0) {
    for (let i = 0; i < tenantMemberIds.length; i += MEMBER_CHUNK) {
      const chunk = tenantMemberIds.slice(i, i + MEMBER_CHUNK);
      const rows = await fetchAllPages(`booking (null-org member chunk ${i / MEMBER_CHUNK})`, invoiceKey, () => matchInvoice(
        client
          .from('booking')
          .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, number_of_tickets, created_at, purchase_order_number')
          .is('organization_id', null)
          .in('member_id', chunk)
          .neq('status', 'cancelled')
          .order('id', { ascending: true }),
      ));
      bookingsByMember.push(...rows);
    }
  }

  const seenBooking = new Set();
  const bookings = [...bookingsOrgRows, ...bookingsByMember].filter((b) => {
    if (seenBooking.has(b.id)) return false;
    seenBooking.add(b.id);
    return true;
  });

  // 5. Transactions whose own organization_id is in the tenant.
  let transactionsByOrg;
  try {
    transactionsByOrg = await fetchAllPages('transaction (org-bound)', invoiceKey, () => matchInvoice(
      client
        .from('program_ticket_transaction')
        .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, member_email, program_ticket_id, amount, quantity, created_date, purchase_order_number')
        .in('organization_id', tenantOrgIds)
        .eq('transaction_type', 'purchase')
        .neq('status', 'cancelled')
        .order('id', { ascending: true }),
    ));
  } catch (err) {
    throw err;
  }

  // 6. Transactions with org_id IS NULL whose member belongs to a tenant org.
  // Mirrors the booking null-org fallback so any row visible in the report
  // (or that becomes visible if the report later widens its scope) is findable.
  const transactionsByMember = [];
  if (tenantMemberIds.length > 0) {
    for (let i = 0; i < tenantMemberIds.length; i += MEMBER_CHUNK) {
      const chunk = tenantMemberIds.slice(i, i + MEMBER_CHUNK);
      const rows = await fetchAllPages(`transaction (null-org member chunk ${i / MEMBER_CHUNK})`, invoiceKey, () => matchInvoice(
        client
          .from('program_ticket_transaction')
          .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, member_email, program_ticket_id, amount, quantity, created_date, purchase_order_number')
          .is('organization_id', null)
          .in('member_id', chunk)
          .eq('transaction_type', 'purchase')
          .neq('status', 'cancelled')
          .order('id', { ascending: true }),
      ));
      transactionsByMember.push(...rows);
    }
  }

  const seenTx = new Set();
  const transactions = [...transactionsByOrg, ...transactionsByMember].filter((t) => {
    if (seenTx.has(t.id)) return false;
    seenTx.add(t.id);
    return true;
  });

  const firstWithId = bookings.find((b) => b.xero_invoice_id) || transactions.find((t) => t.xero_invoice_id);
  const xeroInvoiceId = parsed.xeroInvoiceId || firstWithId?.xero_invoice_id || null;
  const firstWithNum = bookings.find((b) => b.xero_invoice_number) || transactions.find((t) => t.xero_invoice_number);
  const xeroInvoiceNumber = parsed.xeroInvoiceNumber || firstWithNum?.xero_invoice_number || null;

  return {
    bookings,
    transactions,
    xeroInvoiceId,
    xeroInvoiceNumber,
    orgNameById,
  };
}

export async function applyInvoicePoUpdate({
  client = defaultSupabase,
  tenantId,
  invoiceKey,
  purchaseOrderNumber,
  contextLabel,
}) {
  const trimmedPO = (purchaseOrderNumber || '').trim();
  if (!trimmedPO) {
    return { ok: false, status: 400, error: 'Purchase order number required' };
  }

  let found;
  try {
    found = await findInvoiceRowsForTenant(client, tenantId, invoiceKey);
  } catch (err) {
    return { ok: false, status: 500, error: err.message || 'Failed to look up invoice rows' };
  }
  if (!found) {
    return { ok: false, status: 400, error: 'Invalid invoice key' };
  }
  if (found.bookings.length === 0 && found.transactions.length === 0) {
    return { ok: false, status: 404, error: 'Invoice not found for this tenant' };
  }

  const alreadyHasPo =
    found.bookings.some((b) => b.purchase_order_number && b.purchase_order_number.trim()) ||
    found.transactions.some((t) => t.purchase_order_number && t.purchase_order_number.trim());

  let bookingsUpdated = 0;
  if (found.bookings.length > 0) {
    const ids = found.bookings.map((b) => b.id);
    const { data: updated, error: bErr } = await client
      .from('booking')
      .update({ purchase_order_number: trimmedPO, po_to_follow: false })
      .in('id', ids)
      .or('purchase_order_number.is.null,purchase_order_number.eq.')
      .select('id');
    if (bErr) {
      console.error(`[PendingPO] applyInvoicePoUpdate booking update failed invoiceKey=${invoiceKey}: ${bErr.message}`);
      return { ok: false, status: 500, error: 'Failed to update bookings' };
    }
    bookingsUpdated = updated?.length || 0;
  }

  let transactionsUpdated = 0;
  if (found.transactions.length > 0) {
    const ids = found.transactions.map((t) => t.id);
    const { data: updated, error: tErr } = await client
      .from('program_ticket_transaction')
      .update({ purchase_order_number: trimmedPO })
      .in('id', ids)
      .or('purchase_order_number.is.null,purchase_order_number.eq.')
      .select('id');
    if (tErr) {
      console.error(`[PendingPO] applyInvoicePoUpdate transaction update failed invoiceKey=${invoiceKey}: ${tErr.message}`);
      return { ok: false, status: 500, error: 'Failed to update transactions' };
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
      contextLabel: contextLabel || `PendingPO invoice ${invoiceKey}`,
    });
    xeroUpdated = result.xeroUpdated;
    xeroError = result.xeroError;
  } else {
    xeroError = 'No Xero invoice ID on file — could not push PO to Xero';
  }

  return {
    ok: true,
    purchase_order_number: trimmedPO,
    bookingsUpdated,
    transactionsUpdated,
    xeroUpdated,
    xeroError,
    alreadyHasPo,
    found,
  };
}

export async function summariseInvoice(client, tenantId, invoiceKey) {
  let found;
  try {
    found = await findInvoiceRowsForTenant(client, tenantId, invoiceKey);
  } catch (err) {
    console.error(`[PendingPO] summariseInvoice lookup failed tenant=${tenantId} invoiceKey=${invoiceKey}: ${err.message}`);
    throw err;
  }
  if (!found || (found.bookings.length === 0 && found.transactions.length === 0)) {
    return null;
  }

  let totalCost = 0;
  let earliestDate = null;
  let quantity = 0;
  const orgIds = new Set();
  const sourceNames = new Set();
  const sourceTypes = new Set();
  const eventIds = new Set();
  const programTicketIds = new Set();
  const bookerEmails = [];
  const seenBookerEmails = new Set();
  const bookerMemberIds = new Set();
  let existingPoNumber = null;

  const addBookerEmail = (email) => {
    if (!email) return;
    const e = String(email).trim().toLowerCase();
    if (!e || seenBookerEmails.has(e)) return;
    seenBookerEmails.add(e);
    bookerEmails.push(String(email).trim());
  };

  for (const b of found.bookings) {
    totalCost += Number(b.total_cost) || 0;
    quantity += Number(b.number_of_tickets) || 0;
    if (b.created_at && (!earliestDate || new Date(b.created_at) < new Date(earliestDate))) {
      earliestDate = b.created_at;
    }
    if (b.organization_id) orgIds.add(b.organization_id);
    if (b.event_id) eventIds.add(b.event_id);
    addBookerEmail(b.attendee_email);
    if (b.member_id) bookerMemberIds.add(b.member_id);
    if (!existingPoNumber && b.purchase_order_number && b.purchase_order_number.trim()) {
      existingPoNumber = b.purchase_order_number.trim();
    }
  }
  for (const t of found.transactions) {
    totalCost += Number(t.amount) || 0;
    quantity += Number(t.quantity) || 0;
    if (t.created_date && (!earliestDate || new Date(t.created_date) < new Date(earliestDate))) {
      earliestDate = t.created_date;
    }
    if (t.organization_id) orgIds.add(t.organization_id);
    if (t.program_ticket_id) programTicketIds.add(t.program_ticket_id);
    addBookerEmail(t.member_email);
    if (t.member_id) bookerMemberIds.add(t.member_id);
    if (!existingPoNumber && t.purchase_order_number && t.purchase_order_number.trim()) {
      existingPoNumber = t.purchase_order_number.trim();
    }
  }

  const bookerNames = [];
  if (bookerMemberIds.size > 0) {
    const { data: members, error: bookerMembersErr } = await client
      .from('member')
      .select('id, first_name, last_name, email, organization_id')
      .in('id', Array.from(bookerMemberIds));
    if (bookerMembersErr) {
      console.error(`[PendingPO] summariseInvoice booker member lookup failed invoiceKey=${invoiceKey}: ${bookerMembersErr.message}`);
    }
    (members || []).forEach((m) => {
      const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
      if (name && !bookerNames.includes(name)) bookerNames.push(name);
      addBookerEmail(m.email);
      // For null-org rows, fall back to the booker's organisation so the
      // recipient lookup downstream can still resolve a primary contact.
      if (m.organization_id) orgIds.add(m.organization_id);
    });
  }

  if (eventIds.size > 0) {
    const { data: events, error: eventsErr } = await client
      .from('event')
      .select('id, title')
      .in('id', Array.from(eventIds));
    if (eventsErr) {
      console.error(`[PendingPO] summariseInvoice event lookup failed invoiceKey=${invoiceKey}: ${eventsErr.message}`);
    }
    (events || []).forEach((e) => {
      if (e.title) {
        sourceNames.add(e.title);
        sourceTypes.add('Event');
      }
    });
  }
  if (programTicketIds.size > 0) {
    const { data: tickets, error: ticketsErr } = await client
      .from('program_ticket')
      .select('id, name, program:program_id(name)')
      .in('id', Array.from(programTicketIds));
    if (ticketsErr) {
      console.error(`[PendingPO] summariseInvoice ticket lookup failed invoiceKey=${invoiceKey}: ${ticketsErr.message}`);
    }
    (tickets || []).forEach((t) => {
      const name = t.program?.name || t.name;
      if (name) {
        sourceNames.add(name);
        sourceTypes.add('Program');
      }
    });
  }

  let organizationName = null;
  // Prefer a tenant-scoped org id (one we already know belongs to the tenant)
  // over an arbitrary booker-org fallback.
  const tenantScopedOrgId = Array.from(orgIds).find((id) => found.orgNameById?.has?.(id)) || null;
  const firstOrgId = tenantScopedOrgId || Array.from(orgIds)[0];
  if (firstOrgId) {
    organizationName = found.orgNameById?.get?.(firstOrgId) || null;
    if (!organizationName) {
      const { data: orgRow, error: orgErr } = await client
        .from('organization')
        .select('name')
        .eq('id', firstOrgId)
        .single();
      if (orgErr) {
        console.error(`[PendingPO] summariseInvoice org lookup failed invoiceKey=${invoiceKey} orgId=${firstOrgId}: ${orgErr.message}`);
      }
      organizationName = orgRow?.name || null;
    }
  }

  const sourceNameList = Array.from(sourceNames);
  const sourceTypeList = Array.from(sourceTypes);
  const sourceName = sourceNameList.length === 0
    ? null
    : sourceNameList.length === 1
      ? sourceNameList[0]
      : `${sourceNameList.length} items`;
  const sourceType = sourceTypeList.length === 1 ? sourceTypeList[0] : (sourceTypeList.length > 1 ? 'Mixed' : null);

  const bookerNameDisplay = bookerNames.length === 0
    ? null
    : bookerNames.length <= 2
      ? bookerNames.join(', ')
      : `${bookerNames.slice(0, 2).join(', ')} +${bookerNames.length - 2} more`;

  return {
    organizationName,
    organizationId: firstOrgId || null,
    invoiceNumber: found.xeroInvoiceNumber,
    xeroInvoiceId: found.xeroInvoiceId,
    invoiceDate: earliestDate,
    totalCost,
    quantity,
    sourceName,
    sourceType,
    existingPoNumber,
    bookerEmails,
    bookerNames,
    bookerNameDisplay,
    rowCount: found.bookings.length + found.transactions.length,
  };
}

// No-op kept for call-site compatibility. Schema is owned by the migration in
// supabase/migrations/20260512_create_pending_po_token.sql — if the table is
// missing the caller will get a hard DB error, which is preferred over silent
// runtime DDL.
export async function ensurePendingPoTokenTable() {
  return;
}

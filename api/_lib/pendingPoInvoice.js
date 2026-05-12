import { supabase as defaultSupabase } from './database.js';
import { pushPurchaseOrderToXero } from './xero.js';

export function parseInvoiceKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('id:')) return { xeroInvoiceId: key.slice(3) };
  if (key.startsWith('num:')) return { xeroInvoiceNumber: key.slice(4) };
  return null;
}

export async function findInvoiceRowsForTenant(client, tenantId, invoiceKey) {
  const parsed = parseInvoiceKey(invoiceKey);
  if (!parsed) return null;

  const { data: tenantOrgs } = await client
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);
  const tenantOrgIds = (tenantOrgs || []).map((o) => o.id);
  const orgNameById = new Map((tenantOrgs || []).map((o) => [o.id, o.name]));
  if (tenantOrgIds.length === 0) {
    return { bookings: [], transactions: [], xeroInvoiceId: null, xeroInvoiceNumber: null, orgNameById };
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

  const firstWithId = bookings.find((b) => b.xero_invoice_id) || (transactions || []).find((t) => t.xero_invoice_id);
  const xeroInvoiceId = parsed.xeroInvoiceId || firstWithId?.xero_invoice_id || null;
  const firstWithNum = bookings.find((b) => b.xero_invoice_number) || (transactions || []).find((t) => t.xero_invoice_number);
  const xeroInvoiceNumber = parsed.xeroInvoiceNumber || firstWithNum?.xero_invoice_number || null;

  return {
    bookings: bookings || [],
    transactions: transactions || [],
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

  const found = await findInvoiceRowsForTenant(client, tenantId, invoiceKey);
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
  const found = await findInvoiceRowsForTenant(client, tenantId, invoiceKey);
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
    totalCost += Number(b.total) || 0;
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
    const { data: members } = await client
      .from('member')
      .select('id, first_name, last_name, email')
      .in('id', Array.from(bookerMemberIds));
    (members || []).forEach((m) => {
      const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
      if (name && !bookerNames.includes(name)) bookerNames.push(name);
      addBookerEmail(m.email);
    });
  }

  if (eventIds.size > 0) {
    const { data: events } = await client
      .from('event')
      .select('id, title')
      .in('id', Array.from(eventIds));
    (events || []).forEach((e) => {
      if (e.title) {
        sourceNames.add(e.title);
        sourceTypes.add('Event');
      }
    });
  }
  if (programTicketIds.size > 0) {
    const { data: tickets } = await client
      .from('program_ticket')
      .select('id, name, program:program_id(name)')
      .in('id', Array.from(programTicketIds));
    (tickets || []).forEach((t) => {
      const name = t.program?.name || t.name;
      if (name) {
        sourceNames.add(name);
        sourceTypes.add('Program');
      }
    });
  }

  let organizationName = null;
  const firstOrgId = Array.from(orgIds)[0];
  if (firstOrgId) {
    organizationName = found.orgNameById?.get?.(firstOrgId) || null;
    if (!organizationName) {
      const { data: orgRow } = await client
        .from('organization')
        .select('name')
        .eq('id', firstOrgId)
        .single();
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
    organizationId: Array.from(orgIds)[0] || null,
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

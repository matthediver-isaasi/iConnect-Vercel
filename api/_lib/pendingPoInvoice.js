import crypto from 'crypto';
import { supabase as defaultSupabase } from './database.js';
import { getAccountingProvider } from './accountingProvider.js';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

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
      .select('id, email')
      .in('organization_id', tenantOrgIds)
      .order('id', { ascending: true }));
  } catch (err) {
    console.error(`[PendingPO] member lookup failed for tenant ${tenantId} invoiceKey=${invoiceKey}: ${err.message}`);
    throw err;
  }
  const tenantMemberIds = tenantMembers.map((m) => m.id);
  const tenantMemberEmails = tenantMembers
    .map((m) => (m.email ? String(m.email).trim().toLowerCase() : ''))
    .filter((e) => e.length > 0);

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
        .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, created_at, purchase_order_number')
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
          .select('id, organization_id, member_id, xero_invoice_id, xero_invoice_number, attendee_email, event_id, total_cost, created_at, purchase_order_number')
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
        .select('id, organization_id, xero_invoice_id, xero_invoice_number, member_email, program_name, total_cost_before_discount, quantity, created_date, purchase_order_number')
        .in('organization_id', tenantOrgIds)
        .eq('transaction_type', 'purchase')
        .neq('status', 'cancelled')
        .order('id', { ascending: true }),
    ));
  } catch (err) {
    throw err;
  }

  // 6. Transactions with org_id IS NULL whose member belongs to a tenant org.
  // The transaction table identifies the buyer by member_email (no member_id
  // column), so the null-org fallback matches against the tenant members'
  // email addresses, mirroring the booking null-org fallback in shape.
  const transactionsByMember = [];
  if (tenantMemberEmails.length > 0) {
    for (let i = 0; i < tenantMemberEmails.length; i += MEMBER_CHUNK) {
      const chunk = tenantMemberEmails.slice(i, i + MEMBER_CHUNK);
      const rows = await fetchAllPages(`transaction (null-org member chunk ${i / MEMBER_CHUNK})`, invoiceKey, () => matchInvoice(
        client
          .from('program_ticket_transaction')
          .select('id, organization_id, xero_invoice_id, xero_invoice_number, member_email, program_name, total_cost_before_discount, quantity, created_date, purchase_order_number')
          .is('organization_id', null)
          .in('member_email', chunk)
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
  const bookingIdsToUpdate = found.bookings
    .filter((b) => !b.purchase_order_number || !b.purchase_order_number.trim())
    .map((b) => b.id);
  if (bookingIdsToUpdate.length > 0) {
    const ids = bookingIdsToUpdate;
    const { data: updated, error: bErr } = await client
      .from('booking')
      .update({ purchase_order_number: trimmedPO, po_to_follow: false })
      .in('id', ids)
      .select('id');
    if (bErr) {
      console.error(
        `[PendingPO] applyInvoicePoUpdate booking update failed tenantId=${tenantId} invoiceKey=${invoiceKey} bookingIds=${JSON.stringify(ids)}:`,
        { message: bErr.message, details: bErr.details, hint: bErr.hint, code: bErr.code },
      );
      const detail = [bErr.message, bErr.code ? `code ${bErr.code}` : null, bErr.hint, bErr.details]
        .filter(Boolean)
        .join(' — ');
      return {
        ok: false,
        status: 500,
        error: `Failed to update bookings: ${detail || 'unknown database error'}`,
      };
    }
    bookingsUpdated = updated?.length || 0;
  }

  let transactionsUpdated = 0;
  const transactionIdsToUpdate = found.transactions
    .filter((t) => !t.purchase_order_number || !t.purchase_order_number.trim())
    .map((t) => t.id);
  if (transactionIdsToUpdate.length > 0) {
    const ids = transactionIdsToUpdate;
    const { data: updated, error: tErr } = await client
      .from('program_ticket_transaction')
      .update({ purchase_order_number: trimmedPO })
      .in('id', ids)
      .select('id');
    if (tErr) {
      console.error(
        `[PendingPO] applyInvoicePoUpdate transaction update failed tenantId=${tenantId} invoiceKey=${invoiceKey} transactionIds=${JSON.stringify(ids)}:`,
        { message: tErr.message, details: tErr.details, hint: tErr.hint, code: tErr.code },
      );
      const detail = [tErr.message, tErr.code ? `code ${tErr.code}` : null, tErr.hint, tErr.details]
        .filter(Boolean)
        .join(' — ');
      return {
        ok: false,
        status: 500,
        error: `Failed to update transactions: ${detail || 'unknown database error'}`,
      };
    }
    transactionsUpdated = updated?.length || 0;
  }

  let xeroUpdated = false;
  let xeroError = null;
  if (found.xeroInvoiceId) {
    try {
      const provider = await getAccountingProvider(tenantId);
      const result = await provider.pushPurchaseOrder({
        appTenantId: tenantId,
        xeroInvoiceId: found.xeroInvoiceId,
        purchaseOrderNumber: trimmedPO,
        contextLabel: contextLabel || `PendingPO invoice ${invoiceKey}`,
      });
      xeroUpdated = result.xeroUpdated;
      xeroError = result.xeroError;
    } catch (provErr) {
      xeroError = provErr.message;
    }
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
    quantity += 1;
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
  const bookerEmailsForLookup = new Set();
  for (const t of found.transactions) {
    totalCost += Number(t.total_cost_before_discount) || 0;
    quantity += Number(t.quantity) || 0;
    if (t.created_date && (!earliestDate || new Date(t.created_date) < new Date(earliestDate))) {
      earliestDate = t.created_date;
    }
    if (t.organization_id) orgIds.add(t.organization_id);
    if (t.program_name && String(t.program_name).trim()) {
      sourceNames.add(String(t.program_name).trim());
      sourceTypes.add('Program');
    }
    addBookerEmail(t.member_email);
    // program_ticket_transaction has no member_id column — the buyer is
    // identified by member_email. Resolve the booker member via the email
    // lookup below so booker names and the org fallback still populate.
    if (t.member_email) {
      const e = String(t.member_email).trim().toLowerCase();
      if (e) bookerEmailsForLookup.add(e);
    }
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
  if (bookerEmailsForLookup.size > 0) {
    const emailList = Array.from(bookerEmailsForLookup);
    const tenantOrgIds = Array.from(found.orgNameById?.keys?.() || []);
    let txMembersQuery = client
      .from('member')
      .select('id, first_name, last_name, email, organization_id')
      .in('email', emailList);
    // Constrain to this tenant's organisations so duplicate emails on
    // members in unrelated tenants can't pollute booker name/org fallback.
    if (tenantOrgIds.length > 0) {
      txMembersQuery = txMembersQuery.in('organization_id', tenantOrgIds);
    }
    const { data: txMembers, error: txMembersErr } = await txMembersQuery;
    if (txMembersErr) {
      console.error(`[PendingPO] summariseInvoice transaction booker lookup failed invoiceKey=${invoiceKey}: ${txMembersErr.message}`);
    }
    (txMembers || []).forEach((m) => {
      const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
      if (name && !bookerNames.includes(name)) bookerNames.push(name);
      addBookerEmail(m.email);
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

// Resolve the personalised greeting name for a PO reminder email. Fallback
// chain: organisation primary-contact name -> booker name -> organisation
// name -> a neutral default. Deterministic from the (tenant-scoped) summary so
// the previewed greeting matches the email that is actually sent.
export async function resolveReminderGreetingName(client, summary) {
  let name = null;
  if (summary?.organizationId) {
    const { data, error } = await client
      .from('member')
      .select('first_name, last_name')
      .eq('organization_id', summary.organizationId)
      .eq('is_primary_contact', true)
      .limit(1);
    if (error) {
      console.error(`[PendingPO] resolveReminderGreetingName primary-contact lookup failed orgId=${summary.organizationId}: ${error.message}`);
    }
    const contact = data?.[0];
    if (contact) {
      const nm = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
      if (nm) name = nm;
    }
  }
  if (!name && Array.isArray(summary?.bookerNames) && summary.bookerNames.length > 0) {
    name = summary.bookerNames[0];
  }
  if (!name) {
    name = summary?.organizationName || 'your organisation';
  }
  return name;
}

// Compute the consolidated list of invoices still awaiting a PO number for a
// tenant. This is the single source of truth shared by the report's GET handler
// and the scheduled reminder cron. It returns one entry per Xero invoice (keyed
// by `id:`/`num:`), each carrying its invoice key (`id`) and earliest created
// date (`created_date`). Mirrors the report's filters: org-scoped
// bookings/transactions filtered by account payment / po_to_follow, with a Xero
// paid/voided status check that drops voided invoices and backfills PO numbers
// already present in Xero.
// Default cadence settings, mirrored from the reminder settings UI/cron.
export const PO_REMINDER_DEFAULTS = {
  sendAfterDays: 7,
  repeatEveryDays: 7,
  maxSends: 3,
};

// Whole-day difference between two dates measured in UTC calendar days, so the
// timing checks are independent of server timezone.
export function utcDaysBetween(earlier, later) {
  const a = Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate());
  const b = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  return Math.floor((b - a) / 86400000);
}

// Normalise a positive-integer setting, falling back when invalid.
export function toPositiveIntSetting(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : fallback;
}

// Pure, shared reminder-schedule evaluation used by BOTH the daily cron (to
// decide whether to send today) and the report GET (to show the next reminder
// date per invoice). Keeping it in one place means the date shown on the report
// can never disagree with the day the cron actually fires.
//
// Returns:
//   {
//     remindersSent: number,        // prior send count
//     status: 'scheduled' | 'max_reached' | 'no_days',
//     nextReminderAt: Date | null,  // next eligible UTC send date (>= today)
//     dueToday: boolean,            // nextReminderAt is today (cron should send)
//   }
export function evaluateReminderSchedule({
  reminderDays,
  sendAfterDays,
  repeatEveryDays,
  maxSends,
  createdDate,
  now = new Date(),
  priorCount = 0,
  lastSentAt = null,
}) {
  const days = Array.isArray(reminderDays)
    ? reminderDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  const repeat = toPositiveIntSetting(repeatEveryDays, PO_REMINDER_DEFAULTS.repeatEveryDays);
  const after = toPositiveIntSetting(sendAfterDays, PO_REMINDER_DEFAULTS.sendAfterDays);
  const cap = toPositiveIntSetting(maxSends, PO_REMINDER_DEFAULTS.maxSends);

  const base = {
    remindersSent: priorCount,
    status: 'scheduled',
    nextReminderAt: null,
    dueToday: false,
  };

  // No weekdays selected -> automatic reminders are off.
  if (days.length === 0) {
    return { ...base, status: 'no_days' };
  }

  // Reached the per-invoice cap -> nothing more will be sent.
  if (priorCount >= cap) {
    return { ...base, status: 'max_reached' };
  }

  const created = createdDate ? new Date(createdDate) : null;
  if (!created || Number.isNaN(created.getTime())) {
    // Without a usable created date the cron skips it; not schedulable.
    return base;
  }

  const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

  // Earliest UTC calendar date eligibility is met:
  //  - first send: created + sendAfterDays
  //  - subsequent: lastSent + repeatEveryDays
  let earliest;
  if (priorCount > 0 && lastSentAt) {
    earliest = startOfUtcDay(new Date(lastSentAt));
    earliest.setUTCDate(earliest.getUTCDate() + repeat);
  } else {
    earliest = startOfUtcDay(created);
    earliest.setUTCDate(earliest.getUTCDate() + after);
  }

  const today = startOfUtcDay(now);
  // The cron only fires from today onwards; never show a past date.
  let candidate = earliest.getTime() < today.getTime() ? today : earliest;

  // Walk forward to the first selected weekday on/after the candidate.
  for (let i = 0; i < 371; i++) {
    if (days.includes(candidate.getUTCDay())) {
      return {
        remindersSent: priorCount,
        status: 'scheduled',
        nextReminderAt: candidate,
        dueToday: candidate.getTime() === today.getTime(),
      };
    }
    candidate = new Date(candidate.getTime() + 86400000);
  }

  return base;
}

export async function computePendingPoInvoices({ client = defaultSupabase, tenantId }) {
  const empty = {
    records: [],
    orgMap: {},
    xeroCheckPerformed: false,
    xeroError: null,
    totalBeforeFilter: 0,
    paidInXero: 0,
    voidedExcluded: 0,
    xeroPoExcluded: 0,
    xeroPoBackfilled: 0,
    pagination: {},
  };

  const { data: tenantOrgs, error: orgsError } = await client
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);

  if (orgsError) {
    console.error('[PendingPO] computePendingPoInvoices org fetch error:', orgsError);
    throw new Error(`Failed to fetch organizations: ${orgsError.message}`);
  }

  const orgMap = {};
  const tenantOrgIds = (tenantOrgs || []).map((o) => {
    orgMap[o.id] = o.name;
    return o.id;
  });

  if (tenantOrgIds.length === 0) {
    return empty;
  }

  const PAGE_SIZE = 1000;
  const paginationStats = {};
  const fetchAllPages = async (label, buildQuery) => {
    const all = [];
    let from = 0;
    let pageCount = 0;
    // eslint-disable-next-line no-constant-condition
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
    paginationStats[label] = { pagesFetched: pageCount, scannedRows: all.length };
    return all;
  };

  const HAS_INVOICE_OR = 'xero_invoice_id.not.is.null,xero_invoice_number.not.is.null';
  const MISSING_PO_OR = 'purchase_order_number.is.null,purchase_order_number.eq.';

  const transactions = await fetchAllPages('program_ticket_transaction', () => client
    .from('program_ticket_transaction')
    .select('id, organization_id, program_name, xero_invoice_id, xero_invoice_number, xero_invoice_pdf_uri, created_date, quantity, total_cost_before_discount, member_email, transaction_type, status, purchase_order_number')
    .in('organization_id', tenantOrgIds)
    .eq('transaction_type', 'purchase')
    .neq('status', 'cancelled')
    .or(HAS_INVOICE_OR)
    .or(MISSING_PO_OR)
    .order('id', { ascending: true }));

  const bookingsWithOrg = await fetchAllPages('booking (with org)', () => client
    .from('booking')
    .select('id, organization_id, member_id, event_id, xero_invoice_id, xero_invoice_number, created_at, ticket_price, attendee_email, payment_method, status, purchase_order_number, po_to_follow, booking_group_reference')
    .in('organization_id', tenantOrgIds)
    .neq('status', 'cancelled')
    .or('payment_method.eq.account,po_to_follow.eq.true')
    .or(HAS_INVOICE_OR)
    .or(MISSING_PO_OR)
    .order('id', { ascending: true }));

  let membersInTenant = [];
  try {
    membersInTenant = await fetchAllPages('member (tenant org members)', () => client
      .from('member')
      .select('id, organization_id')
      .in('organization_id', tenantOrgIds)
      .order('id', { ascending: true }));
  } catch (memberError) {
    membersInTenant = [];
  }

  const memberIdsInTenant = membersInTenant.map((m) => m.id);

  const bookingsWithNullOrg = [];
  if (memberIdsInTenant.length > 0) {
    const MEMBER_CHUNK = 500;
    try {
      for (let i = 0; i < memberIdsInTenant.length; i += MEMBER_CHUNK) {
        const memberChunk = memberIdsInTenant.slice(i, i + MEMBER_CHUNK);
        const chunkRows = await fetchAllPages(`booking (null org, member chunk ${i / MEMBER_CHUNK})`, () => client
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

  const existingBookingIds = new Set((bookingsWithOrg || []).map((b) => b.id));
  const bookings = [
    ...(bookingsWithOrg || []),
    ...bookingsWithNullOrg.filter((b) => !existingBookingIds.has(b.id)),
  ];

  const eventIds = [...new Set((bookings || []).map((b) => b.event_id).filter(Boolean))];
  let eventMap = {};
  if (eventIds.length > 0) {
    const { data: events } = await client
      .from('event')
      .select('id, title')
      .in('id', eventIds);
    eventMap = (events || []).reduce((acc, e) => {
      acc[e.id] = e.title;
      return acc;
    }, {});
  }

  const memberIds = [...new Set((bookings || []).map((b) => b.member_id).filter(Boolean))];
  let memberMap = {};
  if (memberIds.length > 0) {
    const { data: members } = await client
      .from('member')
      .select('id, email, organization_id')
      .in('id', memberIds);
    memberMap = (members || []).reduce((acc, m) => {
      acc[m.id] = m;
      return acc;
    }, {});
  }

  const records = [];

  (transactions || []).forEach((t) => {
    const hasInvoice = (t.xero_invoice_id && t.xero_invoice_id.trim() !== '')
      || (t.xero_invoice_number && t.xero_invoice_number.trim() !== '');
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

  (bookings || []).forEach((b) => {
    const hasInvoice = (b.xero_invoice_id && b.xero_invoice_id.trim() !== '')
      || (b.xero_invoice_number && b.xero_invoice_number.trim() !== '');
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

  let xeroCheckPerformed = false;
  let xeroError = null;
  let paidCount = 0;
  let voidedExcluded = 0;
  let xeroPoBackfilled = 0;
  let xeroPoExcluded = 0;

  const invoiceIdsToCheck = [...new Set(records.map((r) => r.xero_invoice_id).filter(Boolean))];

  if (invoiceIdsToCheck.length > 0) {
    try {
      const _provider = await getAccountingProvider(tenantId);
      const { accessToken, tenantId: xeroTenantId } = await _provider.getRawAccessToken(tenantId);

      const xeroStatusById = new Map();
      const xeroPoById = new Map();
      const batchSize = 50;

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
              Authorization: `Bearer ${accessToken}`,
              'xero-tenant-id': xeroTenantId,
              Accept: 'application/json',
            },
          },
        );

        if (invoiceResponse.ok) {
          const invoiceData = await invoiceResponse.json();
          const invoices = invoiceData.Invoices || [];
          invoices.forEach((inv) => {
            if (inv.InvoiceID) {
              xeroStatusById.set(inv.InvoiceID, inv.Status || null);
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

      records.forEach((r) => {
        if (r.xero_invoice_id && xeroStatusById.has(r.xero_invoice_id)) {
          r.xero_status = xeroStatusById.get(r.xero_invoice_id);
        } else {
          r.xero_status = null;
        }
      });

      for (let i = records.length - 1; i >= 0; i--) {
        const status = records[i].xero_status;
        if (status === 'VOIDED' || status === 'DELETED') {
          records.splice(i, 1);
          voidedExcluded += 1;
        }
      }

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
        const byPo = new Map();
        rows.forEach(({ id, po }) => {
          if (!byPo.has(po)) byPo.set(po, []);
          byPo.get(po).push(id);
        });
        for (const [po, ids] of byPo) {
          const { data: updated, error } = await client
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

      records.forEach((r) => {
        if (r.xero_status === 'PAID') paidCount += 1;
      });

      xeroCheckPerformed = true;
    } catch (xeroErr) {
      console.error('[PendingPO] Xero status check error:', xeroErr.message);
      xeroError = xeroErr.message;
    }
  }

  const totalBeforeFilter = records.length;

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
    delete g._sourceNames;
    delete g._sourceTypes;
    delete g._orgIds;
    consolidatedRecords.push(g);
  });

  paidCount = consolidatedRecords.reduce(
    (n, r) => n + (r.xero_status === 'PAID' ? 1 : 0),
    0,
  );

  return {
    records: consolidatedRecords,
    orgMap,
    xeroCheckPerformed,
    xeroError,
    totalBeforeFilter,
    paidInXero: paidCount,
    voidedExcluded,
    xeroPoExcluded,
    xeroPoBackfilled,
    pagination: paginationStats,
  };
}

// Run all guardrails, resolve recipient, mint a one-time submit-PO token, and
// build the rendered reminder email for an invoice. Shared by the report's
// preview_reminder / send_reminder POST actions and the scheduled reminder cron
// so the email body, recipient resolution and token minting live in one place.
export async function prepareReminderForInvoice({ client = defaultSupabase, tenantId, invoiceKey }) {
  const summary = await summariseInvoice(client, tenantId, invoiceKey);
  if (!summary || summary.rowCount === 0) {
    return { ok: false, status: 404, error: 'Invoice not found for this tenant' };
  }
  if (summary.existingPoNumber) {
    return { ok: false, status: 400, error: 'A purchase order number has already been recorded for this invoice.' };
  }

  // Check if invoice is already paid in Xero before sending/previewing reminder
  if (summary.xeroInvoiceId) {
    try {
      const _provider = await getAccountingProvider(tenantId);
      const { accessToken, tenantId: xeroTenantId } = await _provider.getRawAccessToken(tenantId);
      const invoiceResponse = await fetch(
        `https://api.xero.com/api.xro/2.0/Invoices/${summary.xeroInvoiceId}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'xero-tenant-id': xeroTenantId,
            Accept: 'application/json',
          },
        },
      );
      if (invoiceResponse.ok) {
        const invoiceData = await invoiceResponse.json();
        const invoice = invoiceData.Invoices?.[0];
        if (invoice?.Status === 'PAID') {
          return {
            ok: false,
            status: 400,
            error: 'Cannot send reminder - this invoice has already been paid in Xero',
          };
        }
      }
    } catch (xeroErr) {
      console.error('[PendingPO] Xero check error for reminder:', xeroErr.message);
      // Continue if Xero check fails - we still want to allow manual reminders
    }
  }

  // Resolve recipient: organisation's primary contact, falling back to a booker.
  let recipientEmail = null;
  if (summary.organizationId) {
    const { data: orgContacts } = await client
      .from('member')
      .select('email')
      .eq('organization_id', summary.organizationId)
      .eq('is_primary_contact', true)
      .limit(1);
    recipientEmail = orgContacts?.[0]?.email || null;
  }
  if (!recipientEmail && summary.bookerEmails && summary.bookerEmails.length > 0) {
    recipientEmail = summary.bookerEmails[0];
  }

  if (!recipientEmail) {
    return { ok: false, status: 400, error: 'No recipient email found for this invoice' };
  }

  // Mint a one-time submit-PO token for this invoice
  await ensurePendingPoTokenTable();
  const submitToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const { error: tokenInsertError } = await client
    .from('pending_po_token')
    .insert({
      token: submitToken,
      tenant_id: tenantId,
      invoice_key: invoiceKey,
      status: 'pending',
      recipient_email: recipientEmail,
      expires_at: expiresAt.toISOString(),
    });
  if (tokenInsertError) {
    console.error('[PendingPO] Token insert error:', tokenInsertError);
    return { ok: false, status: 500, error: 'Failed to create submit link' };
  }

  const { data: tenant } = await client
    .from('tenant')
    .select('name, slug, primary_color')
    .eq('id', tenantId)
    .single();

  const tenantSlug = tenant?.slug;
  const tenantName = tenant?.name || 'Organisation';
  const primaryColor = tenant?.primary_color || '#5C0085';
  const submitUrl = tenantSlug
    ? `https://${tenantSlug}.${APP_DOMAIN}/submit-po/${submitToken}`
    : `https://${APP_DOMAIN}/submit-po/${submitToken}`;

  const invoiceDateText = summary.invoiceDate
    ? new Date(summary.invoiceDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'N/A';
  const totalText = `\u00a3${Number(summary.totalCost || 0).toFixed(2)}`;
  const greetingName = await resolveReminderGreetingName(client, summary);
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
              <p style="color: #999; font-size: 12px;">This link expires on ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
            </div>
            <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
          </div>
        `;

  return {
    ok: true,
    recipientEmail,
    subject,
    html,
    submitUrl,
    token: submitToken,
    expiresAt: expiresAt.toISOString(),
  };
}

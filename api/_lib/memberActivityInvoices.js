const ARCHIVE_COLUMNS = 'id,invoice_number,invoice_date,amount_minor,currency,description,record_kind,status,accounting_status,accounting_payment_status,accounting_status_checked_at,accounting_status_error,xero_document_id';
const CURRENT_COLUMNS = 'id,accounting_provider,accounting_invoice_id,accounting_invoice_number,xero_invoice_id,xero_invoice_number,total_with_vat,final_cost,currency,payment_status,paid_at,term_start_date,term_end_date,tier_label';

async function readAll(db, table, columns, tenantId, memberId) {
  const rows = [];
  let expectedCount;
  for (let offset = 0; ; offset += 500) {
    const { data, error, count } = await db.from(table).select(columns, { count: 'exact' })
      .eq('tenant_id', tenantId).eq('member_id', memberId)
      .order('id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isInteger(count)) throw new Error('Incomplete invoice results');
    expectedCount ??= count;
    if (count !== expectedCount) throw new Error('Invoice results changed while loading');
    rows.push(...data);
    if (rows.length === count) return rows;
    if (!data.length || rows.length > count || offset >= 100000) throw new Error('Invoice results changed or exceeded safe limit');
  }
}

function timestamp(value) {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : -Infinity;
}

export function mergeMemberActivityInvoices(archive, history, canAccessInvoices) {
  const records = archive.map(({ accounting_status_error, xero_document_id, ...row }) => ({
    ...row, accounting_status_refresh_pending: Boolean(accounting_status_error),
    can_download: canAccessInvoices && row.record_kind !== 'overpayment',
  }));
  const seen = new Set();
  for (const row of history) {
    const provider = row.accounting_provider || (row.xero_invoice_id ? 'xero' : null);
    const invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
    if (!invoiceId || !provider) continue;
    const number = row.accounting_invoice_number || row.xero_invoice_number || null;
    const key = `${provider}:${invoiceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Archive records are Xero documents. Never suppress a QuickBooks invoice
    // merely because its human-readable number matches an imported Xero number.
    if (provider === 'xero' && archive.some(a => a.record_kind === 'invoice'
      && (a.xero_document_id ? a.xero_document_id === invoiceId
        : number && a.invoice_number === number))) continue;
    const rawAmount = row.total_with_vat ?? row.final_cost;
    const amount = rawAmount == null || rawAmount === '' ? NaN : Number(rawAmount);
    records.push({
      id: row.id, source: 'membership', invoice_number: number,
      // History has no provider invoice date. Never label recovery/creation
      // time as invoice date; show the actual payment or term-start instead.
      invoice_date: null,
      activity_date: row.paid_at || row.term_start_date || null,
      date_label: row.paid_at ? 'Payment date' : row.term_start_date ? 'Membership starts' : 'Date unavailable',
      amount_minor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      currency: row.currency, record_kind: 'invoice',
      description: ['Membership', row.tier_label,
        row.term_start_date && row.term_end_date ? `${row.term_start_date} – ${row.term_end_date}` : null].filter(Boolean).join(' · '),
      status: row.payment_status || 'Unknown',
      can_download: Boolean(canAccessInvoices),
    });
  }
  return records.sort((a, b) => {
    const x = timestamp(a.activity_date || a.invoice_date), y = timestamp(b.activity_date || b.invoice_date);
    return x === y ? `${a.source || 'historical'}:${a.id}`.localeCompare(`${b.source || 'historical'}:${b.id}`) : x > y ? -1 : 1;
  });
}

export async function loadMemberActivityInvoices(db, { tenantId, memberId, canAccessInvoices }) {
  const [archive, current] = await Promise.all([
    readAll(db, 'historical_member_invoice', ARCHIVE_COLUMNS, tenantId, memberId),
    readAll(db, 'member_membership_history', CURRENT_COLUMNS, tenantId, memberId),
  ]);
  const result = mergeMemberActivityInvoices(archive, current, canAccessInvoices);
  let eventInvoices;
  try {
    eventInvoices = await readAll(db, 'public_invoice_po_billing',
      'id,invoice_id,invoice_number,invoice_date,amount,currency,provider,invoice_status,payment_status,checked_at',
      tenantId, memberId);
  } catch (error) {
    if (!['42P01','PGRST205'].includes(error.code)) throw error;
    eventInvoices = [];
  }
  for (const row of eventInvoices) {
    if (!row.invoice_id) continue;
    if (row.provider === 'xero' && archive.some(a => a.xero_document_id === row.invoice_id)) continue;
    result.push({id:`event-invoice:${row.id}`,invoice_number:row.invoice_number,invoice_date:row.invoice_date,
      amount_minor:Math.round(Number(row.amount)*100),currency:row.currency,record_kind:'invoice',
      description:'Event booking invoice',status:row.invoice_status,accounting_status:row.invoice_status,
      accounting_payment_status:row.payment_status,accounting_status_checked_at:row.checked_at,
      can_download:false});
  }
  return result.sort((a,b)=>timestamp(b.activity_date||b.invoice_date)-timestamp(a.activity_date||a.invoice_date)
    || String(a.id).localeCompare(String(b.id)));
}

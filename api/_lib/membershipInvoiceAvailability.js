const messages = {
  missing: 'No invoice is linked to this membership record.',
  pending: 'The invoice request is waiting or being processed.',
  blocked: 'Accounting needs review before this request can complete.',
  unavailable: 'Invoice request status could not be loaded.',
  not_required: 'No invoice is required for this zero-cost membership.',
};

export function membershipInvoiceAvailability(record, request, lookupFailed = false) {
  if (record.accounting_invoice_id || record.xero_invoice_id) return { status: 'linked' };
  let status = 'missing';
  if (lookupFailed) status = 'unavailable';
  else if (request) {
    status = ['review', 'failed', 'unknown', 'cancelled', 'completed', 'complete'].includes(request.state)
      || request.invoice_status === 'failed' || request.link_status === 'failed'
      ? 'blocked' : 'pending';
  } else if (record.accounting_sync_status === 'failed') status = 'blocked';
  else if (record.final_cost != null && Number(record.final_cost) === 0) status = 'not_required';
  return { status, message: messages[status] };
}

export async function attachMembershipInvoiceAvailability(db, tenantId, records) {
  const requests = new Map();
  const ids = records.filter(r => !r.accounting_invoice_id && !r.xero_invoice_id).map(r => r.id);
  let failed = false;
  try {
    for (let start = 0; start < ids.length; start += 100) {
      const { data, error } = await db.from('accounting_request_queue')
        .select('source_id,state,invoice_status,link_status,created_at')
        .eq('tenant_id', tenantId)
        .eq('source_type', 'organisation_membership_history')
        .eq('operation', 'invoice')
        .in('source_id', ids.slice(start, start + 100))
        .order('created_at', { ascending: false });
      if (error) throw error;
      for (const request of data || []) if (!requests.has(request.source_id)) requests.set(request.source_id, request);
    }
  } catch {
    failed = true;
  }
  for (const record of records) {
    record.invoice_availability = membershipInvoiceAvailability(record, requests.get(record.id), failed);
  }
}

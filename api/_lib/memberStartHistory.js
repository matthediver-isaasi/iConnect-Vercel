// A null payment method is not evidence of a free purchase. Only the immutable
// admin Start authority can supply this label (including older zero-price Starts).
export async function attachMemberStartHistory(db, { tenantId, memberId, history, isAdmin = false }) {
  const candidates = history.filter(row => (row.payment_method == null && row.total_with_vat != null && Number(row.total_with_vat) === 0)
    || (isAdmin && row.payment_method === 'invoice'));
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const page = candidates.slice(offset, offset + 100);
    const { data, error } = await db.from('member_membership_start')
      .select('record_id,request,quote').eq('tenant_id', tenantId).eq('member_id', memberId)
      .in('record_id', page.map(row => row.id));
    if (error) {
      if (['42P01', 'PGRST205'].includes(error.code)) return;
      throw error;
    }
    const byId = new Map((data || []).map(row => [row.record_id, row]));
    const invoices = page.filter(row => byId.get(row.id)?.request?.paymentMode === 'invoice'
      && !row.accounting_invoice_id && !row.xero_invoice_id);
    let queue = [];
    let queueUnavailable = false;
    if (invoices.length) {
      const result = await db.from('accounting_request_queue').select('source_id,state')
        .eq('tenant_id', tenantId).eq('source_type', 'member_membership_history').eq('operation', 'invoice')
        .in('source_id', invoices.map(row => row.id));
      queue = result.data || [];
      queueUnavailable = !!result.error;
    }
    for (const row of page) {
      const saved = byId.get(row.id);
      if (invoices.includes(row)) {
        const work = queue.find(item => item.source_id === row.id);
        row.start_invoice_state = queueUnavailable ? 'unavailable'
          : ['review', 'complete'].includes(work?.state) ? 'review'
            : ['retry', 'unknown'].includes(work?.state) ? work.state : work ? 'pending' : 'not_queued';
      }
      if (saved?.request?.paymentMode === 'free' && saved.quote?.paymentMode === 'free'
          && saved.quote.totalWithVat === 0 && row.total_with_vat != null) {
        row.admin_no_charge = true;
      }
    }
  }
}

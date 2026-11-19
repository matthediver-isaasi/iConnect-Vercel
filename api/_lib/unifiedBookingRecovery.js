import { enqueueEventInvoiceRecovery } from './eventInvoiceRecovery.js';

// Handoff uses the original source/group identity in both queues. A timeout
// after capture is retried with the same frozen snapshot, never rebuilt input.
export async function recoverUnifiedBookingInvoices({ db: client, deadlineAt = Date.now() + 8000, enqueueXero = enqueueEventInvoiceRecovery, enqueueQuickBooks, skipProvisioning = false } = {}) {
  const db = { rpc(name, args) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('Invoice handoff budget exhausted');
    const query = client.rpc(name, args);
    return typeof query.abortSignal === 'function' ? query.abortSignal(AbortSignal.timeout(Math.min(5000, remaining))) : query;
  } };
  let provisioningUnavailable = false;
  try {
    const provisioning = skipProvisioning ? {} : await db.rpc('unified_booking_provision_due');
    provisioningUnavailable = !!provisioning.error && !['42883', 'PGRST202'].includes(provisioning.error.code);
  } catch { provisioningUnavailable = true; }
  const claim = await db.rpc('unified_booking_invoice_claim');
  if (['42883', 'PGRST202'].includes(claim.error?.code)) return { status: 'legacy_schema' };
  if (claim.error) throw new Error('Unified invoice outbox unavailable');
  const row = claim.data;
  if (!row) return { status: 'idle', ...(provisioningUnavailable ? { provisioning: 'unavailable' } : {}) };
  let error = null;
  try {
    if (Date.now() >= deadlineAt - 1000) throw new Error('Invoice handoff budget exhausted');
    const prepared = row.prepared;
    if (prepared?.version !== 2 || !prepared.snapshot) throw new Error('Frozen invoice evidence missing');
    if (prepared.provider === 'xero') {
      const result = await enqueueXero({ db, tenantId: row.tenant_id, source: row.source,
        bookingGroupReference: row.purchase_key, snapshot: prepared.snapshot });
      if (!['pending','processing','retry','complete','needs_review'].includes(result?.status)) throw new Error('Invoice handoff not confirmed');
    } else if (prepared.provider === 'quickbooks') {
      const snapshot = prepared.snapshot;
      const args = { p_tenant: row.tenant_id, p_source: row.source, p_group: row.purchase_key,
        p_connection: snapshot.approvalProvider?.connectionId, p_company: snapshot.approvalProvider?.realmId,
        p_snapshot: snapshot };
      const result = enqueueQuickBooks ? await enqueueQuickBooks(args) : await db.rpc('accounting_event_capture', args);
      if (result?.error || (!result?.id && !result?.data?.id)) throw new Error('QuickBooks handoff not confirmed');
    } else throw new Error('Frozen invoice provider unavailable');
  } catch {
    // No provider exception (possibly containing private response data) is stored.
    error = 'Original invoice handoff requires retry';
  }
  const finish = await db.rpc('unified_booking_invoice_finish', { p_tenant: row.tenant_id, p_key: row.purchase_key,
    p_token: row.lease_token, p_success: !error, p_error: error });
  if (finish.error || finish.data !== true) throw new Error('Invoice handoff status unavailable; original intent retained');
  return { status: error ? 'retry' : 'queued', ...(provisioningUnavailable ? { provisioning: 'unavailable' } : {}) };
}

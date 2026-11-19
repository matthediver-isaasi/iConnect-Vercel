// Service-only report projection. Never expose private instructions, provider
// responses, or other identities from the outbox to the browser.
export async function addUnifiedBookingReportStatus(db, tenantId, groups) {
  const current = groups.filter(group => group.bookingContractVersion === 2);
  for (let offset = 0; offset < current.length; offset += 100) {
    const batch = current.slice(offset, offset + 100);
    let result;
    try {
      result = await db.from('unified_booking_invoice')
        .select('purchase_key,state,last_error,next_at,provision_state,provisioned,prepared,booker_member_id')
        .eq('tenant_id', tenantId).in('purchase_key', batch.map(group => group.groupRef));
    } catch { result = { error: true }; }
    for (const group of batch) {
      const row = !result.error && result.data?.find(row => row.purchase_key === group.groupRef);
      if (!row) {
        group.invoiceRecoveryReason = 'Original invoice or optional member-creation status could not be loaded. Review the durable booking before taking financial action.';
        group.groupPayment.invoiceRecoveryStatus = 'needs_review';
        continue;
      }
      group.provisionState = row.provision_state;
      group.invoiceRecoveryReason = row.last_error || row.prepared?.snapshot?.reviewReasons?.join('; ')
        || row.prepared?.snapshot?.invoice?.reviewReason || null;
      const payment = group.groupPayment;
      if (!payment.accountingInvoiceId && !payment.xeroInvoiceId && !['complete','needs_review'].includes(payment.invoiceRecoveryStatus)) {
        payment.invoiceRecoveryStatus = row.state === 'queued' ? payment.invoiceRecoveryStatus || 'pending' : row.state;
      }
      payment.invoiceRecoveryNextAttemptAt ||= row.state === 'pending' ? row.next_at : null;
      const links = row.provisioned || [];
      const link = email => links.find(value => value.email === String(email || '').trim().toLowerCase())?.memberId;
      group.bookerCreatedMemberId = row.booker_member_id || link(group.publicInvoicePurchaser?.email || group.booker?.email) || null;
      for (const attendee of group.attendees) attendee.linked_member_id ||= link(attendee.attendee_email) || null;
    }
  }
}

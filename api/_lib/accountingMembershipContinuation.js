// Queue ownership includes notification completion, never activation or settlement.
// No automatic resend is permitted after a send with an uncertain outcome.
const fail = (code, permanent = false) => {
  throw Object.assign(new Error(code), { code, permanent });
};

export async function freezeMembershipNotification({ db, args }, dependencies = {}) {
  const source = args.accountingSource;
  const input = source.notification;
  const individual = source.sourceType === 'member_membership_history';
  if (!input || (individual ? input.memberId : input.organizationId) !== source.linkage.ownerId
    || !input.note || !input.membershipYear) fail('ACCOUNTING_NOTIFICATION_AUTHORITY_REQUIRED', true);
  let recipients;
  if (individual) recipients = input.memberEmail ? [input.memberEmail] : [];
  else {
    const resolve = dependencies.resolveRecipients
      || (await import('./membershipRecipientResolver.js')).resolveTierRecipients;
    recipients = (await resolve({ client: db, tenantId: args.appTenantId,
      organizationId: input.organizationId, tierConfig: input.tierConfig })).recipients;
  }
  recipients = [...new Set(recipients.map(value => String(value).trim().toLowerCase()).filter(Boolean))];
  // Do not create an invoice we cannot complete. Missing recipients need fixing
  // before acceptance rather than silently declaring delivery complete.
  if (!recipients.length || recipients.length > 100) fail('ACCOUNTING_NOTIFICATION_RECIPIENTS_REQUIRED', true);
  const email = {};
  for (const key of ['memberId', 'memberName', 'organizationId', 'organizationName',
    'membershipYear', 'finalCost', 'currency', 'tierLabel', 'vatAmount', 'totalWithVat']) {
    if (input[key] !== undefined) email[key] = structuredClone(input[key]);
  }
  return { version: 1, recipients, email, note: input.note, createdBy: input.createdBy || null };
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(`accounting_membership_notification_${name}`, args);
  if (error) fail('ACCOUNTING_NOTIFICATION_PERSISTENCE_FAILED');
  return data;
}

export async function continueMembershipNotification({ db, row }, dependencies = {}) {
  const notification = row.snapshot?.notification;
  // Old accepted snapshots are NOT reconstructed from today's configuration.
  if (notification?.version !== 1 || !notification.recipients?.length
    || row.payment_status !== 'skipped' || !row.invoice_result?.id) {
    fail('ACCOUNTING_NOTIFICATION_AUTHORITY_REQUIRED', true);
  }
  const individual = row.source_type === 'member_membership_history';
  const renderAndSend = dependencies.renderAndSend || (individual
    ? (await import('../membership/member-membership-invoicing.js')).sendMemberInvoiceEmail
    : (await import('./membershipInvoiceEmail.js')).sendMembershipInvoiceEmail);
  const send = dependencies.send || (await import('./tenantEmailService.js')).sendTenantEmail;
  let needsRetry = false;
  let needsReview = false;
  // Load durable receipts once, outside the provider-call budget. Retrying a
  // long recipient list must make progress, not spend every run on its prefix.
  const receipts = await rpc(db, 'receipts', { p_request_id: row.id, p_lease_token: row.lease_token });
  const statuses = new Map(receipts.map(receipt => [receipt.recipient, receipt.status]));
  for (const recipient of notification.recipients) {
    if (statuses.get(recipient) === 'delivered') continue;
    if (['sending', 'review'].includes(statuses.get(recipient))) {
      needsReview = true;
      continue;
    }
    await dependencies.beforeSend?.();
    let confirmed = false;
    let invoked = false;
    // Claim at the transport boundary, AFTER rendering and inbox preparation.
    // A render failure must not strand an unsent message as uncertain.
    const guardedSend = async message => {
      if (invoked) fail('ACCOUNTING_NOTIFICATION_REPEATED_SEND', true);
      invoked = true;
      if (message.tenantId !== row.tenant_id || message.to !== recipient) {
        fail('ACCOUNTING_NOTIFICATION_RECIPIENT_CHANGED', true);
      }
      await dependencies.beforeSend?.();
      const claim = await rpc(db, 'claim', { p_request_id: row.id, p_lease_token: row.lease_token, p_recipient: recipient });
      if (claim.status === 'delivered') {
        confirmed = true;
        return { success: true };
      }
      if (!claim.claimed) {
        needsReview = true;
        return { success: false, ambiguousEffect: true };
      }
      let result;
      try { result = await send(message); }
      catch { result = { success: false, ambiguousEffect: true }; }
      const status = result?.success === true && typeof result.messageId === 'string' && result.messageId
        ? 'delivered'
        : result?.success === true ? 'review'
        : result?.ambiguousEffect === false ? 'pending' : 'review';
      // Persistence uncertainty leaves "sending"; never clear it and resend.
      await rpc(db, 'finish', { p_request_id: row.id, p_recipient: recipient,
        p_token: claim.token, p_status: status, p_message_id: status === 'delivered' ? result.messageId : null });
      confirmed = status === 'delivered';
      needsReview ||= status === 'review';
      return { ...result, ambiguousEffect: status === 'review' };
    };
    const invoice = row.invoice_result;
    await renderAndSend({
      ...notification.email, tenantId: row.tenant_id, memberEmail: recipient,
      xeroInvoiceId: invoice.id,
      xeroInvoiceNumber: invoice.invoiceNumber || invoice.invoice_number || null,
      onlineInvoiceUrl: invoice.onlineInvoiceUrl || invoice.online_invoice_url || null,
      historyRecordId: row.source_id, historyTable: row.source_type,
      client: db, skipNote: true, send: guardedSend,
      resolveRecipients: async () => ({ recipients: [recipient], usedFallback: false }),
    });
    needsRetry ||= !confirmed;
  }
  if (needsReview) fail('ACCOUNTING_NOTIFICATION_DELIVERY_REQUIRES_REVIEW', true);
  if (needsRetry) fail('ACCOUNTING_NOTIFICATION_DELIVERY_PENDING');
  // Note + completion receipt are one transaction. A lost response is safe to retry.
  await rpc(db, 'note', { p_request_id: row.id, p_lease_token: row.lease_token });
  return { delivered: true };
}

// Server-loaded history only. The RPC verifies the immutable receipt link;
// neither a cancelled payment nor a client field can establish this authority.
export async function attachPaymentGraceExitEvidence(db, tenantId, memberId, histories) {
  return Promise.all(histories.map(async history => {
    if (!history.payment_grace_exit_id) return history;
    if (history.tenant_id !== tenantId || history.member_id !== memberId || history.organization_id) {
      throw new Error('Payment grace expiry ownership mismatch');
    }
    const { data, error } = await db.rpc('membership_payment_grace_exit_evidence', {
      p_tenant_id: tenantId, p_member_id: memberId, p_history_id: history.id,
    });
    if (error || !data || data.id !== history.payment_grace_exit_id
      || data.tenant_id !== tenantId || data.member_id !== memberId || data.history_id !== history.id
      || data.agreement_id !== history.billing_agreement_id || data.config_id !== history.config_id
      || data.original_term_start_date !== history.term_start_date
      || data.original_term_end_date !== history.term_end_date || history.status !== 'expired') {
      throw new Error('Payment grace expiry could not be verified');
    }
    return { ...history, paymentGraceExit: data };
  }));
}

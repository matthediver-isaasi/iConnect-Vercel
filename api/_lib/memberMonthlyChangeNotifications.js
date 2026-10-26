const result = ({ data, error }) => {
  if (error) throw Object.assign(new Error('Monthly notification storage failed.'), { code: error.code });
  return data;
};
export async function runMemberMonthlyChangeNotifications({
  db, sendEmail, budgetMs = 5000, now = () => Date.now(), limit = 10,
}) {
  const started = now(), outcomes = [];
  let rows;
  try { rows = result(await db.rpc('pending_monthly_change_notifications', { p_limit: limit })); }
  catch (error) {
    if (['PGRST202','42883'].includes(error.code)) return { disabled: 'migration_required', outcomes };
    throw error;
  }
  for (const row of rows || []) {
    if (now() - started >= budgetMs) break;
    let claim,attempted=false;
    try {
      claim = result(await db.rpc('claim_monthly_change_notification', {
        p_tenant_id: row.tenant_id, p_operation_id: row.operation_id,
      }));
      if (!claim) continue;
      const operation = result(await db.from('member_amendment_provider_operation').select('*')
        .eq('tenant_id', row.tenant_id).eq('id', row.operation_id).maybeSingle());
      if (!operation || operation.state !== 'finalized'
        || operation.evidence?.application?.operationId !== operation.id) throw new Error('Application evidence missing.');
      const member = result(await db.from('member').select('id,email')
        .eq('tenant_id', row.tenant_id).eq('id', operation.member_id).maybeSingle());
      let state, evidence;
      if (!member?.email || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(member.email)) {
        state = 'blocked'; evidence = { reason: 'member_email_unavailable' };
      } else {
        const app = operation.evidence.application;
        const text = `Your membership change has been recorded, effective from ${app.effectiveDate}.\n`
          + `Your membership renewal date remains ${app.expiresOn}.\n`
          + 'This message confirms the membership change, not a payment. Contact your membership team if you have any questions.';
        const deliver = sendEmail || (await import('./emailService.js')).sendSystemEmail;
        let delivery;
        try {
          attempted=true;
          delivery = await deliver({
            tenantId: row.tenant_id, to: member.email, subject: 'Your membership change',
            text, html: `<p>${text.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/\n/g,'<br>')}</p>`,
            disableTracking: true, confidentialDiagnostics: true,
          });
        } catch { delivery = { success: false }; }
        state = delivery?.success ? 'sent' : delivery?.notSubmitted === true ? 'pending' : 'uncertain';
        evidence = { messageId: delivery?.messageId || delivery?.id || null,
          reason: state === 'sent' ? null : 'delivery_not_confirmed' };
      }
      result(await db.rpc('finish_monthly_change_notification', {
        p_tenant_id: row.tenant_id, p_operation_id: row.operation_id,
        p_claim_token: claim.claim_token, p_state: state, p_evidence: evidence,
      }));
      outcomes.push({ operationId: row.operation_id, state });
    } catch (error) {
      if(claim && !attempted){
        try{
          result(await db.rpc('finish_monthly_change_notification',{
            p_tenant_id:row.tenant_id,p_operation_id:row.operation_id,p_claim_token:claim.claim_token,
            p_state:'pending',p_evidence:{reason:'pre_delivery_read_failed'},
          }));
          outcomes.push({operationId:row.operation_id,state:'pending'});continue;
        }catch{/* retain the durable claim if storage is unavailable */}
      }
      // A lost acknowledgement leaves the claim intact. The next sweep marks
      // it uncertain; it must never cause another possibly duplicate email.
      outcomes.push({ operationId: row.operation_id, state: claim ? 'claim_retained' : 'failed',
        code: error.code || 'notification_failed' });
    }
  }
  return { outcomes };
}

import { AmendmentError } from './memberAmendmentQuote.js';
import { createMemberAmendmentFinance } from './memberAmendmentFinance.js';
import { assessMemberAmendmentOperationalScope } from './membershipAmendmentReadOverlay.js';
export { resolveMemberAmendmentReadOverlay as resolveMemberAmendmentOverlay } from './membershipAmendmentReadOverlay.js';

export function amendmentResult(result) {
  if (result.error) {
    const code = result.error.code;
    if (['42P01', 'PGRST205', 'PGRST202', '42883'].includes(code)) {
      throw new AmendmentError('Membership amendment settlement migration is required.', 503, 'migration_required');
    }
    if (['40001', '23505'].includes(code)) throw new AmendmentError(result.error.message, 409, 'amendment_conflict');
    throw new AmendmentError('Membership amendment lifecycle could not be persisted.', 500, 'database_error');
  }
  return result.data;
}

function assertOperationalScope(amendment) {
  const scope = assessMemberAmendmentOperationalScope({
    current: amendment.quote?.sourceSnapshot, config: amendment.quote?.targetSnapshot?.config,
  });
  if (!scope.supported) throw new AmendmentError(scope.blockers.join(' '), 422, 'operational_scope_unsupported');
}

export function createMemberAmendmentSettlementService({
  db, finance = createMemberAmendmentFinance(), sendEmail = null, now = () => new Date(),
} = {}) {
  const one = async (table, tenantId, field, value) => amendmentResult(await db.from(table).select('*')
    .eq('tenant_id', tenantId).eq(field, value).maybeSingle());
  const rpc = async (name, args) => amendmentResult(await db.rpc(name, args));
  async function amendment(tenantId, id) {
    const row = await one('member_membership_amendment', tenantId, 'id', id);
    if (!row) throw new AmendmentError('Amendment not found in this tenant.', 404, 'amendment_not_found');
    return row;
  }
  async function lifecycle(tenantId, id) {
    await amendment(tenantId, id);
    const settlement = await one('member_membership_amendment_settlement', tenantId, 'amendment_id', id);
    const application = await one('member_membership_amendment_application', tenantId, 'amendment_id', id);
    const notifications = amendmentResult(await db.from('member_membership_amendment_notification').select('*')
      .eq('tenant_id', tenantId).eq('amendment_id', id).order('kind'));
    return { settlement, application, notifications };
  }
  async function finish(tenantId, id, actorId, result) {
    return rpc('finish_member_amendment_settlement', {
      p_tenant_id: tenantId, p_amendment_id: id, p_actor_id: actorId,
      p_state: result.state, p_evidence: result.evidence, p_error_code: result.errorCode || null,
    });
  }
  async function settle(tenantId, actorId, input) {
    const a = await amendment(tenantId, input.amendmentId);
    assertOperationalScope(a);
    const choice = input.settlementChoice;
    if (!['collect', 'credit', 'refund', 'none'].includes(choice)) {
      throw new AmendmentError('settlementChoice must be collect, credit, refund or none.', 400, 'invalid_settlement_choice');
    }
    // Existing reservations are read-only recovery. A lost provider response,
    // process death or local write failure can NEVER resubmit a money call.
    const existing = await one('member_membership_amendment_settlement', tenantId, 'amendment_id', a.id);
    if (existing) {
      if (existing.choice !== choice) throw new AmendmentError('Settlement choice is locked; retained credit cannot be changed into a refund.', 409, 'settlement_choice_locked');
      return reconcile(tenantId, actorId, { amendmentId: a.id });
    }
    const context = await finance.prepare(a, choice);
    const reservation = await rpc('reserve_member_amendment_settlement', {
      p_tenant_id: tenantId, p_amendment_id: a.id, p_actor_id: actorId, p_choice: choice, p_context: context,
    });
    if (!reservation.claimed) return reconcile(tenantId, actorId, { amendmentId: a.id });
    let result;
    try {
      result = await finance.execute(a, reservation.settlement);
    } catch (error) {
      await finish(tenantId, a.id, actorId, {
        state: 'uncertain', evidence: { reason: 'provider_outcome_requires_reconciliation' },
        errorCode: error.code || 'provider_outcome_uncertain',
      });
      throw new AmendmentError('Provider outcome is unresolved. Reservation retained; use reconcile, not a new proposal or money retry.', 409, 'provider_outcome_uncertain');
    }
    // Deliberately outside the provider try/catch. If this write fails, the
    // durable reservation remains and the next call only inspects the provider.
    await finish(tenantId, a.id, actorId, result);
    return lifecycle(tenantId, a.id);
  }
  async function reconcile(tenantId, actorId, input) {
    const a = await amendment(tenantId, input.amendmentId);
    const s = await one('member_membership_amendment_settlement', tenantId, 'amendment_id', a.id);
    if (!s) throw new AmendmentError('No settlement reservation exists.', 409, 'settlement_not_started');
    if (['applied', 'conflict'].includes(s.state)) return lifecycle(tenantId, a.id);
    try {
      const result = await finance.inspect(a, s);
      // A previously settled document changing externally must block apply.
      if (s.state === 'settled' && result.state !== 'settled') {
        await finish(tenantId, a.id, actorId, { state: 'conflict',
          evidence: result.evidence, errorCode: 'settlement_evidence_changed' });
      } else await finish(tenantId, a.id, actorId, result);
    } catch (error) {
      await finish(tenantId, a.id, actorId, {
        state: s.state === 'settled' && error.code === 'finance_evidence_required' ? 'conflict' : 'uncertain',
        evidence: { ...s.evidence, reason: 'provider_verification_failed' },
        errorCode: error.code || 'provider_verification_failed',
      });
      throw error;
    }
    return lifecycle(tenantId, a.id);
  }
  async function apply(tenantId, actorId, input) {
    assertOperationalScope(await amendment(tenantId, input.amendmentId));
    const before = await lifecycle(tenantId, input.amendmentId);
    if (before.application) return before;
    // Re-verify live provider facts immediately before the transactional source,
    // pause/successor/expiry guard; a status flag alone never authorises access.
    await reconcile(tenantId, actorId, input);
    const result = await rpc('apply_member_membership_amendment', {
      p_tenant_id: tenantId, p_amendment_id: input.amendmentId, p_actor_id: actorId,
    });
    if (result.conflict) throw new AmendmentError('Settlement arrived after the membership changed, paused or renewed. Funds remain recorded; entitlement was not applied.', 409, result.code);
    return lifecycle(tenantId, input.amendmentId);
  }
  async function backCredit(tenantId,actorId,input){
    const a=await amendment(tenantId,input.amendmentId);
    assertOperationalScope(a);
    const s=await one('member_membership_amendment_settlement',tenantId,'amendment_id',a.id);
    if(s?.choice!=='credit'||!a.quote?.memberCreditLiabilityBinding||!s.context?.memberCreditLiabilityBinding){
      throw new AmendmentError('This settlement is not an approved member-credit issuance.',409,'credit_backing_not_authorized');
    }
    let result;
    try{result=await finance.backCredit(db,a,s,actorId);}
    catch(error){
      await finish(tenantId,a.id,actorId,{state:'uncertain',evidence:{...s.evidence,reason:'credit_backing_requires_reconciliation'},
        errorCode:error.code||'credit_backing_outcome_uncertain'});
      throw error;
    }
    await finish(tenantId,a.id,actorId,result);
    return lifecycle(tenantId,a.id);
  }
  async function notify(tenantId, actorId, input) {
    const a = await amendment(tenantId, input.amendmentId);
    const life = await lifecycle(tenantId, a.id);
    for (const n of life.notifications || []) {
      if (n.state !== 'pending') continue;
      const s = life.settlement;
      // Fetch all needed facts before claiming. Missing recipient does not
      // permanently lose a delivery; cron retries after payer data is corrected.
      const payer = s?.context?.payerEmail;
      const member = await one('member', tenantId, 'id', a.member_id);
      const recipients = [...new Set([payer, member?.email].filter(x => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
      const claim = await rpc('claim_member_amendment_notification', {
        p_tenant_id: tenantId, p_amendment_id: a.id, p_kind: n.kind,
      });
      if (!claim) continue;
      if (!recipients.length) {
        await rpc('finish_member_amendment_notification', {
          p_tenant_id: tenantId, p_amendment_id: a.id, p_kind: n.kind,
          p_state: 'pending', p_evidence: { reason: 'notification_recipient_missing', attemptedAt: now().toISOString() },
        });
        continue;
      }
      let outcome;
      try {
        const deliver = sendEmail || (await import('./emailService.js')).sendSystemEmail;
        const applied = n.kind === 'applied';
        const amount = new Intl.NumberFormat('en', { style: 'currency', currency: a.quote.currency })
          .format(Math.abs(a.quote.delta.grossMinor) / 100);
        const financial = s?.choice === 'collect'
          ? (s.state === 'awaiting_payment' ? `Additional payment required: ${amount}. ${s.evidence?.paymentUrl || 'Contact the membership team for the invoice payment link.'}` : `Additional payment verified: ${amount}.`)
          : s?.choice === 'refund'
            ? (s.evidence?.kind === 'recorded_manual_refund' ? `Bank-reconciled manual refund recorded: ${amount}.` : `A manual cash refund of ${amount} must be made and bank-reconciled. No automatic refund has been sent.`)
            : s?.choice === 'credit' ? (s.context?.memberCreditLiabilityBinding
              ? (life.application ? `Member credit issued: ${amount}. This is iConnect membership credit, not a cash refund.`
                : `Member credit of ${amount} is being prepared and is not yet available to spend.`)
              : `Retained credit note: ${amount}. This is not a cash refund.`) : 'No financial difference.';
        const text = `Membership amendment ${a.id}\n${applied ? 'Membership change applied.' : 'Membership change settlement update. This message does not confirm an applied membership change.'}\n${financial}\nOriginal renewal date remains ${a.quote.term.renewalDate}.`;
        outcome = await deliver({
          tenantId, to: recipients.join(','), subject: applied ? 'Membership change applied' : 'Membership change settlement update',
          text, html: `<p>${text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>')}</p>`,
          disableTracking: true, confidentialDiagnostics: true,
        });
      } catch {
        outcome = { success: false };
      }
      await rpc('finish_member_amendment_notification', {
        p_tenant_id: tenantId, p_amendment_id: a.id, p_kind: n.kind,
        p_state: outcome?.success ? 'sent' : outcome?.notSubmitted ? 'pending' : 'uncertain',
        p_evidence: { messageId: outcome?.messageId || outcome?.id || null,
          attemptedAt: now().toISOString(), actorId, reason: outcome?.success ? null : 'delivery_not_confirmed' },
      });
    }
    return lifecycle(tenantId, a.id);
  }
  return { lifecycle, settle, reconcile, apply, notify,backCredit };
}

export async function runMemberAmendmentRecovery({ db, service = createMemberAmendmentSettlementService({ db }),
  limit = 30, budgetMs = 40000, now = () => new Date() }) {
  const start = Date.now();
  const interruptedNotifications = amendmentResult(await db.rpc('recover_stale_member_amendment_notifications', {}));
  const due = amendmentResult(await db.from('member_membership_amendment_settlement').select('*')
    .in('state', ['reserved', 'awaiting_payment', 'uncertain'])
    .lte('next_attempt_at', now().toISOString()).order('next_attempt_at').order('amendment_id').limit(limit));
  const outcomes = [];
  for (const row of due || []) {
    if (Date.now() - start > budgetMs) break;
    try {
      await service.reconcile(row.tenant_id, row.actor_id, { amendmentId: row.amendment_id });
      outcomes.push({ amendmentId: row.amendment_id, reconciled: true });
    } catch (error) { outcomes.push({ amendmentId: row.amendment_id, code: error.code || 'recovery_failed' }); }
  }
  const pending = amendmentResult(await db.from('member_membership_amendment_notification').select('*')
    .eq('state', 'pending').order('updated_at').order('amendment_id').limit(limit));
  for (const row of pending || []) {
    if (Date.now() - start > budgetMs) break;
    try {
      const s = amendmentResult(await db.from('member_membership_amendment_settlement').select('actor_id')
        .eq('tenant_id', row.tenant_id).eq('amendment_id', row.amendment_id).single());
      await service.notify(row.tenant_id, s.actor_id, { amendmentId: row.amendment_id });
    } catch (error) { outcomes.push({ amendmentId: row.amendment_id, code: error.code || 'notification_failed' }); }
  }
  return { outcomes, interruptedNotifications, timedOut: Date.now() - start > budgetMs };
}

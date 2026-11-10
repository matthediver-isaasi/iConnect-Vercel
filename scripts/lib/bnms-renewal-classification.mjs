// Findings describe stored evidence, not authority to charge or repair.
export const terminal = r => ['cancelled','canceled','void','expired_checkout'].includes(r.status) || !!r.cancelled_for_switch_at;
const openAgreement = r => !terminal(r) && !['expired','completed','payment_plan_cancelled'].includes(r.status);
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const invoiceId = r => r.accounting_invoice_id || r.xero_invoice_id || r.xero_document_id;
const ref = r => r.id || r.history_id || r.provider_payment_id || r.event_id;
// Alpha/beta invoice-link history_id references PROVIDER history, not membership.
export function historicalInvoiceLinkMatches(payment, link) {
  return link.history_id===payment.id && link.member_id===payment.member_id
    && link.tenant_id===payment.tenant_id && link.provider_payment_id===payment.provider_payment_id;
}
export function classifyMember({ member, memberClass, membershipStatus, histories, orgHistories = [],
  agreements, plans, payments, invoices, instalments = [], arrears = [], elections = [], quotes = [],
  feeTokens = [], selected, summary, renewal, errors = [], today, allTables, tenantId }) {
  if (member.tenant_id!==tenantId || [...histories,...agreements,...plans,...invoices,...quotes,...feeTokens]
    .some(r=>r.tenant_id!==tenantId||r.member_id!==member.id))
    throw new Error('Audit tenant/member scope mismatch');
  const issues = [];
  const add = (category, code, evidence, reason, impact, nextAction, confidence='high') =>
    issues.push({category, code, references:evidence.map(ref).filter(Boolean), reason, impact, confidence,
      nextAction:nextAction || 'Review this exact evidence; any correction requires separate approval.'});
  const deleted = member.is_deleted || member.deleted_at || member.anonymized_at || member.status === 'deleted';
  const test = member.is_sample || member.is_test;
  const guest = member.is_guest || ['CPD Guest','Department contact','Guest'].includes(memberClass);
  const former = memberClass === 'Former' || ['Inactive','Former','Lapsed','Expired'].includes(membershipStatus);
  const exclusion = deleted ? 'deleted' : test ? 'test_or_sample' : guest ? 'guest_or_contact'
    : former ? 'inactive_or_former' : '';
  const retained = histories.filter(h=>!terminal(h));
  const current = selected?.record;
  const scope = orgHistories.length && current?.membership_source === 'organisation' ? 'organisation_funded'
    : histories.length ? 'personal_history' : 'no_history';
  if (exclusion) add('expected', 'population_exclusion', [member],
    `Retained in population; ${exclusion} excluded from active-member action totals, not from financial review.`,
    'No assumption of personal renewal obligation.');
  if (member.membership_paused) add('expected','intentional_pause',[member],
    'Explicit membership pause is retained.', 'Renewal admission is intentionally suppressed.');
  if (!histories.length && !orgHistories.length) {
    const honorary = memberClass === 'Honorary';
    add(exclusion || honorary ? 'expected' : 'unresolved','no_membership_history',[member],
      honorary ? 'Honorary class with no purchased term; no expiry or price inferred.'
        : 'No retained personal or current-organisation membership history.',
      exclusion || honorary ? 'No evidenced renewal obligation.' : 'Cannot establish paid entitlement or predecessor for renewal.',
      'Confirm membership class and original entitlement evidence before considering an import.');
  }
  if (scope === 'organisation_funded') add('display_only','organisation_payment_unsupported',[current],
    'Current portal intentionally does not expose organisation payer details.',
    'Payment details unavailable is not evidence of a personal debt.');
  for (const error of errors) add('unresolved','offline_rule_evidence_unavailable',[],
    error,'Rule outcome cannot be established from the captured evidence.');
  if (summary?.payment.state === 'unavailable' && scope !== 'organisation_funded') {
    const missingPlan = current?.billing_agreement_id && !plans.some(p=>p.id === summary.auditPlanId);
    add(missingPlan ? 'risk' : 'display_only', missingPlan ? 'selected_term_plan_unmatched' : 'payment_details_unavailable',
      current ? [current] : [], missingPlan
        ? 'The portal cannot match a plan by exact owner, agreement and term.'
        : 'The current portal does not have qualifying upfront/plan evidence for its payment card.',
      'Does not by itself establish unpaid debt or failed renewal.');
  }
  if (renewal?.state === 'review_required') add('blocker','renewal_admission_review',current?[current]:[],
    renewal.reason || renewal.message || 'Current application admission rules require review.',
    'Self-service renewal cannot currently proceed on this evidence.');
  if (renewal?.state === 'admitted_to_pricing_not_run') add('unresolved','renewal_price_not_verified',current?[current]:[],
    'Read-only admission reached pricing; no checkout or pricing simulation was run.',
    'Admission is not proof that a valid renewal quote can be produced.',
    'Approve a separate read-only price verification if needed; do not collect payment from this audit.');
  if (renewal?.state === 'renewal_pending' || renewal?.state === 'initial_checkout_pending') {
    const future = agreements.some(a => a.metadata?.card?.deferred_billing?.first_charge_date > today);
    add(future ? 'expected' : 'risk',future ? 'future_deferred_card' : 'unfinished_or_reserved_purchase',
      [...elections.filter(e=>e.status!=='released'), ...agreements.filter(openAgreement)],
      renewal.message || renewal.reason || 'An outstanding arrangement or successor reservation suppresses another checkout.',
      future ? 'Future first collection; do not pay again.' : 'May be intentional pending setup or abandoned checkout; provider outcome must be checked before release.',
      'Review the exact reservation and provider outcome before separately approving continuation or cancellation.');
  }
  if (['renewal_not_open','next_term_purchased','continuing_arrangement','paused'].includes(renewal?.state))
    add('expected',renewal.state,current?[current]:[],renewal.reason || renewal.state,
      'No immediate manual renewal action inferred.');
  if (renewal?.state === 'renewal_closed') add('risk','renewal_window_closed',current?[current]:[],
    'Standard renewal window has closed; post-grace eligibility was not granted.',
    'Member may require a separately reviewed post-grace journey; not proof of debt.');
  for (const h of retained) {
    if ((h.term_start_date && !date(h.term_start_date)) || (h.term_end_date && !date(h.term_end_date))
      || (h.term_start_date && h.term_end_date && h.term_start_date > h.term_end_date)) {
      add('blocker','invalid_term_dates',[h],'Retained term dates are invalid or reversed.','Safe renewal boundary cannot be established.');
    }
    if (h.term_key && (!h.commitment_snapshot || !h.term_start_date || !h.term_end_date || !h.membership_renewal_date))
      add('blocker','incomplete_commitment',[h],'Keyed commitment is missing required retained dates or snapshot.','Renewal evidence requires review.');
    if (h.billing_agreement_id && !agreements.some(a=>a.id===h.billing_agreement_id))
      add('blocker','agreement_link_unavailable',[h],'History agreement is absent from the exact tenant and member scope.','Cannot safely attach billing evidence.');
    if (h.previous_term_id && !histories.some(p=>p.id===h.previous_term_id))
      add('blocker','predecessor_link_unavailable',[h],'Predecessor does not exist in this owner scope.','Successor provenance is inconsistent.');
    if (h.membership_payment_quote_id && !quotes.some(q=>q.id===h.membership_payment_quote_id))
      add('risk','quote_link_unavailable',[h],'Referenced payment quote is absent from this owner scope.','Purchase provenance requires review.');
    if (h.status === 'active' && h.payment_status === 'unpaid' && !h.billing_agreement_id)
      add('risk','active_unpaid_upfront',[h],'Active history remains unpaid without a recurring agreement.','Entitlement and settlement evidence differ; do not infer a charge is due.');
    const amount = h.total_with_vat ?? h.final_cost;
    const agreement = agreements.find(a=>a.id===h.billing_agreement_id);
    const perInstalment = ['per_instalment','per_installment'].includes(
      agreement?.metadata?.dd?.invoicing_mode || agreement?.metadata?.card?.invoicing_mode);
    if (!invoiceId(h) && amount != null && Number(amount)>0 && h.payment_status==='paid' && !h.billing_agreement_id) {
      add('accounting_only','paid_term_invoice_link_missing',[h],
        'Paid positive-value upfront term has no direct invoice ID. Historical invoices may exist but are not term-linked.',
        'Accounting traceability gap, not evidence that the member must pay again.',
        'Match original invoices by owner, amount, currency and term before approving any linkage or invoice creation.','medium');
    }
    if (perInstalment || (amount!=null && Number(amount)===0) || h.override_type==='no_charge')
      add('expected','annual_invoice_may_be_intentionally_absent',[h],
        'Instalment billing, zero-value or explicitly waived term evidence is present.',
        'Absence of a whole-term invoice is not automatically a fault.');
  }
  for (let i=0;i<retained.length;i++) for(let j=i+1;j<retained.length;j++) {
    const a=retained[i],b=retained[j];
    if (date(a.term_start_date)&&date(a.term_end_date)&&date(b.term_start_date)&&date(b.term_end_date)
      && a.term_start_date<=b.term_end_date && b.term_start_date<=a.term_end_date)
      add('blocker','overlapping_terms',[a,b],'Two non-retired retained terms overlap.','Application admission rejects ambiguous predecessors.');
  }
  for (const a of agreements) {
    const hs=histories.filter(h=>h.billing_agreement_id===a.id);
    const ps=plans.filter(p=>p.billing_agreement_id===a.id);
    if (openAgreement(a) && !hs.length) add('risk','open_agreement_without_history',[a],
      'Open agreement has no member history link.','May be unfinished signup or uncommitted purchase; settlement is not inferred.');
    if (openAgreement(a) && ps.length>1) add('risk','multiple_plans_for_agreement',[a,...ps],
      'More than one plan is retained for this agreement.','Latest-plan display may hide older collection evidence.');
    if (a.needs_attention) add('risk','agreement_attention',[a],a.attention_reason||'Agreement marked for attention.','Stored provider/setup issue requires review.');
  }
  for (const p of plans) {
    const a=agreements.find(a=>a.id===p.billing_agreement_id);
    if (!a || a.provider!==p.provider || a.environment!==p.environment)
      add('blocker','plan_agreement_mismatch',[p,...(a?[a]:[])],'Plan owner/provider/environment agreement could not be matched.','Billing evidence must not be attached across scopes.');
    if (p.collection_stopped_at || p.metadata?.bnms_release_required)
      add('expected','collection_held',[p],'Collection stop or explicit release hold retained.','No collection inferred; release requires independent approval.');
    if (['payment_failed','payment_overdue','failed'].includes(p.status) || p.needs_attention)
      add('risk','payment_plan_attention',[p],p.attention_reason||`Plan state: ${p.status}`,'Collection or arrears may affect future renewal; verify retained policy.');
    if (p.provider==='stripe' && openAgreement(p))
      add('unresolved','stripe_schedule_not_live_verified',[p],
        'Only persisted Stripe records were read; no provider subscription or balance confirmation.',
        'Current collection schedule and settlement are not independently verified.');
  }
  for (const ar of arrears.filter(a=>!a.settled_at)) add('risk','unsettled_arrears',[ar],
    `Retained arrears ${ar.amount_minor} ${ar.currency} minor units for ${ar.due_period}.`,
    'Unsettled stored arrears may affect access or collection; not independently verified current provider debt.');
  for (const p of payments) {
    const plan=plans.find(x=>x.id===p.plan_id);
    if (!plan || plan.environment!==p.environment || (plan.gocardless_mandate_id && plan.gocardless_mandate_id!==p.gocardless_mandate_id)) {
      add('risk','payment_plan_identity_mismatch',[p],'Stored payment does not match plan/environment/mandate.','Do not attribute payment settlement to this term.');
      continue;
    }
    if (['confirmed','paid_out'].includes(p.status)) {
      const hs=retained.filter(h=>h.billing_agreement_id===plan.billing_agreement_id);
      if (!hs.length) add('blocker','settled_payment_without_retained_history',[p,plan],
        'Stored confirmed/paid-out payment has no non-retired membership for its plan agreement.',
        'Possible uncommitted entitlement; provider and term verification needed before repair.');
      const a=agreements.find(a=>a.id===plan.billing_agreement_id);
      if(a?.metadata?.dd?.invoicing_mode==='per_instalment'&&!invoiceId(p)
        && !instalments.some(i=>i.plan_id===p.plan_id&&i.external_payment_id===p.gocardless_payment_id&&invoiceId(i)))
        add('accounting_only','settled_instalment_invoice_missing',[p,plan],
          'Confirmed/paid-out instalment under per-instalment consent has no stored invoice ID.',
          'Accounting gap; does not mean the member needs to pay again.',
          'Check original accounting/provider records before separately approving invoice recovery.','medium');
      // Never use one instalment as proof that the entire membership was paid.
    }
  }
  for(const i of instalments) {
    const p=plans.find(p=>p.id===i.plan_id);
    if(!p||i.billing_agreement_id!==p.billing_agreement_id||i.provider!==p.provider)
      add('accounting_only','instalment_invoice_identity_mismatch',[i],
        'Instalment invoice plan/agreement/provider identity is inconsistent.','Invoice attribution requires review.');
  }
  const unpaid = invoices.filter(i=>/membership/i.test(i.description||'')
    && ['unpaid','partial','outstanding'].includes(i.accounting_payment_status || i.status));
  if (unpaid.length) add('accounting_only','historical_membership_invoice_unpaid',unpaid,
    'Imported membership invoices retain unpaid/partial/outstanding status; check timestamps and provider.',
    'Historical accounting issue; no automatic impact on current term or proof of collectible debt.',
    'Verify original invoice balances, credits and exact term before separately approving action.','medium');
  const ids=new Map();
  for (const inv of invoices) { const id=invoiceId(inv); if(id) { if(!ids.has(id))ids.set(id,[]);ids.get(id).push(inv); } }
  for(const matches of ids.values()) if(matches.length>1) add('accounting_only','duplicate_historical_invoice_identity',matches,
    'Same provider invoice identity appears more than once for this member.','May be duplicate import evidence, not duplicate debt.');
  const unlinkedQuotes=quotes.filter(q=>!q.cancelled_for_switch_at&&!histories.some(h=>h.membership_payment_quote_id===q.id));
  if(unlinkedQuotes.length) add('unresolved','quote_without_committed_history',unlinkedQuotes,
    'Quote has no linked committed history; quote or payment-intent ID is not settlement.',
    'Could be abandoned unpaid checkout or unresolved payment outcome.',
    'Read provider intent outcome without replay before separately approving recovery.');
  const pendingTokens=feeTokens.filter(t=>t.status==='pending');
  if(pendingTokens.length) add('expected','pending_fee_link',pendingTokens,
    'Pending fee link is not payment evidence.','Do not treat an unpaid checkout as collected funds.');
  if (summary?.payment.collectionBasis==='unavailable') add('unresolved','collection_projection_unavailable',
    current?[current]:[],'Current read-only collection projection could not produce a supported date/amount.',
    'No bank-scheduled payment is inferred.');
  if (!issues.length) add('expected','no_issue_identified',current?[current]:[member],
    'No issue detected by the captured-evidence checks.','Not a guarantee of provider settlement or successful future checkout.');
  const precedence=['blocker','risk','unresolved','display_only','accounting_only','expected'];
  return {memberId:member.id,memberClass:memberClass||'unknown',membershipStatus:membershipStatus||'unknown',
    exclusion:exclusion||null,scope,historyCount:histories.length,historyIds:histories.map(ref),
    agreementIds:agreements.map(ref),planIds:plans.map(ref),selectedHistoryId:current?.id||null,
    membershipState:summary?.membership?.state||'unavailable',paymentState:summary?.payment?.state||'unavailable',
    renewalState:renewal?.state||'unresolved',renewalReason:renewal?.reason||null,
    classification:precedence.find(c=>issues.some(i=>i.category===c)),issues};
}

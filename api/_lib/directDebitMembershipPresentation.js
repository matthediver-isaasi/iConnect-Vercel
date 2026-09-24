import { readConsoleRows, lookupConsoleRows } from './directDebitConsoleEligibility.js';
import { ALPHA_RECOGNITION_TENANT, MEMBERSHIP_RECOGNITION_TABLES, currentMembershipRecognition } from './alphaMembershipRecognition.js';
import { selectCanvasCommitment, buildCanvasSummary } from '../membership/canvas-summary.js';
import { MANUAL_ADOPTION, MANUAL_RECOGNITION } from './bnmsManualCohort.js';

// Entitlement presentation only. Never change the agreement, payment plan,
// collection hold or provider state to make an existing member look current.
const replaceable = new Set(['active', 'pending', 'pending_activation', 'payment_setup_required', 'mandate_pending', 'first_payment_pending']);

export function directDebitCollectionPresentation(plan) {
  return { held: !!plan.collection_stopped_at || plan.metadata?.bnms_release_required === true };
}

export function directDebitMembershipPresentation(plan, records, owner, today, historicalImport = null) {
  const selected = selectCanvasCommitment(records, [], today);
  const current = !!owner && buildCanvasSummary({
    selected, paused: owner.membership_paused === true, today,
  }).membership.state === 'active';
  const recognized = current && currentMembershipRecognition(selected.record, today);
  return {
    current,
    historicalImport,
    pendingActivation: replaceable.has(plan.status) && !current && !historicalImport && records.some(h =>
      h.billing_agreement_id === plan.billing_agreement_id && h.status === 'pending_activation'),
    displayStatus: replaceable.has(plan.status)
      ? current ? 'current' : historicalImport ? 'membership_unverified' : plan.status
      : plan.status,
    evidence: current ? {
      source: recognized ? 'administrative_recognition' : 'membership_history',
      historyId: selected.record.id,
      effectiveFrom: recognized ? recognized.effective_from : selected.start,
      effectiveUntil: recognized ? recognized.effective_until : selected.renewal,
      endDate: selected.record.term_end_date || null,
    } : null,
  };
}

export async function loadDirectDebitMembershipPresentations(db, tenantId, plans, today = new Date().toISOString().slice(0, 10)) {
  if (!plans.length) return new Map();
  const agreements = await lookupConsoleRows(db, tenantId, 'membership_billing_agreements', plans.map(p => p.billing_agreement_id));
  const identities = plans.map(p => {
    const agreement = agreements.get(p.billing_agreement_id) || p.membership_billing_agreements;
    return { plan: p, memberId: agreement?.member_id || p.member_id, orgId: agreement?.organization_id || p.organization_id };
  });
  const [members, organizations, personal, organisation] = await Promise.all([
    lookupConsoleRows(db, tenantId, 'member', identities.map(p => p.memberId).filter(Boolean)),
    lookupConsoleRows(db, tenantId, 'organization', identities.map(p => p.orgId).filter(Boolean)),
    readConsoleRows(() => db.from('member_membership_history').select('*').eq('tenant_id', tenantId).order('id')),
    readConsoleRows(() => db.from('organisation_membership_history').select('*').eq('tenant_id', tenantId).order('id')),
  ]);
  const imports = new Map();
  if (tenantId === ALPHA_RECOGNITION_TENANT) {
    // Canonical adoption ledgers, not arbitrary plan metadata, discovery or a
    // mandate's readiness, distinguish historical imports from new joiners.
    for (const table of ['bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption', 'bnms_dd_pilot_adoption', MANUAL_ADOPTION]) {
      const adoptions = await readConsoleRows(() => db.from(table)
        .select('id,tenant_id,member_id,agreement_id,plan_id,history_id').eq('tenant_id', tenantId).order('id'),
      { allowMissing: table === MANUAL_ADOPTION });
      for (const adoption of adoptions) {
        const plan = plans.find(p => p.id === adoption.plan_id);
        if (!plan) continue;
        const agreement = agreements.get(plan.billing_agreement_id);
        const history = personal.find(h => h.id === adoption.history_id);
        if (adoption.tenant_id !== tenantId || !adoption.member_id
            || plan.provider !== 'gocardless' || !agreement || agreement.provider !== 'gocardless'
            || agreement.member_id !== adoption.member_id
            || plan.billing_agreement_id !== adoption.agreement_id
            || (plan.member_id && plan.member_id !== adoption.member_id)
            || !history || history.tenant_id !== tenantId
            || history.member_id !== adoption.member_id || history.billing_agreement_id !== adoption.agreement_id) {
          throw new Error('Historical Direct Debit adoption ownership mismatch');
        }
        if (imports.has(plan.id)) throw new Error('Ambiguous historical Direct Debit adoption');
        imports.set(plan.id, { source: table, adoptionId: adoption.id, historyId: adoption.history_id });
      }
    }
    let recognition;
    try {
      recognition = (await Promise.all(MEMBERSHIP_RECOGNITION_TABLES.map(table =>
        readConsoleRows(() => db.from(table)
          .select('*').eq('tenant_id', tenantId).order('history_id'),
        { allowMissing: table === MANUAL_RECOGNITION })))).flat();
    } catch (error) {
      // Missing deployment schema is not evidence of entitlement.
      throw new Error('Unable to load administrative membership recognition', { cause: error });
    }
    for (const row of recognition) {
      const history = personal.find(h => h.id === row.history_id);
      if (row.tenant_id !== tenantId || (history && (row.member_id !== history.member_id || row.agreement_id !== history.billing_agreement_id))) {
        throw new Error('Membership recognition ownership mismatch');
      }
      if (history && !row.revoked_at) {
        if (history.membershipRecognition && !history.membershipRecognition.revoked_at) {
          throw new Error('Overlapping administrative membership recognition');
        }
        history.membershipRecognition = row;
      }
    }
  }
  return new Map(identities.map(({ plan, memberId, orgId }) => {
    const records = memberId
      ? personal.filter(h => h.tenant_id === tenantId && h.member_id === memberId).map(h => ({ ...h, membership_source: 'personal' }))
      : organisation.filter(h => h.tenant_id === tenantId && h.organization_id === orgId).map(h => ({ ...h, membership_source: 'organisation' }));
    return [plan.id, directDebitMembershipPresentation(plan, records, memberId ? members.get(memberId) : organizations.get(orgId), today, imports.get(plan.id) || null)];
  }));
}
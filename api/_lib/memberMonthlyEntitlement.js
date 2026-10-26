// Original purchase/consent and invoice economics remain immutable. A monthly
// application changes operational scope only, from its effective date.
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const fail = () => {
  throw Object.assign(new Error('Applied monthly membership evidence is inconsistent'), {
    code: 'monthly_entitlement_invalid',
  });
};
export function isPersonalMonthlyHistory(history) {
  return !!history?.member_id && !history.organization_id
    && history.membership_source !== 'organisation' && !!history.billing_agreement_id
    && history.commitment_snapshot?.payment_frequency === 'monthly';
}

export function projectMonthlyEntitlement(history, operation, {
  tenantId, asOf = new Date().toISOString().slice(0, 10), renewal = false,
} = {}) {
  if (!operation) return history;
  const application = operation.evidence?.application;
  const input = operation.prepared?.input;
  const config = application?.targetSnapshot?.config;
  const band = application?.targetSnapshot?.band;
  if (!isPersonalMonthlyHistory(history) || !day(asOf)
    || operation.state !== 'finalized' || !application
    || operation.tenant_id !== tenantId || history.tenant_id !== tenantId
    || operation.member_id !== history.member_id || operation.source_record_id !== history.id
    || input?.purchase?.id !== history.id || input?.agreement?.id !== history.billing_agreement_id
    || input?.plan?.id !== operation.plan_id
    || application.operationId !== operation.id
    || !day(application.effectiveDate) || !day(application.expiresOn)
    || application.effectiveDate < history.term_start_date
    || application.effectiveDate >= application.expiresOn
    || application.expiresOn !== history.membership_renewal_date
    || !config?.id || config.tenant_id !== tenantId || config.structure_scope_type !== 'member'
    || (band && (band.tenant_id !== tenantId || band.config_id !== config.id))
    || ['tenant_id', 'member_id', 'config_id', 'band_id', 'term_key', 'term_start_date',
      'membership_renewal_date', 'billing_agreement_id', 'currency'].some(
      key => (input.purchase[key] ?? null) !== (history[key] ?? null))) fail();
  const result = {
    ...history,
    membership_amendment_evidence: [{
      amendmentId: operation.operation_key, applicationId: operation.id,
      effectiveDate: application.effectiveDate, expiresOn: application.expiresOn,
      targetConfigId: config.id, targetBandId: band?.id || null,
      targetStructureName: config.name || null,
      targetTierLabel: band?.label || config.name || null,
      currency: history.currency, appliedAt: application.appliedAt,
    }],
  };
  const scopeDate = renewal && asOf >= application.expiresOn
    ? new Date(Date.parse(`${application.expiresOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    : asOf;
  if (scopeDate < application.effectiveDate || scopeDate >= application.expiresOn) return result;
  return {
    ...result,
    effective_membership_amendment: application,
    effective_config_id: config.id, effective_band_id: band?.id || null,
    effective_tier_label: band?.label || config.name || null,
    effective_commitment_snapshot: {
      ...history.commitment_snapshot, config, band: band || null,
      authority: 'finalized_monthly_membership_amendment',
      amendment_id: operation.operation_key,
    },
  };
}

export async function resolveMonthlyEntitlements({ db, tenantId, history,
  asOf = new Date().toISOString().slice(0, 10), renewal = false }) {
  const candidates = history.filter(isPersonalMonthlyHistory);
  if (candidates.some(row => row.tenant_id !== tenantId)) fail();
  const operations = new Map();
  for (let start = 0; start < candidates.length; start += 100) {
    const ids = candidates.slice(start, start + 100).map(row => row.id);
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from('member_amendment_provider_operation').select('*')
        .eq('tenant_id', tenantId).eq('state', 'finalized').in('source_record_id', ids)
        .order('id', { ascending: true }).range(offset, offset + 499);
      if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return history;
        throw Object.assign(new Error('Applied monthly membership could not be read'), {
          code: 'monthly_entitlement_unavailable',
        });
      }
      if (!Array.isArray(data)) fail();
      for (const row of data) {
        // Multiple sequential changes need a separately versioned chain, not
        // last-write-wins selection. Current finalizer admits one per purchase.
        if (!ids.includes(row.source_record_id) || operations.has(row.source_record_id)) fail();
        operations.set(row.source_record_id, row);
      }
      if (data.length < 500) break;
    }
  }
  return history.map(row => projectMonthlyEntitlement(row, operations.get(row.id), { tenantId, asOf, renewal }));
}

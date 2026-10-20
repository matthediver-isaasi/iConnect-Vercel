// Read-only entitlement projection. Never replace original purchase economics.
// Deliberately dependency-light: payment/settlement/provider modules are not imported.
// Never use a blanket "readers ready" flag. Core must check BOTH source and
// target with assessMemberAmendmentOperationalScope at proposal and apply.
export const MEMBER_AMENDMENT_READER_READY_SCOPES = Object.freeze([
  'personal_annual_upfront_rolling_immediate_to_immediate',
]);
const absentTable = new Set(['42P01', 'PGRST205']);
const fail = message => {
  const error = new Error(message);
  error.code = 'amendment_overlay_invalid';
  throw error;
};
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function assessMemberAmendmentOperationalScope({ current, config }) {
  const snapshot = current?.commitment_snapshot;
  const original = snapshot?.config;
  const supported = supportsMemberAmendmentReadOverlay(current)
    && String(current.term_key || '').startsWith('rolling:')
    && current.term_duration_months === 12
    && date(current.term_anchor_date)
    && current.term_anchor_date <= current.term_start_date
    && original?.start_mode === 'immediate'
    && original.billing_period === 'annual'
    && snapshot.start_mode === 'immediate'
    && original.tenant_id === current.tenant_id
    && original.id === current.config_id
    && !['direct_debit', 'gocardless', 'card_monthly', 'monthly_card', 'monthly_direct_debit']
      .includes(current.payment_method)
    && config?.start_mode === 'immediate'
    && config.billing_period === 'annual'
    && config.structure_scope_type === 'member'
    && config.tenant_id === current.tenant_id;
  return supported
    ? { supported: true, scope: MEMBER_AMENDMENT_READER_READY_SCOPES[0], blockers: [] }
    : { supported: false, scope: null, blockers: [
      'Operational readers support only personal twelve-month annual upfront rolling commitments with original and target immediate-start member structures; fixed-date, provider-linked, organisation, legacy and cadence-switch applications are disabled.',
    ] };
}

export function supportsMemberAmendmentReadOverlay(history) {
  return !!history?.id && !!history.member_id && !history.organization_id
    && history.membership_source !== 'organisation'
    && !!history.commitment_snapshot
    && history.commitment_snapshot.payment_frequency === 'upfront'
    && history.commitment_snapshot.billing_period === 'annual'
    && history.commitment_snapshot.config?.structure_scope_type === 'member'
    && !history.billing_agreement_id
    && date(history.term_start_date) && date(history.membership_renewal_date);
}

export function projectMemberAmendmentReadOverlay(history, application, {
  tenantId, asOf = new Date().toISOString().slice(0, 10), renewal = false,
} = {}) {
  if (!application) return history;
  if (!date(asOf) || !supportsMemberAmendmentReadOverlay(history)
    || history.tenant_id !== tenantId || application.tenant_id !== tenantId
    || application.member_id !== history.member_id || application.source_record_id !== history.id) {
    fail('Applied membership amendment ownership/purchase evidence is inconsistent');
  }
  const q = application.snapshot;
  const config = q?.targetSnapshot?.config;
  const band = q?.targetSnapshot?.band || null;
  if (!assessMemberAmendmentOperationalScope({ current: history, config }).supported) {
    fail('Applied membership amendment is outside the audited operational reader scope');
  }
  if (!application.amendment_id || !date(application.effective_date) || !date(application.expires_on)
    || application.effective_date < history.term_start_date
    || application.effective_date >= application.expires_on
    || application.expires_on !== history.membership_renewal_date
    || !config?.id || config.tenant_id !== tenantId || config.structure_scope_type !== 'member'
    || config.billing_period !== 'annual'
    || (band && (band.tenant_id !== tenantId || band.config_id !== config.id))
    || q.sourceSnapshot?.id !== history.id || q.currency !== history.currency
    || ['tenant_id', 'member_id', 'config_id', 'band_id', 'term_key',
      'term_start_date', 'term_end_date', 'membership_renewal_date']
      .some(key => (q.sourceSnapshot[key] ?? null) !== (history[key] ?? null))) {
    fail('Applied membership amendment target or original term evidence is inconsistent');
  }
  const evidence = {
    amendmentId: application.amendment_id, applicationId: application.id,
    effectiveDate: application.effective_date, expiresOn: application.expires_on,
    targetConfigId: config.id, targetBandId: band?.id || null,
    targetStructureName: config.name || null, targetTierLabel: band?.label || config.name || null,
    delta: q.delta, currency: q.currency, appliedAt: application.created_at,
  };
  // Audit evidence remains visible after expiry. Entitlement itself does not.
  const result = { ...history, membership_amendment_evidence: [evidence] };
  // Renewal uses the final purchased scope, including when the predecessor has
  // expired; this does not grant its entitlement beyond the original renewal.
  const scopeDate = renewal && asOf >= application.expires_on
    ? new Date(Date.parse(`${application.expires_on}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    : asOf;
  if (scopeDate < application.effective_date || scopeDate >= application.expires_on) return result;
  return {
    ...result, effective_membership_amendment: application,
    effective_config_id: config.id, effective_band_id: band?.id || null,
    effective_tier_label: band?.label || config.name || null,
    effective_commitment_snapshot: {
      ...history.commitment_snapshot, config, band,
      amendment_id: application.amendment_id, authority: 'settled_member_membership_amendment',
    },
  };
}

export async function resolveMemberAmendmentReadOverlay({ db, tenantId, history,
  asOf = new Date().toISOString().slice(0, 10), renewal = false }) {
  if (!supportsMemberAmendmentReadOverlay(history)) return history;
  if (history.tenant_id !== tenantId) fail('Membership amendment read tenant mismatch');
  const { data, error } = await db.from('member_membership_amendment_application').select('*')
    .eq('tenant_id', tenantId).eq('member_id', history.member_id)
    .eq('source_record_id', history.id).maybeSingle();
  // Before rollout there cannot be applied rows. Other read errors never mean
  // "no amendment", including permissions, malformed data and duplicate rows.
  if (error) {
    if (absentTable.has(error.code)) return history;
    const failure = new Error('Applied membership amendment evidence could not be read');
    failure.code = 'amendment_overlay_unavailable';
    throw failure;
  }
  return projectMemberAmendmentReadOverlay(history, data, { tenantId, asOf, renewal });
}

export async function resolveMemberAmendmentReadOverlays({ history, ...options }) {
  // Sequential reads keep serverless connection pressure bounded.
  const rows = [];
  for (const row of history) rows.push(await resolveMemberAmendmentReadOverlay({ ...options, history: row }));
  return rows;
}

// Reporting can load hundreds of histories. Resolve their current entitlement
// in tenant-scoped batches, not one database request per member.
export async function resolveMemberAmendmentReadOverlaysBatched({ db, tenantId, history,
  asOf = new Date().toISOString().slice(0, 10) }) {
  const candidates = history.filter(supportsMemberAmendmentReadOverlay);
  if (candidates.some(row => row.tenant_id !== tenantId)) fail('Membership amendment read tenant mismatch');
  const applications = new Map();
  for (let batch = 0; batch < candidates.length; batch += 100) {
    const ids = candidates.slice(batch, batch + 100).map(row => row.id);
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from('member_membership_amendment_application').select('*')
        .eq('tenant_id', tenantId).in('source_record_id', ids)
        .order('id', { ascending: true }).range(offset, offset + 499);
      if (error) {
        if (absentTable.has(error.code)) return history;
        const failure = new Error('Applied membership amendment evidence could not be read');
        failure.code = 'amendment_overlay_unavailable';
        throw failure;
      }
      if (!Array.isArray(data)) fail('Applied membership amendment page is invalid');
      for (const application of data) {
        if (application.tenant_id !== tenantId || !ids.includes(application.source_record_id)
          || applications.has(application.source_record_id)) fail('Applied membership amendment page ownership/uniqueness mismatch');
        applications.set(application.source_record_id, application);
      }
      if (data.length < 500) break;
    }
  }
  return history.map(row => projectMemberAmendmentReadOverlay(row, applications.get(row.id), { tenantId, asOf }));
}

export function effectiveMemberEntitlement(history) {
  if (!history?.effective_membership_amendment || !history.effective_commitment_snapshot) return null;
  return {
    config: history.effective_commitment_snapshot.config,
    band: history.effective_commitment_snapshot.band || null,
    configId: history.effective_config_id,
    tierLabel: history.effective_tier_label
      || history.effective_commitment_snapshot.band?.label
      || history.effective_commitment_snapshot.config?.name || null,
  };
}

import { computeAuthoritativeHiddenFieldIds } from './formFieldVisibility.js';
import { assertAffiliationFormCompatibility } from './formMemberAffiliationConfig.js';
import { resolveMemberAffiliationAnswers } from './formMemberAffiliationAnswers.js';
import { rulesUseLmicOperators } from './formLmicConditions.js';
import { loadTenantLmicCodes } from './tenantLmicCodes.js';
import { assertProfileFormRoute } from './profileAffiliationForms.js';
import { resolveProfileFormAffiliationAnswers } from './profileFormAffiliationAnswers.js';
import { attachRetainedRenewalAffiliations } from './retainedRenewalAffiliations.js';

export const MEMBER_AFFILIATION_TOKEN = '__member_affiliation_snapshot';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const stable = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});

export async function prepareMemberAffiliations({ db, form, tenantId, memberId, answers }) {
  assertAffiliationFormCompatibility(form);
  if (!memberId || form.tenant_id !== tenantId || !uuid(answers?.[MEMBER_AFFILIATION_TOKEN])) {
    throw new Error('Reload this form while signed in with your member account.');
  }
  const [{ data: setting, error: settingError }, { data: snapshot, error: snapshotError }] = await Promise.all([
    db.from('form_member_affiliation_config').select('config').eq('tenant_id', tenantId).eq('form_id', form.id).maybeSingle(),
    db.from('form_member_affiliation_snapshot').select('*').eq('id', answers[MEMBER_AFFILIATION_TOKEN])
      .eq('tenant_id', tenantId).eq('form_id', form.id).eq('member_id', memberId).maybeSingle(),
  ]);
  if (settingError || snapshotError || !setting?.config?.enabled || !snapshot
    || stable(snapshot.config) !== stable(setting.config)) throw new Error('Affiliation configuration changed or is unavailable. Reload before submitting.');
  if (!snapshot.result && Date.parse(snapshot.expires_at) <= Date.now()) throw new Error('Your affiliation details have expired. Reload before submitting.');
  if (snapshot.config.purpose === 'profile') {
    await assertProfileFormRoute(db, tenantId, memberId, form.id, snapshot.profile_policy_version);
  }
  return snapshot;
}

export async function completeMemberAffiliations({ db, form, tenantId, memberId, submission }) {
  const answers = submission.submission_data || {};
  if (submission.tenant_id !== tenantId || submission.form_id !== form.id || submission.created_member_id !== memberId) {
    throw new Error('The saved member submission could not be verified.');
  }
  const snapshot = await prepareMemberAffiliations({ db, form, tenantId, memberId, answers });
  const { error: bindError } = await db.rpc('form_member_affiliation_bind', {
    p_token: snapshot.id, p_submission: submission.id, p_actor: memberId,
  });
  if (bindError) throw new Error('The saved affiliation request could not be bound to this submission.');
  let status;
  if (snapshot.result?.committed === true) status = 'already_applied';
  else if (snapshot.result?.status === 'awaiting_review') status = 'awaiting_review';
  else {
    await attachRetainedRenewalAffiliations({ db, form, tenantId, memberId });
    const visibilityOptions = rulesUseLmicOperators(form.visibility_rules)
      ? { lmicCodes: await loadTenantLmicCodes(db, tenantId) } : {};
    const hiddenFieldIds = await computeAuthoritativeHiddenFieldIds({
      db, tenantId, form, formValues: answers, visibilityOptions,
    });
    const profile = snapshot.config.purpose === 'profile';
    const plan = (profile ? resolveProfileFormAffiliationAnswers : resolveMemberAffiliationAnswers)({ form, snapshot, answers, hiddenFieldIds });
    const awaitingReview = plan.status === 'awaiting_review';
    const { data: result, error } = await db.rpc(profile ? 'profile_form_affiliation_apply' : awaitingReview
      ? 'defer_form_member_affiliation_change' : 'form_member_affiliation_apply', awaitingReview ? {
      p_token: snapshot.id, p_submission: submission.id, p_details: plan.details, p_proposal: plan.proposal,
    } : {
      p_token: snapshot.id, p_submission: submission.id, p_primary: plan.proposal.primary,
      p_departments: plan.proposal.departments, p_secondary: plan.proposal.secondary,
      ...(profile ? { p_group: plan.proposal.group, p_details: plan.details } : {}),
    });
    if (error || (awaitingReview ? result?.status !== 'awaiting_review' : result?.committed !== true)) {
      throw new Error('Affiliation changes could not be confirmed. Your submission is saved; retry or ask an administrator to review it.');
    }
    status = awaitingReview ? 'awaiting_review' : result.replayed ? 'already_applied' : 'applied';
  }
  // Replays use the member's current association, never the old submitted
  // association: a later profile edit must not be undone by pipeline recovery.
  const { data: member, error: memberError } = await db.from('member').select('id,organization_id')
    .eq('tenant_id', tenantId).eq('id', memberId).single();
  if (memberError || !member) throw new Error('Updated member affiliations could not be loaded. Please retry.');
  return { status, organizationId: member.organization_id || null };
}

export function memberAffiliationPrefill(snapshot) {
  const { config: cfg, graph, member_id: memberId } = snapshot;
  const departments = graph.links.filter(e => e.relationship_definition_id === cfg.memberDepartmentDefinitionId)
    .map(e => e.source_record_id === memberId ? e.target_record_id : e.source_record_id);
  const forOrg = org => departments.filter(id => graph.recordLinks.some(e =>
    e.relationship_definition_id === cfg.departmentOrganizationDefinitionId
      && ((e.source_record_id === id && e.target_record_id === org) || (e.target_record_id === id && e.source_record_id === org))));
  const values = {};
  if (cfg.purpose === 'profile' || cfg.prefillAffiliationQuestions === true) {
    if (cfg.organizationGroupFieldId) values[cfg.organizationGroupFieldId] = snapshot.profile_group_id || '';
    if (cfg.countryFieldId) values[cfg.countryFieldId] = snapshot.profile_country || '';
    if (cfg.siteQuestionFieldId) values[cfg.siteQuestionFieldId] = graph.organization_id ? 'Yes' : 'No, I have a trust-wide or organisation-wide role';
    if (cfg.additionalQuestionFieldId) values[cfg.additionalQuestionFieldId] =
      graph.links.some(e => e.relationship_definition_id === cfg.secondaryMemberDefinitionId) ? 'Yes' : 'No';
  }
  for (const id of cfg.primaryOrganizationFieldIds || []) values[id] = graph.organization_id || '';
  if (cfg.primaryDepartmentsFieldId) values[cfg.primaryDepartmentsFieldId] = forOrg(graph.organization_id);
  if (cfg.additionalSitesFieldId) {
    values[cfg.additionalSitesFieldId] = graph.links.filter(e => e.relationship_definition_id === cfg.secondaryMemberDefinitionId).map(e => {
      const assignment = e.source_record_id === memberId ? e.target_record_id : e.source_record_id;
      const links = graph.recordLinks.filter(r => r.relationship_definition_id === cfg.secondaryOrganizationDefinitionId
        && [r.source_record_id, r.target_record_id].includes(assignment));
      if (links.length !== 1) throw new Error('An existing secondary affiliation needs administrator review.');
      const org = links[0].source_record_id === assignment ? links[0].target_record_id : links[0].source_record_id;
      return { _row_id: assignment, [cfg.secondaryOrganizationFieldId]: org,
        ...(cfg.secondaryDepartmentsFieldId ? { [cfg.secondaryDepartmentsFieldId]: forOrg(org) } : {}) };
    });
  }
  return { values, managedFieldIds: Object.keys(values) };
}

import { containsFormNotListedValue, FORM_NOT_LISTED_VALUE } from '../../shared/formNotListedChoice.js';
import { resolveMemberAffiliationAnswers } from './formMemberAffiliationAnswers.js';
import { originalAffiliationProposal } from './formAffiliationReview.js';

export function resolveProfileFormAffiliationAnswers(input) {
  const { snapshot, hiddenFieldIds } = input;
  const cfg = snapshot.config;
  const answers = structuredClone(input.answers);
  const supplied = id => id && !hiddenFieldIds.has(id) && Object.hasOwn(answers, id);
  const details = [];
  const captureUnknown = (container, id, kind, rowKey) => {
    if (!containsFormNotListedValue(container[id])) return false;
    details.push({ fieldId: id, kind, rowKey: rowKey || null,
      requestedName: String(container.__not_listed_choice_text?.[id] || '').slice(0, 2000) });
    return true;
  };
  let group = snapshot.profile_group_id || null;
  let unknownPrimary = false;
  if (supplied(cfg.organizationGroupFieldId)) {
    if (captureUnknown(answers, cfg.organizationGroupFieldId, 'organization_group')) {
      group = null;
      unknownPrimary = true;
    } else {
      group = answers[cfg.organizationGroupFieldId] || null;
      if (group && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(group)) {
        throw new Error('Choose a listed Organisation Group or Not listed.');
      }
    }
  }
  for (const id of cfg.primaryOrganizationFieldIds) {
    if (supplied(id) && captureUnknown(answers, id, 'organization')) {
      answers[id] = cfg.unknownOrganizationId;
      unknownPrimary = true;
    }
  }
  if (supplied(cfg.primaryDepartmentsFieldId) && captureUnknown(answers, cfg.primaryDepartmentsFieldId, 'department')) {
    const value = answers[cfg.primaryDepartmentsFieldId];
    answers[cfg.primaryDepartmentsFieldId] = (Array.isArray(value) ? value : [value]).filter(v => v !== FORM_NOT_LISTED_VALUE);
  }
  if (supplied(cfg.additionalSitesFieldId) && Array.isArray(answers[cfg.additionalSitesFieldId])) {
    for (const row of answers[cfg.additionalSitesFieldId]) {
      if (captureUnknown(row, cfg.secondaryOrganizationFieldId, 'organization', row._row_id)) {
        row[cfg.secondaryOrganizationFieldId] = cfg.unknownOrganizationId;
      }
      if (captureUnknown(row, cfg.secondaryDepartmentsFieldId, 'department', row._row_id)) {
        const value = row[cfg.secondaryDepartmentsFieldId];
        row[cfg.secondaryDepartmentsFieldId] = (Array.isArray(value) ? value : [value]).filter(v => v !== FORM_NOT_LISTED_VALUE);
      }
    }
  }
  const plan = resolveMemberAffiliationAnswers({ ...input, answers });
  if (unknownPrimary) plan.proposal.primary = cfg.unknownOrganizationId;
  else if (supplied(cfg.siteQuestionFieldId)
    && answers[cfg.siteQuestionFieldId] === 'No, I have a trust-wide or organisation-wide role') {
    plan.proposal.primary = null;
  }
  // An unknown Group can choose the fallback after ordinary primary-answer
  // reconciliation; it must not also survive as a secondary affiliation.
  if (plan.proposal.primary === cfg.unknownOrganizationId) {
    plan.proposal.secondary = plan.proposal.secondary.filter(id => id !== cfg.unknownOrganizationId);
  }
  // The original selections remain the baseline. Unknown names are retained
  // as submission evidence, never used to create shared records or DD cases.
  plan.proposal.group = group;
  return { ...plan, status: 'ready', details, baseline: {
    ...originalAffiliationProposal(snapshot), group: snapshot.profile_group_id || null,
  } };
}

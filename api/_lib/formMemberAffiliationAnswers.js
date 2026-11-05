import { containsFormNotListedValue } from '../../shared/formNotListedChoice.js';
import { getRepeatableRowHiddenChildIds } from '../../shared/formRepeatableRows.js';
import { collectAffiliationReviewRequests } from './formAffiliationReviewPolicy.js';
import { originalAffiliationProposal } from './formAffiliationReview.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const supplied = (answers, id, hidden) => !!id && !hidden.has(id) && Object.hasOwn(answers, id);
const single = value => {
  if (value == null || value === '') return null;
  if (!uuid(value)) throw new Error('Select a listed organisation or choose Not listed.');
  return value;
};
const multiple = value => {
  const values = value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
  if (values.length > 500 || values.some(v => !uuid(v)) || new Set(values).size !== values.length) {
    throw new Error('Department selections could not be verified.');
  }
  return values;
};

/**
 * Hidden IDs MUST be computed server-side from the saved form/rules.
 * Missing answers preserve data; explicitly answered empty sets clear it.
 * This function plans only. SQL revalidates targets and the original graph.
 */
export function resolveMemberAffiliationAnswers({ form, snapshot, answers, hiddenFieldIds }) {
  if (!(hiddenFieldIds instanceof Set) || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('Authoritative affiliation answers are required.');
  }
  const cfg = snapshot.config;
  const original = originalAffiliationProposal(snapshot);
  const graph = snapshot.graph;
  const choices = [];
  const evidence = (container, fieldId, kind, rowKey) => {
    const value = container[fieldId];
    choices.push({ fieldId, kind, visible: true, value, rowKey,
      notListedText: container.__not_listed_choice_text?.[fieldId] });
    return containsFormNotListedValue(value);
  };
  const currentDepartmentsFor = organizationId => original.departments.filter(id =>
    graph.recordLinks.some(edge => edge.relationship_definition_id === cfg.departmentOrganizationDefinitionId
      && ((edge.source_record_id === id && edge.target_record_id === organizationId)
        || (edge.target_record_id === id && edge.source_record_id === organizationId))));
  if (original.departments.length && !cfg.departmentOrganizationDefinitionId) {
    throw new Error('Department ownership must be configured before replacing affiliations.');
  }
  const primaryAnswers = (cfg.primaryOrganizationFieldIds || [])
    .filter(id => supplied(answers, id, hiddenFieldIds));
  let primary = original.primary;
  if (primaryAnswers.length) {
    const resolved = primaryAnswers.map(id => evidence(answers, id, 'organization')
      ? original.primary : single(answers[id])).filter(Boolean);
    const unique = [...new Set(resolved)];
    if (unique.length > 1) throw new Error('The visible organisation choices disagree.');
    primary = unique[0] || null;
  }
  const primaryDepartmentField = cfg.primaryDepartmentsFieldId;
  let primaryDepartments = currentDepartmentsFor(original.primary);
  if (supplied(answers, primaryDepartmentField, hiddenFieldIds)) {
    evidence(answers, primaryDepartmentField, 'department');
    const value = answers[primaryDepartmentField];
    primaryDepartments = multiple((Array.isArray(value) ? value : [value])
      .filter(v => v != null && v !== '' && !containsFormNotListedValue(v)));
  }
  let secondary = [...original.secondary];
  let secondaryDepartments = original.secondary.flatMap(currentDepartmentsFor);
  const additionalId = cfg.additionalSitesFieldId;
  if (supplied(answers, additionalId, hiddenFieldIds)) {
    const rows = answers[additionalId];
    const field = (form.fields || []).find(f => f.id === additionalId);
    if (!field || !Array.isArray(rows) || rows.length > 100) throw new Error('Additional affiliations could not be verified.');
    secondary = []; secondaryDepartments = [];
    const rowIds = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row._row_id !== 'string' || !row._row_id || rowIds.has(row._row_id)) {
        throw new Error('Additional affiliation rows need unique identities.');
      }
      rowIds.add(row._row_id);
      const hidden = getRepeatableRowHiddenChildIds(field, row, { hiddenFieldIds });
      const orgField = cfg.secondaryOrganizationFieldId;
      // A submitted row with no visible organisation cannot authorize removal
      // of an existing assignment whose identity is no longer represented.
      if (!supplied(row, orgField, hidden)) {
        throw new Error('Show an organisation choice for each additional affiliation before submitting.');
      }
      const unlistedOrganization = evidence(row, orgField, 'organization', row._row_id);
      const org = unlistedOrganization ? null : single(row[orgField]);
      if (org) {
        const duplicate = org === primary || secondary.includes(org);
        // Profile unknown answers share a canonical fallback. Keep every row's
        // department evidence, but persist the fallback affiliation only once.
        if (duplicate && !(cfg.purpose === 'profile' && org === cfg.unknownOrganizationId)) {
          throw new Error('Each additional organisation must be distinct.');
        }
        if (!duplicate) secondary.push(org);
      }
      const deptField = cfg.secondaryDepartmentsFieldId;
      if (supplied(row, deptField, hidden)) {
        const unlistedDepartments = evidence(row, deptField, 'department', row._row_id);
        if (!unlistedDepartments) secondaryDepartments.push(...multiple(row[deptField]));
        else {
          const value = row[deptField];
          secondaryDepartments.push(...multiple((Array.isArray(value) ? value : [value])
            .filter(v => !containsFormNotListedValue(v))));
        }
      } else if (org) secondaryDepartments.push(...currentDepartmentsFor(org));
    }
  }
  // Preserve orphaned historical department links rather than silently deleting
  // them. Final validation will require an explicit administrator resolution.
  const accounted = new Set([original.primary, ...original.secondary].flatMap(currentDepartmentsFor));
  const unclassified = original.departments.filter(id => !accounted.has(id));
  if (unclassified.length && cfg.purpose !== 'profile') throw new Error('Existing department affiliations need administrator review before replacement.');
  const details = collectAffiliationReviewRequests(choices);
  return {
    status: details.length ? 'awaiting_review' : 'ready',
    details,
    proposal: { primary, departments: [...new Set([...primaryDepartments, ...secondaryDepartments, ...(cfg.purpose === 'profile' ? unclassified : [])])], secondary },
  };
}

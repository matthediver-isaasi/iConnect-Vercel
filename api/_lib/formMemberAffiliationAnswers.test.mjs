import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberAffiliationAnswers } from './formMemberAffiliationAnswers.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  return {
    form: { fields: [{ id: 'sites', type: 'repeatable_row', children: [{ id: 'org' }, { id: 'depts' }] }] },
    snapshot: { member_id: id(1), config: { primaryOrganizationFieldIds: ['primary'],
      primaryDepartmentsFieldId: 'departments', memberDepartmentDefinitionId: id(10),
      departmentOrganizationDefinitionId: id(11), secondaryMemberDefinitionId: id(12),
      secondaryOrganizationDefinitionId: id(13), additionalSitesFieldId: 'sites',
      secondaryOrganizationFieldId: 'org', secondaryDepartmentsFieldId: 'depts' },
    graph: { organization_id: id(2), records: [], links: [
      { relationship_definition_id: id(10), source_record_id: id(1), target_record_id: id(4) },
      { relationship_definition_id: id(10), source_record_id: id(1), target_record_id: id(5) },
      { relationship_definition_id: id(12), source_record_id: id(1), target_record_id: id(6) },
    ], recordLinks: [
      { relationship_definition_id: id(11), source_record_id: id(2), target_record_id: id(4) },
      { relationship_definition_id: id(11), source_record_id: id(3), target_record_id: id(5) },
      { relationship_definition_id: id(13), source_record_id: id(6), target_record_id: id(3) },
    ] } },
    answers: {}, hiddenFieldIds: new Set(),
  };
}
test('missing and hidden answers preserve current affiliations', () => {
  for (const hidden of [false, true]) {
    const input = fixture();
    if (hidden) {
      input.answers = { primary: null, departments: [], sites: [] };
      input.hiddenFieldIds = new Set(['primary', 'departments', 'sites']);
    }
    assert.deepEqual(resolveMemberAffiliationAnswers(input).proposal, {
      primary: id(2), departments: [id(4), id(5)], secondary: [id(3)],
    });
  }
});
test('explicit secondary clear archives its department selections but preserves primary selections', () => {
  const input = fixture(); input.answers.sites = [];
  assert.deepEqual(resolveMemberAffiliationAnswers(input).proposal, {
    primary: id(2), departments: [id(4)], secondary: [],
  });
});
test('mixed known and Not-listed departments preserve the known proposal and defer everything', () => {
  const input = fixture();
  input.answers = { departments: [id(7), '__form_not_listed__'],
    __not_listed_choice_text: { departments: 'New department' } };
  const result = resolveMemberAffiliationAnswers(input);
  assert.equal(result.status, 'awaiting_review');
  assert.deepEqual(result.proposal.departments, [id(7), id(5)]);
  assert.equal(result.details[0].requestedName, 'New department');
  assert.equal(input.snapshot.graph.organization_id, id(2));
});
test('a new secondary row with no department answer cannot remove another retained primary department', () => {
  const input = fixture(); input.answers.sites = [{ _row_id: 'new', org: id(8) }];
  assert.deepEqual(resolveMemberAffiliationAnswers(input).proposal, {
    primary: id(2), departments: [id(4)], secondary: [id(8)],
  });
});
test('duplicate secondary organisations, malformed selections and unverified visibility fail closed', () => {
  for (const mutate of [
    input => { input.answers.sites = [{ _row_id: 'a', org: id(3) }, { _row_id: 'b', org: id(3) }]; },
    input => { input.answers.primary = { id: id(2) }; },
    input => { input.hiddenFieldIds = []; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => resolveMemberAffiliationAnswers(input));
  }
});

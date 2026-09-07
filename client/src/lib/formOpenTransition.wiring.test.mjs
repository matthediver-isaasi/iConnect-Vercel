import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('all public form runtimes use the shared in-place transition hook', async () => {
  const [standalone, embed, iedit] = await Promise.all([
    read('../pages/FormView.jsx'),
    read('../pages/EmbedForm.jsx'),
    read('../components/iedit/elements/IEditFormElement.jsx'),
  ]);
  for (const source of [standalone, embed, iedit]) {
    assert.match(source, /useFormOpenTransition/);
    assert.match(source, /transitionInitialValues/);
    assert.match(source, /isTransitioning/);
    assert.match(source, /transitionError/);
  }
  assert.match(iedit, /FORM_NO_RELATIONSHIP_VALUE/);
  assert.match(iedit, /onRelationshipEmptyStateChange=\{handleRelationshipEmptyStateChange\}/);
});

test('transition endpoint reloads persisted action and mappings server-side', async () => {
  const endpoint = await read('../../../api/public/form-transition.js');
  assert.match(endpoint, /findPersistedOpenFormAction/);
  assert.match(endpoint, /persisted\.action\.destination_form_id/);
  assert.match(endpoint, /normalizeFormTransitionMappings/);
  assert.match(endpoint, /mapFormTransitionValues/);
  assert.match(endpoint, /getTenantContext/);
  assert.match(endpoint, /authContext\.tenantId/);
  assert.match(endpoint, /assignmentWindowState/);
  assert.match(endpoint, /sourceAssignmentToken/);
  assert.doesNotMatch(endpoint, /req\.body\.destination/);
  assert.doesNotMatch(endpoint, /req\.body\.mappings/);
});

test('standalone and iEdit discard source draft identity on transition', async () => {
  const [standalone, iedit] = await Promise.all([
    read('../pages/FormView.jsx'),
    read('../components/iedit/elements/IEditFormElement.jsx'),
  ]);
  for (const source of [standalone, iedit]) {
    assert.match(source, /isTransitionDestination/);
    assert.match(source, /setResumeToken\(null\)/);
    assert.match(source, /setShowResumeLink\(false\)/);
  }
});

test('assignment tokens remain scoped to the originally assigned survey', async () => {
  const standalone = await read('../pages/FormView.jsx');
  assert.match(
    standalone,
    /assignmentToken[\s\S]*?String\(form\?\.id \|\| ''\) === String\(loadedForm\?\.id \|\| ''\)[\s\S]*?assignment_token/,
  );
});

test('anonymous member prefill caches and requests by active destination slug', async () => {
  const [standalone, embed] = await Promise.all([
    read('../pages/FormView.jsx'),
    read('../pages/EmbedForm.jsx'),
  ]);
  assert.match(standalone, /queryKey: \['prefill-member',[\s\S]*?form\?\.slug/);
  assert.match(embed, /queryKey: \['prefill-member-embedform',[\s\S]*?form\?\.slug/);
  assert.match(standalone, /getPrefillMember\(prefillMemberId, form\?\.slug/);
  assert.match(embed, /getPrefillMember\(prefillMemberId, form\?\.slug/);
});
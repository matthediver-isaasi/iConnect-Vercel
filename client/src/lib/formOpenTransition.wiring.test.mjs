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

test('all public form runtimes preserve and lock source content behind the shared transition overlay', async () => {
  const [overlay, standalone, embed, iedit] = await Promise.all([
    read('../components/forms/FormTransitionOverlay.jsx'),
    read('../pages/FormView.jsx'),
    read('../pages/EmbedForm.jsx'),
    read('../components/iedit/elements/IEditFormElement.jsx'),
  ]);

  assert.match(overlay, /Please hold tight for a few seconds…/);
  assert.match(overlay, /aria-busy=\{active \? 'true' : undefined\}/);
  assert.match(overlay, /inert=\{active \? '' : undefined\}/);
  assert.match(overlay, /role="status"/);
  assert.match(overlay, /aria-live="polite"/);
  assert.match(overlay, /motion-reduce:animate-none/);
  assert.match(overlay, /backdrop-blur/);

  for (const source of [standalone, embed, iedit]) {
    assert.match(source, /import FormTransitionOverlay/);
    assert.match(source, /<FormTransitionOverlay active=\{isTransitioning\}>/);
    assert.doesNotMatch(source, /if \(isLoading \|\| isTransitioning\)/);
  }
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

test('transition history restores source answers and cancels stale destination requests', async () => {
  const hook = await read('./useFormOpenTransition.js');

  assert.match(hook, /historyRef\.current\.push\(\{/);
  assert.match(hook, /formValues: \{ \.\.\.\(formValues \|\| \{\}\) \}/);
  assert.match(hook, /navigationPosition: navigationRef\.current/);
  assert.match(hook, /const previous = historyRef\.current\.pop\(\)/);
  assert.match(hook, /if \(returningToRef\.current\) return false/);
  assert.match(hook, /returningToRef\.current = String\(previous\.form\.id\)/);
  assert.match(hook, /requestRef\.current \+= 1/);
  assert.match(hook, /visitedRef\.current\.delete/);
  assert.match(hook, /setInitialValues\(previous\.formValues\)/);
  assert.match(hook, /setRestoreNavigation\(previous\.navigationPosition\)/);
  assert.match(hook, /canReturnToPreviousForm: historyDepth > 0/);
});

test('returning suspends the source action until its condition stops matching', async () => {
  const hook = await read('./useFormOpenTransition.js');

  assert.match(hook, /suspendedActionRef\.current = \{\s*formId: String\(previous\.form\.id\),\s*actionKey: previous\.actionKey/);
  assert.match(hook, /if \(!action\) \{\s*if \(suspended\?\.formId === activeFormId\) suspendedActionRef\.current = null/);
  assert.match(hook, /if \(suspended\.actionKey === actionKey\) return/);
  assert.match(hook, /firedRef\.current\.delete\(previous\.actionKey\)/);
});

test('all form runtimes expose first-position return and restore page or card position', async () => {
  const [standalone, embed, iedit] = await Promise.all([
    read('../pages/FormView.jsx'),
    read('../pages/EmbedForm.jsx'),
    read('../components/iedit/elements/IEditFormElement.jsx'),
  ]);

  for (const source of [standalone, embed, iedit]) {
    assert.match(source, /navigationPosition: \{ currentPageIndex, currentStep \}/);
    assert.match(source, /transitionRestoreNavigation\?\.currentPageIndex \?\? 0/);
    assert.match(source, /transitionRestoreNavigation\?\.currentStep \?\? 0/);
    assert.match(source, /canReturnToPreviousForm/);
    assert.match(source, /returnToPreviousForm/);
    assert.match(source, /button-return-to-source-form/);
    assert.match(source, /Back to previous form/);
  }
});
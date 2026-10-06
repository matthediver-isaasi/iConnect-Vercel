import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useState } from 'react';
const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider, useQuery } = require('@tanstack/react-query');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.invalid/forms/prefill', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true });
}
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
localStorage.setItem('tenant_slug', 'fixture');
const { createRoot } = await import('react-dom/client');
const { createPortal } = await import('react-dom');
const originalFetch = globalThis.fetch;
const unexpectedRequests = [];
globalThis.fetch = async url => {
  if (String(url).startsWith('/api/public/form-payment-providers')) {
    return { ok: true, json: async () => ({ providers: [
      { id: 'stripe', configured: true }, { id: 'gocardless', configured: true },
    ] }) };
  }
  unexpectedRequests.push(String(url));
  throw new Error(`Unexpected fixture request: ${url}`);
};
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
  assert.deepEqual(unexpectedRequests, []);
});

const bundle = await build({
  entryPoints: ['client/src/lib/formPrefillBarrier.fixture.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node',
  format: 'cjs', loader: { '.css': 'empty' }, logLevel: 'silent',
});
const module = new Module(`${process.cwd()}/prefill-test-memory.cjs`);
module.filename = `${process.cwd()}/prefill-test-memory.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const { FormPrefillBoundary, FormRenderer, FormPaymentSubmit, publicClient,
  useFormFieldPrefill, useConditionalFormFieldPrefillState, useDepartmentCurrentSet,
  initialPrefillState, combinePrefillStates } = module.exports;

const h = React.createElement;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
}
async function mount(Component, props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const render = async next => {
    await act(async () => root.render(h(QueryClientProvider, { client }, h(Component, next))));
    await flush();
  };
  await render(props);
  return { container, render, client, async close() {
    await act(async () => root.unmount()); client.clear(); container.remove();
  } };
}
function controls(state, values, submit, keydown) {
  return h(FormPrefillBoundary, { state },
    h('form', { onSubmit: event => { event.preventDefault(); submit?.(); }, onKeyDown: keydown },
      h(FormRenderer, { field: { id: 'answer', type: 'text', label: 'Answer' },
        value: values.answer || '', onChange: () => {} }),
      h('output', { 'data-values': true }, JSON.stringify(values)),
      h('button', { type: 'submit', onClick: submit, 'data-submit': true }, 'Submit')),
  );
}
function overlay(container) { return container.querySelector('[data-testid="form-prefill-overlay"]'); }
function values(container) { return JSON.parse(container.querySelector('output').textContent); }

test('slow sequential member → organisation → custom queries stay locked through application', async () => {
  const member = deferred(), org = deferred(), custom = deferred(), application = deferred();
  function Sequential() {
    const [answers, setAnswers] = useState({});
    const [applied, setApplied] = useState(false);
    const memberQuery = useQuery({ queryKey: ['member'], queryFn: () => member.promise });
    const orgQuery = useQuery({ queryKey: ['org', memberQuery.data?.organization_id],
      enabled: !!memberQuery.data?.organization_id, queryFn: () => org.promise });
    const customQuery = useQuery({ queryKey: ['custom', orgQuery.data?.id],
      enabled: !!orgQuery.data?.id, queryFn: () => custom.promise });
    const state = initialPrefillState({ expected: true, applied, initialized: true, queries: [
      { required: true, query: memberQuery },
      { required: !!memberQuery.data?.organization_id, query: orgQuery },
      { required: !!orgQuery.data?.id, query: customQuery },
    ] });
    useEffect(() => {
      if (!state.ready || applied) return;
      let cancelled = false;
      application.promise.then(() => {
        if (cancelled) return;
        setAnswers({ answer: customQuery.data.answer });
        setApplied(true);
      });
      return () => { cancelled = true; };
    }, [state.ready, applied, customQuery.data]);
    return controls(combinePrefillStates(state), answers);
  }
  const fixture = await mount(Sequential);
  try {
    assert.match(overlay(fixture.container).textContent, /Please wait while we load some data/);
    assert.equal(fixture.container.querySelector('input').disabled, true);
    await act(async () => member.resolve({ organization_id: 'fixture-org' })); await flush();
    assert.ok(overlay(fixture.container));
    await act(async () => org.resolve({ id: 'fixture-org' })); await flush();
    assert.ok(overlay(fixture.container));
    await act(async () => custom.resolve({ answer: 'Restored value' })); await flush();
    assert.ok(overlay(fixture.container), 'fetch completion is not application');
    assert.deepEqual(values(fixture.container), {});
    await act(async () => application.resolve()); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.deepEqual(values(fixture.container), { answer: 'Restored value' });
    assert.equal(fixture.container.querySelector('input').disabled, false);
  } finally { await fixture.close(); }
});

test('successful empty viewer booking settles the barrier without changing answers', async () => {
  const request = deferred();
  function ViewerBooking() {
    const [applied, setApplied] = useState(false);
    const query = useQuery({ queryKey: ['viewer-booking', 'authenticated-member'],
      queryFn: () => request.promise });
    const state = initialPrefillState({ expected: true, applied, initialized: true,
      queries: [{ required: true, query }] });
    useEffect(() => {
      if (!state.ready || applied) return;
      // FormView's empty-primary-entity path, after successful lookup.
      if (!query.data?.booking) setApplied(true);
    }, [state.ready, applied, query.data]);
    return controls(combinePrefillStates(state), { answer: 'Existing answer' });
  }
  const fixture = await mount(ViewerBooking);
  try {
    assert.ok(overlay(fixture.container));
    await act(async () => request.resolve({ booking: null, member: null, organization: null }));
    await flush();
    assert.equal(overlay(fixture.container), null);
    assert.equal(fixture.container.querySelector('input').disabled, false);
    assert.deepEqual(values(fixture.container), { answer: 'Existing answer' });
    const source = await readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /if \(!prefillBooking\) return/);
    assert.match(source, /if \(!primaryEntity\) \{\s*if \(entityPrefillExpected\) setPrefillApplied\(true\)/);
    assert.match(source, /if \(shouldBlockForMissingViewerBooking\(/);
  } finally { await fixture.close(); }
});

test('no prefill and disabled pending/idle queries never lock a regular form', async () => {
  function Regular() {
    const query = useQuery({ queryKey: ['disabled'], enabled: false, queryFn: () => { throw new Error('must not run'); } });
    const state = initialPrefillState({ expected: false, applied: false, initialized: false,
      queries: [{ required: false, query }] });
    return controls(combinePrefillStates(state), { answer: 'Existing edit' });
  }
  const fixture = await mount(Regular);
  try {
    assert.equal(overlay(fixture.container), null);
    assert.equal(fixture.container.querySelector('input').disabled, false);
    assert.equal(fixture.container.querySelector('[data-form-prefill-content]').hasAttribute('inert'), false);
  } finally { await fixture.close(); }
});

test('initial barriers ignore an old applied latch, wait for cached-data refetch, and expose paused-network retry', async () => {
  const oldLatch = initialPrefillState({ expected: true, applied: true, initialized: false,
    queries: [{ required: true, query: { status: 'success', isFetching: false } }] });
  assert.equal(oldLatch.pending, true);
  assert.equal(oldLatch.ready, false);
  const refetching = initialPrefillState({ expected: true, applied: false, initialized: true,
    queries: [{ required: true, query: { status: 'success', isFetching: true } }] });
  assert.equal(refetching.ready, false);
  let retried = 0;
  const paused = initialPrefillState({ expected: true, applied: false, initialized: true,
    queries: [{ required: true, query: { status: 'pending', fetchStatus: 'paused', refetch: () => retried++ } }] });
  assert.match(paused.error.message, /connection.*retry/i);
  await paused.error.retry();
  assert.equal(retried, 1);
});

test('failed required query presents retry, preserves answers, and unlocks only after successful application', async () => {
  let attempts = 0;
  const second = deferred();
  function Retry() {
    const [answers, setAnswers] = useState({ userEdit: 'Keep this' });
    const [applied, setApplied] = useState(false);
    const query = useQuery({ queryKey: ['retry'], queryFn: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('Temporary failure')) : second.promise;
    } });
    const state = initialPrefillState({ expected: true, applied, initialized: true,
      queries: [{ required: true, query, label: 'organisation custom fields' }] });
    useEffect(() => {
      if (!state.ready || applied) return;
      setAnswers(previous => ({ ...previous, answer: query.data.answer }));
      setApplied(true);
    }, [state.ready, applied, query.data]);
    return controls(combinePrefillStates(state), answers);
  }
  const fixture = await mount(Retry);
  try {
    assert.match(fixture.container.querySelector('[role="alert"]').textContent, /organisation custom fields.*retry/i);
    assert.equal(fixture.container.querySelector('[role="status"]'), null);
    await act(async () => overlay(fixture.container).querySelector('button').click()); await flush();
    assert.equal(attempts, 2);
    assert.ok(overlay(fixture.container));
    await act(async () => second.resolve({ answer: 'Loaded' })); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.deepEqual(values(fixture.container), { userEdit: 'Keep this', answer: 'Loaded' });
  } finally { await fixture.close(); }
});

test('inert, focus, keyboard, pointer and submit capture gate the whole form, then release', async () => {
  let submitted = 0, keys = 0;
  const submit = () => submitted++, keydown = () => keys++;
  function Boundary({ locked }) { return controls({ locked }, {}, submit, keydown); }
  const fixture = await mount(Boundary, { locked: false });
  try {
    const input = fixture.container.querySelector('input');
    const focusedButton = fixture.container.querySelector('[data-submit]');
    focusedButton.focus();
    assert.equal(document.activeElement, focusedButton);
    await fixture.render({ locked: true });
    assert.notEqual(document.activeElement, focusedButton);
    assert.ok(fixture.container.querySelector('[data-form-prefill-content]').hasAttribute('inert'));
    const keyboard = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(keyboard);
    fixture.container.querySelector('[data-submit]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    fixture.container.querySelector('form').dispatchEvent(submitEvent);
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    input.dispatchEvent(pointer);
    assert.equal(keys, 0); assert.equal(submitted, 0);
    assert.equal(keyboard.defaultPrevented, true);
    assert.equal(pointer.defaultPrevented, true); assert.equal(submitEvent.defaultPrevented, true);
    await fixture.render({ locked: false });
    fixture.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(submitted, 1);
  } finally { await fixture.close(); }
});

test('React-portalled picker actions are blocked as well as controls inside the inert subtree', async () => {
  const portal = document.createElement('div');
  document.body.append(portal);
  let actions = 0;
  function Portalled({ locked }) {
    return h(FormPrefillBoundary, { state: { locked } },
      createPortal(h('button', { onClick: () => actions++ }, 'Picker option'), portal));
  }
  const fixture = await mount(Portalled, { locked: true });
  try {
    const button = portal.querySelector('button');
    button.click();
    assert.equal(actions, 0);
    button.focus();
    assert.notEqual(document.activeElement, button);
    await fixture.render({ locked: false });
    portal.querySelector('button').click();
    assert.equal(actions, 1);
  } finally { await fixture.close(); portal.remove(); }
});

const reactiveForm = {
  id: 'reactive', slug: 'reactive', prefill_source: 'form_field', prefill_source_field_id: 'org',
  fields: [{ id: 'org', type: 'organisation_dropdown' }, { id: 'answer', type: 'text', prefill_field: 'org:name' }],
};
test('reactive lookup is locked synchronously; retry preserves draft/user ownership and release commits applied values', async () => {
  const original = publicClient.getFormFieldPrefill;
  const request = deferred(), retry = deferred();
  let attempts = 0;
  publicClient.getFormFieldPrefill = () => (++attempts === 1 ? request.promise : retry.promise);
  function Reactive() {
    const [answers, setAnswers] = useState({ org: 'org-id', answer: 'Draft answer' });
    const state = useFormFieldPrefill({ form: reactiveForm, formValues: answers, setFormValues: setAnswers,
      protectedFieldIds: ['answer'] });
    return controls(combinePrefillStates(state), answers);
  }
  const fixture = await mount(Reactive);
  try {
    assert.ok(overlay(fixture.container));
    await act(async () => request.reject(new Error('Temporary outage'))); await flush();
    assert.ok(fixture.container.querySelector('[role="alert"]'));
    await act(async () => overlay(fixture.container).querySelector('button').click()); await flush();
    await act(async () => retry.resolve({ values: { answer: 'Must not overwrite draft' } })); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.equal(values(fixture.container).answer, 'Draft answer');
  } finally { publicClient.getFormFieldPrefill = original; await fixture.close(); }
});

test('conditional sequential lookup remains locked until its returned values have been applied by the host effect', async () => {
  const original = publicClient.getFormFieldPrefill, request = deferred();
  publicClient.getFormFieldPrefill = () => request.promise;
  const form = { ...reactiveForm, visibility_rules: [{ id: 'rule', actions: [{
    id: 'copy', action_type: 'set_value', target_field_id: 'answer',
    set_value_source: 'prefill', set_value_prefill_field: 'core.name',
  }] }] };
  function Conditional() {
    const [answers, setAnswers] = useState({ org: 'org-id' });
    const state = useConditionalFormFieldPrefillState({ form, formValues: answers });
    useEffect(() => {
      if (state.values.action_copy) setAnswers(previous => ({ ...previous, answer: state.values.action_copy }));
    }, [state.values]);
    return controls(combinePrefillStates(state), answers);
  }
  const fixture = await mount(Conditional);
  try {
    assert.ok(overlay(fixture.container));
    await act(async () => request.resolve({ conditionalValues: { action_copy: 'Organisation name' } })); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.equal(values(fixture.container).answer, 'Organisation name');
  } finally { publicClient.getFormFieldPrefill = original; await fixture.close(); }
});

const paymentQuote = { matched: true, quote: { required: true, amount: 127.92, currency: 'GBP',
  membership: { monthly_card: { monthlyAmount: 10.66, instalmentCount: 12, planTotal: 127.92, currency: 'GBP' },
    direct_debit_allowed: true, direct_debit: { monthlyAmount: 10.66, instalmentCount: 12, planTotal: 127.92, currency: 'GBP' } } } };
test('payment choices cannot validate or launch while the shared prefill context is locked', async () => {
  let validations = 0, normal = 0;
  function Payment({ locked }) {
    return h(FormPrefillBoundary, { state: { locked } }, h(FormPaymentSubmit, {
      field: { id: 'payment', type: 'membership_payment', payment_providers: ['stripe', 'gocardless'] },
      membershipQuote: paymentQuote,
      formId: 'fixture-form', formSlug: 'fixture-form', formValues: {},
      paymentSettings: { stripe_enabled: true },
      buildPayload: () => { validations++; return null; },
      onNormalSubmit: () => normal++,
    }));
  }
  const fixture = await mount(Payment, { locked: true });
  try {
    const buttons = [...fixture.container.querySelector('[data-form-prefill-content]').querySelectorAll('button')];
    assert.equal(buttons.length, 3);
    for (const button of buttons) {
      await act(async () => button.click());
      assert.equal(button.disabled, true);
    }
    assert.equal(validations, 0); assert.equal(normal, 0);
  } finally { await fixture.close(); }
});

test('prefill beginning during awaited payment validation prevents checkout creation', async () => {
  const validation = deferred();
  let validations = 0;
  function Payment({ locked }) {
    return h(FormPrefillBoundary, { state: { locked } }, h(FormPaymentSubmit, {
      field: { id: 'race', payment_providers: ['stripe', 'gocardless'] }, membershipQuote: paymentQuote,
      buildPayload: () => { validations++; return validation.promise; },
    }));
  }
  const fixture = await mount(Payment, { locked: false });
  try {
    const fullCard = fixture.container.querySelector('[data-testid="button-form-payment-stripe-race"]');
    assert.ok(fullCard);
    await act(async () => fullCard.click());
    assert.equal(validations, 1);
    await fixture.render({ locked: true });
    await act(async () => validation.resolve({ form_id: 'fixture', submission_data: {} })); await flush();
    assert.deepEqual(unexpectedRequests, [], 'no checkout request is made after locking');
    assert.ok(overlay(fixture.container));
  } finally { await fixture.close(); }
});

test('draft restoration and subsequent reactive prefill form one barrier and never overwrite a restored answer', async () => {
  const original = publicClient.getFormFieldPrefill, draftRequest = deferred(), prefillRequest = deferred();
  let calls = 0;
  publicClient.getFormFieldPrefill = () => { calls++; return prefillRequest.promise; };
  function Draft() {
    const [answers, setAnswers] = useState({});
    const [loaded, setLoaded] = useState(false);
    const query = useQuery({ queryKey: ['draft'], queryFn: () => draftRequest.promise });
    useEffect(() => {
      if (!query.data || loaded) return;
      setAnswers(query.data);
      setLoaded(true);
    }, [query.data, loaded]);
    const reactive = useFormFieldPrefill({ form: reactiveForm, formValues: answers,
      setFormValues: setAnswers, enabled: loaded, protectedFieldIds: Object.keys(query.data || {}) });
    return controls(combinePrefillStates({ pending: !loaded }, reactive), answers);
  }
  const fixture = await mount(Draft);
  try {
    assert.ok(overlay(fixture.container)); assert.equal(calls, 0);
    await act(async () => draftRequest.resolve({ org: 'org-id', answer: 'Intentional draft answer' })); await flush();
    assert.ok(overlay(fixture.container)); assert.equal(calls, 1);
    await act(async () => prefillRequest.resolve({ values: { answer: 'Different prefill' } })); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.equal(values(fixture.container).answer, 'Intentional draft answer');
  } finally { publicClient.getFormFieldPrefill = original; await fixture.close(); }
});

test('Department hydration waits for baseline application; incomplete success has a useful retry instead of eternal spinner', async () => {
  const original = publicClient.getDepartmentCurrentSet;
  const request = deferred(), retry = deferred();
  let attempts = 0;
  publicClient.getDepartmentCurrentSet = () => (++attempts === 1 ? request.promise : retry.promise);
  const departmentId = '11111111-1111-4111-8111-111111111111';
  const form = { id: 'department', slug: 'department', current_set_enabled: true,
    current_set_configuration: { workforce_field_id: 'workforce', equipment_field_id: 'equipment' } };
  function Department() {
    const [answers, setAnswers] = useState({ answer: 'Keep draft answer' });
    const state = useDepartmentCurrentSet({ form, departmentId, principalId: 'fixture-member',
      formValues: answers, setFormValues: setAnswers, ready: true });
    return controls(combinePrefillStates({ pending: !state.baselineReady,
      error: state.error ? { message: state.error.message, retry: state.retry } : null }), answers);
  }
  const fixture = await mount(Department);
  try {
    assert.ok(overlay(fixture.container));
    await act(async () => request.resolve({ department_id: departmentId, version: 'v1' })); await flush();
    assert.match(fixture.container.querySelector('[role="alert"]').textContent, /incomplete.*retry/i);
    await act(async () => overlay(fixture.container).querySelector('button').click()); await flush();
    await act(async () => retry.resolve({
      department_id: departmentId, version: 'v1',
      complete_sections: ['workforce', 'equipment'],
      form_values: { workforce: [{ _row_id: 'row-1', grade: 'Band 6' }], equipment: [],
        __department_current_set: { department_id: departmentId, version: 'v1', complete_sections: ['workforce', 'equipment'] } },
    })); await flush();
    assert.equal(overlay(fixture.container), null);
    assert.equal(values(fixture.container).workforce[0].grade, 'Band 6');
    assert.equal(values(fixture.container).answer, 'Keep draft answer');
  } finally { publicClient.getDepartmentCurrentSet = original; await fixture.close(); }
});

test('all changed respondent and manual surfaces bundle with real imports', async () => {
  const result = await build({
    entryPoints: ['client/src/pages/FormView.jsx', 'client/src/pages/EmbedForm.jsx',
      'client/src/components/iedit/elements/IEditFormElement.jsx', 'client/src/components/ManualSubmissionDialog.jsx'],
    outdir: 'in-memory-only', bundle: true, write: false, packages: 'external',
    platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 4);
});

test('all embedding paths wire the shared barrier and submission gates; legacy public loading replacement is removed', async () => {
  const paths = ['../pages/FormView.jsx', '../pages/EmbedForm.jsx', '../components/iedit/elements/IEditFormElement.jsx'];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /prefillState=\{prefillState\}/);
    assert.match(source, /if \(prefillState\.locked \|\| isTransitioning\) return/);
    assert.match(source, /entityPrefillState\.ready/);
  }
  const canvas = await readFile(new URL(paths[2], import.meta.url), 'utf8');
  assert.doesNotMatch(canvas, /if \(isPrefillLoading\)/);
  const manual = await readFile(new URL('../components/ManualSubmissionDialog.jsx', import.meta.url), 'utf8');
  assert.match(manual, /<FormPrefillBoundary state=\{prefillState\}/);
  assert.match(manual, /if \(prefillState\.locked\) return/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/membership-application',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = (await import('react')).default;
const { act, useEffect, useRef, useState } = React;
const { createRoot } = await import('react-dom/client');
const {
  createSetValueConvergenceState,
  mergeSemanticFormValueUpdates,
  planSemanticFormValueUpdate,
} = await import('./formValueConvergence.js');

function MembershipRuleRuntime({
  formId,
  initialValues,
  resolveUpdates,
  onRender,
  onAppliedUpdate,
  onWarning,
}) {
  const [values, setValues] = useState(initialValues);
  const convergence = useRef(createSetValueConvergenceState());
  onRender();

  useEffect(() => {
    const updates = resolveUpdates(values);
    const transition = planSemanticFormValueUpdate(convergence.current, {
      formId,
      currentValues: values,
      updates,
    });
    if (transition.apply) {
      onAppliedUpdate();
      setValues((previous) => mergeSemanticFormValueUpdates(previous, updates));
    } else if (transition.shouldWarn) {
      onWarning();
    }
  }, [formId, values, resolveUpdates, onAppliedUpdate, onWarning]);

  return React.createElement('output', null, JSON.stringify(values));
}

async function mountRuntime(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MembershipRuleRuntime, props));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return {
    text: container.textContent,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('mounted membership rule paths settle with bounded renders and state updates', async () => {
  const paths = [
    {
      name: 'static',
      initialValues: { class: 'member', target: '' },
      resolveUpdates: () => ({ target: 'configured' }),
    },
    {
      name: 'field',
      initialValues: { class: 'member', source: { ids: ['a'] }, target: null },
      resolveUpdates: (values) => ({
        target: { ids: [...values.source.ids] },
      }),
    },
    {
      name: 'formula',
      initialValues: { class: 'member', left: '2', right: '3', target: '' },
      resolveUpdates: (values) => ({
        target: String(Number(values.left) + Number(values.right)),
      }),
    },
    {
      name: 'prefill',
      initialValues: { class: 'member', target: { id: 'org-1', label: 'Example' } },
      resolveUpdates: () => ({
        target: { label: 'Example', id: 'org-1' },
      }),
    },
  ];

  for (const scenario of paths) {
    let renders = 0;
    let appliedUpdates = 0;
    let warnings = 0;
    const mounted = await mountRuntime({
      formId: `membership-${scenario.name}`,
      initialValues: scenario.initialValues,
      resolveUpdates: scenario.resolveUpdates,
      onRender: () => { renders += 1; },
      onAppliedUpdate: () => { appliedUpdates += 1; },
      onWarning: () => { warnings += 1; },
    });

    assert.ok(renders <= 2, `${scenario.name} rendered ${renders} times`);
    assert.ok(appliedUpdates <= 1, `${scenario.name} applied ${appliedUpdates} updates`);
    assert.equal(warnings, 0, `${scenario.name} emitted a warning`);
    await mounted.cleanup();
  }
});

test('mounted cyclic membership rules stop after one transition and one warning', async () => {
  let renders = 0;
  let appliedUpdates = 0;
  let warnings = 0;
  const mounted = await mountRuntime({
    formId: 'membership-cycle',
    initialValues: { class: 'member', target: 'left' },
    resolveUpdates: (values) => ({
      target: values.target === 'left' ? 'right' : 'left',
    }),
    onRender: () => { renders += 1; },
    onAppliedUpdate: () => { appliedUpdates += 1; },
    onWarning: () => { warnings += 1; },
  });

  assert.ok(renders <= 2);
  assert.equal(appliedUpdates, 1);
  assert.equal(warnings, 1);
  assert.match(mounted.text, /"target":"right"/);
  await mounted.cleanup();
});
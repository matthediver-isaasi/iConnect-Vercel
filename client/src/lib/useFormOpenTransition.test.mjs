import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://example.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { publicClient } = await import('../api/publicClient.js');
const { useFormOpenTransition } = await import('./useFormOpenTransition.js');

const openForm = (id, targetId = null) => ({
  id,
  slug: `form-${id}`,
  fields: [],
  visibility_rules: targetId ? [{
    id: `rule-${id}`,
    conditions: [{ field_id: 'route', operator: 'equals', value: 'yes' }],
    actions: [{
      id: `open-${targetId}`,
      action_type: 'open_form',
      destination_form_id: targetId,
    }],
  }] : [],
});

let latest;
let setValuesExternal;
let setNavigationExternal;
let setUserFieldExternal;

function Harness({ initialForm, initialValues, initialNavigation }) {
  const [values, setValues] = useState(initialValues);
  const [navigation, setNavigation] = useState(initialNavigation);
  const lastChangedFieldRef = React.useRef({ formId: null, fieldId: null, revision: 0 });
  const transition = useFormOpenTransition({
    initialForm,
    formValues: values,
    enabled: true,
    navigationPosition: navigation,
    lastChangedField: lastChangedFieldRef.current,
  });

  useEffect(() => {
    setValues(transition.initialValues);
    setNavigation(transition.restoreNavigation || { currentPageIndex: 0, currentStep: 0 });
  }, [transition.activeForm.id, transition.initialValues, transition.restoreNavigation]);

  latest = { ...transition, values, navigation };
  setValuesExternal = setValues;
  setNavigationExternal = setNavigation;
  setUserFieldExternal = (fieldId, value) => {
    lastChangedFieldRef.current = {
      formId: transition.activeForm.id,
      fieldId,
      revision: lastChangedFieldRef.current.revision + 1,
    };
    setValues(previous => ({ ...previous, [fieldId]: value }));
  };
  return null;
}

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

test('returns to the source snapshot, re-arms after unmatching, and ignores a late nested target', async () => {
  const forms = {
    a: openForm('a', 'b'),
    b: openForm('b', 'c'),
    c: openForm('c'),
  };
  const originalResolve = publicClient.resolveFormTransition;
  const originalGetForm = publicClient.getForm;
  let pendingCResolve;
  let resolveCalls = 0;

  publicClient.resolveFormTransition = async ({ source_form_id }) => {
    resolveCalls += 1;
    if (source_form_id === 'b') {
      return new Promise(resolve => {
        pendingCResolve = () => resolve({
          target_form_id: 'c',
          target_slug: 'form-c',
          mapped_values: {},
        });
      });
    }
    return {
      target_form_id: 'b',
      target_slug: 'form-b',
      mapped_values: { carried: 'mapped' },
    };
  };
  publicClient.getForm = async slug => forms[slug.slice(-1)];

  const root = createRoot(document.getElementById('root'));
  const upload = new dom.window.File(['contents'], 'evidence.txt', { type: 'text/plain' });
  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        initialForm: forms.a,
        initialValues: { route: 'no', name: 'Original answer' },
        initialNavigation: { currentPageIndex: 2, currentStep: 4 },
      }));
    });

    await act(async () => {
      setNavigationExternal({ currentPageIndex: 2, currentStep: 4 });
      setValuesExternal({ route: 'yes', name: 'Original answer', upload });
    });
    await flush();
    assert.equal(latest.activeForm.id, 'b');
    assert.deepEqual(latest.values, { carried: 'mapped' });
    assert.equal(latest.canReturnToPreviousForm, true);

    await act(async () => {
      latest.returnToPreviousForm();
    });
    assert.equal(latest.activeForm.id, 'a');
    assert.equal(latest.values.route, undefined);
    assert.equal(latest.values.name, 'Original answer');
    assert.equal(latest.values.upload, upload, 'non-JSON answer objects must retain identity');
    assert.deepEqual(latest.navigation, { currentPageIndex: 2, currentStep: 4 });
    await flush();
    assert.equal(latest.activeForm.id, 'a', 'a still-matching source must not bounce immediately');

    await act(async () => setValuesExternal(previous => ({ ...previous, route: 'yes' })));
    await flush();
    assert.equal(latest.activeForm.id, 'b');
    assert.equal(resolveCalls, 2);

    await act(async () => setValuesExternal(previous => ({ ...previous, route: 'yes' })));
    await flush();
    assert.equal(latest.isTransitioning, true);
    assert.equal(typeof pendingCResolve, 'function');

    await act(async () => {
      latest.returnToPreviousForm();
    });
    assert.equal(latest.activeForm.id, 'a');

    await act(async () => pendingCResolve());
    await flush();
    assert.equal(latest.activeForm.id, 'a', 'late nested transition must not replace restored source');
  } finally {
    publicClient.resolveFormTransition = originalResolve;
    publicClient.getForm = originalGetForm;
    await act(async () => root.unmount());
  }
});

test('a rapid double return from a settled chain pops only one form', async () => {
  const forms = {
    a: openForm('a', 'b'),
    b: openForm('b', 'c'),
    c: openForm('c'),
  };
  const originalResolve = publicClient.resolveFormTransition;
  const originalGetForm = publicClient.getForm;

  publicClient.resolveFormTransition = async ({ source_form_id }) => ({
    target_form_id: source_form_id === 'a' ? 'b' : 'c',
    target_slug: source_form_id === 'a' ? 'form-b' : 'form-c',
    mapped_values: {},
  });
  publicClient.getForm = async slug => forms[slug.slice(-1)];

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        initialForm: forms.a,
        initialValues: {},
        initialNavigation: { currentPageIndex: 0, currentStep: 0 },
      }));
    });
    await act(async () => setValuesExternal({ route: 'yes', source: 'a' }));
    await flush();
    assert.equal(latest.activeForm.id, 'b');

    await act(async () => {
      setNavigationExternal({ currentPageIndex: 1, currentStep: 3 });
      setValuesExternal({ route: 'yes', source: 'b' });
    });
    await flush();
    assert.equal(latest.activeForm.id, 'c');

    await act(async () => {
      assert.equal(latest.returnToPreviousForm(), true);
      assert.equal(latest.returnToPreviousForm(), false);
    });
    assert.equal(latest.activeForm.id, 'b');
    assert.equal(latest.canReturnToPreviousForm, true);
    assert.equal(latest.values.route, undefined);
    assert.equal(latest.values.source, 'b');
    assert.deepEqual(latest.navigation, { currentPageIndex: 1, currentStep: 3 });

    await act(async () => setValuesExternal(previous => ({ ...previous, route: 'yes' })));
    await flush();
    assert.equal(latest.activeForm.id, 'c', 'popped target must be visitable again after re-arming');
  } finally {
    publicClient.resolveFormTransition = originalResolve;
    publicClient.getForm = originalGetForm;
    await act(async () => root.unmount());
  }
});

test('keeps the respondent trigger pending when a later automatic update completes an AND rule', async () => {
  const rule = {
    logic: 'and',
    conditions: [
      { field_id: 'chosen_route', operator: 'equals', value: 'Apply' },
      { field_id: 'automatic_status', operator: 'equals', value: 'Ready' },
    ],
    actions: [{
      id: 'open-b',
      action_type: 'open_form',
      destination_form_id: 'b',
    }],
  };
  const forms = {
    a: {
      id: 'a',
      slug: 'form-a',
      fields: [],
      visibility_rules: [rule],
    },
    b: openForm('b'),
  };
  const originalResolve = publicClient.resolveFormTransition;
  const originalGetForm = publicClient.getForm;

  publicClient.resolveFormTransition = async () => ({
    target_form_id: 'b',
    target_slug: 'form-b',
    mapped_values: {},
  });
  publicClient.getForm = async () => forms.b;

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        initialForm: forms.a,
        initialValues: { chosen_route: '', automatic_status: 'Waiting', untouched: 'keep' },
        initialNavigation: { currentPageIndex: 1, currentStep: 0 },
      }));
    });
    await act(async () => {
      setValuesExternal({ chosen_route: '', automatic_status: 'Waiting', untouched: 'keep' });
    });

    await act(async () => setUserFieldExternal('chosen_route', 'Apply'));
    await flush();
    assert.equal(latest.activeForm.id, 'a');

    await act(async () => {
      setValuesExternal(previous => ({ ...previous, automatic_status: 'Ready' }));
    });
    await flush();
    assert.equal(latest.activeForm.id, 'b');

    await act(async () => latest.returnToPreviousForm());
    assert.equal(latest.activeForm.id, 'a');
    assert.equal(latest.values.chosen_route, undefined);
    assert.equal(latest.values.automatic_status, 'Ready');
    assert.equal(latest.values.untouched, 'keep');
    await flush();
    assert.equal(latest.activeForm.id, 'a', 'automatic value must not cause an immediate re-transition');

    await act(async () => setUserFieldExternal('chosen_route', 'Apply'));
    await flush();
    assert.equal(latest.activeForm.id, 'b', 're-entering the cleared answer must trigger again');
  } finally {
    publicClient.resolveFormTransition = originalResolve;
    publicClient.getForm = originalGetForm;
    await act(async () => root.unmount());
  }
});

test('preserves a nonmatching respondent answer when an automatic OR branch triggers', async () => {
  const rule = {
    logic: 'or',
    conditions: [
      { field_id: 'respondent_branch', operator: 'equals', value: 'yes' },
      { field_id: 'automatic_branch', operator: 'equals', value: 'yes' },
    ],
    actions: [{
      id: 'open-b',
      action_type: 'open_form',
      destination_form_id: 'b',
    }],
  };
  const forms = {
    a: { id: 'a', slug: 'form-a', fields: [], visibility_rules: [rule] },
    b: openForm('b'),
  };
  const originalResolve = publicClient.resolveFormTransition;
  const originalGetForm = publicClient.getForm;

  publicClient.resolveFormTransition = async () => ({
    target_form_id: 'b',
    target_slug: 'form-b',
    mapped_values: {},
  });
  publicClient.getForm = async () => forms.b;

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        initialForm: forms.a,
        initialValues: {},
        initialNavigation: { currentPageIndex: 0, currentStep: 0 },
      }));
    });
    await act(async () => {
      setValuesExternal({ respondent_branch: '', automatic_branch: 'no', untouched: 'keep' });
    });
    await act(async () => setUserFieldExternal('respondent_branch', 'no'));
    await flush();
    assert.equal(latest.activeForm.id, 'a');

    await act(async () => {
      setValuesExternal(previous => ({ ...previous, automatic_branch: 'yes' }));
    });
    await flush();
    assert.equal(latest.activeForm.id, 'b');

    await act(async () => latest.returnToPreviousForm());
    assert.equal(latest.activeForm.id, 'a');
    assert.equal(latest.values.respondent_branch, 'no');
    assert.equal(latest.values.automatic_branch, undefined);
    assert.equal(latest.values.untouched, 'keep');
  } finally {
    publicClient.resolveFormTransition = originalResolve;
    publicClient.getForm = originalGetForm;
    await act(async () => root.unmount());
  }
});
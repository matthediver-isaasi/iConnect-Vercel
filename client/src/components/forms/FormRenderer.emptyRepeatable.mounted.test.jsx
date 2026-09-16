import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/repeatable-empty',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  DocumentFragment: window.DocumentFragment,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.localStorage.setItem('tenant_slug', 'test-tenant');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => [{ id: 'org-1', name: 'One Organisation' }],
});

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: FormRenderer } = await import('./FormRenderer.jsx');
const { FORM_NOT_LISTED_VALUE } = await import('../../../../shared/formNotListedChoice.js');
const { publicClient } = await import('../../api/publicClient.js');

after(() => {
  globalThis.fetch = originalFetch;
});

function formDefinition(layout) {
  return {
    fields: [
      {
        id: 'source-organisation',
        type: 'organisation_dropdown',
        label: 'Already selected organisation',
      },
      {
        id: 'people',
        type: 'repeatable_rows',
        label: 'Organisations',
        description: 'Add each organisation once.',
        layout,
        hide_when_first_column_empty: true,
        children: [{
          id: 'organisation',
          type: 'organisation_dropdown',
          label: 'Organisation',
          description: 'The organisation to include.',
          exclude_values_from: {
            scope: 'form',
            source_field_id: 'source-organisation',
          },
        }, {
          id: 'notes',
          type: 'text',
          label: 'Notes',
        }],
      },
    ],
    values: {
      'source-organisation': 'org-1',
      people: [{
        _row_id: `row-${layout}`,
        organisation: 'org-1',
        notes: 'Retained row',
      }],
    },
  };
}

function FormProjectionHarness({ definition, mode, onVisibilityChange }) {
  const [hidden, setHidden] = React.useState(false);
  const handleVisibility = React.useCallback((...event) => {
    setHidden(event[1]);
    onVisibilityChange?.(...event);
  }, [onVisibilityChange]);
  return React.createElement(
    'div',
    { 'data-testid': `form-mode-${mode}` },
    React.createElement(
      FormRenderer,
      {
        field: definition.fields[1],
        value: definition.values.people,
        onChange: () => {},
        onValidityChange: () => {},
        onRepeatableVisibilityChange: handleVisibility,
        formSlug: 'repeatable-empty',
        allFields: definition.fields,
        allFormValues: definition.values,
        rootAllFields: definition.fields,
        rootAllFormValues: definition.values,
      },
    ),
    React.createElement(
      'output',
      { 'data-testid': `visible-field-count-${mode}` },
      hidden ? 0 : 1,
    ),
  );
}

function renderHarness({
  root,
  queryClient,
  definition,
  mode,
  onVisibilityChange,
}) {
  root.render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(FormProjectionHarness, {
        definition,
        mode,
        onVisibilityChange,
      }),
    ),
  );
}

function ControlledRepeatableHarness({ layout }) {
  const [sourceOrganisation, setSourceOrganisation] = React.useState('');
  const [values, setValues] = React.useState(() => ({
    people: [{
      _row_id: `controlled-${layout}`,
      organisation: 'org-1',
      notes: 'Controlled retained row',
    }],
  }));
  const definition = formDefinition(layout);
  const fields = definition.fields;
  const allFormValues = {
    ...values,
    'source-organisation': sourceOrganisation,
  };
  return React.createElement(
    'div',
    null,
    React.createElement(
      FormRenderer,
      {
        field: fields[1],
        value: values.people,
        onChange: next => setValues(current => ({ ...current, people: next })),
        onValidityChange: () => {},
        onRepeatableVisibilityChange: () => {},
        formSlug: 'repeatable-empty',
        allFields: fields,
        allFormValues,
        rootAllFields: fields,
        rootAllFormValues: allFormValues,
      },
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': `toggle-source-${layout}`,
        onClick: () => setSourceOrganisation(current => (current ? '' : 'org-1')),
      },
      'Toggle source organisation',
    ),
    React.createElement(
      'output',
      { 'data-testid': `controlled-values-${layout}` },
      JSON.stringify(values),
    ),
  );
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

test('controlled rows preserve first-column and sibling answers while exclusion hides then restores them', {
  concurrency: false,
}, async () => {
  const layout = 'cards';
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ControlledRepeatableHarness, { layout }),
        ),
      );
    });
    await settle();
    const valuesOutput = () => JSON.parse(
      container.querySelector(`[data-testid="controlled-values-${layout}"]`).textContent,
    );
    assert.deepEqual(valuesOutput().people[0], {
      _row_id: 'controlled-cards',
      organisation: 'org-1',
      notes: 'Controlled retained row',
    });

    await act(async () => {
      container.querySelector(`[data-testid="toggle-source-${layout}"]`).click();
    });
    await settle();
    assert.ok(container.querySelector('[data-testid="repeatable-empty-container-people"]')?.hidden);
    assert.deepEqual(
      valuesOutput().people[0],
      {
        _row_id: 'controlled-cards',
        organisation: 'org-1',
        notes: 'Controlled retained row',
      },
      'the hidden row retains Column A and sibling answers in controlled state',
    );

    await act(async () => {
      container.querySelector(`[data-testid="toggle-source-${layout}"]`).click();
    });
    await settle();
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
    );
    assert.ok(container.querySelector('[data-testid="repeatable-row-people-0"]'));
    assert.deepEqual(valuesOutput().people[0], {
      _row_id: 'controlled-cards',
      organisation: 'org-1',
      notes: 'Controlled retained row',
    });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('availability applies a no-match fallback exclusion before deciding the domain is empty', {
  concurrency: false,
}, async () => {
  const definition = formDefinition('cards');
  definition.values['source-organisation'] = '';
  definition.fields[1].children[0].conditional_filters = {
    version: 1,
    rules: [{
      id: 'matched-rule',
      source_field_id: 'source-organisation',
      operator: 'equals',
      value: 'matched',
      is_fallback: false,
      allowed_values: ['org-1'],
      org_filter: null,
    }, {
      id: 'fallback-exclude',
      source_field_id: '',
      operator: 'equals',
      value: '',
      is_fallback: true,
      allowed_values: ['org-1'],
      allowed_values_mode: 'exclude',
      org_filter: null,
    }],
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      renderHarness({
        root,
        queryClient,
        definition,
        mode: 'fallback-exclusion',
      });
    });
    await settle();
    assert.ok(
      container.querySelector('[data-testid="repeatable-empty-container-people"]')?.hidden,
      'the fallback excludes the only organisation even when the raw response contains it',
    );
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout} hides the complete section and restores the retained row`, {
    concurrency: false,
  }, async () => {
    const mode = layout === 'cards' ? 'standalone' : 'embed';
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const visibility = [];
    try {
      const excludedDefinition = formDefinition(layout);
      await act(async () => {
        renderHarness({
          root,
          queryClient,
          definition: excludedDefinition,
          mode,
          onVisibilityChange: (...event) => visibility.push(event),
        });
      });
      await settle();

      const section = container.querySelector('[data-testid="repeatable-empty-container-people"]');
      assert.ok(section, 'the empty resolver keeps a hidden section mounted');
      assert.equal(section.hidden, true);
      assert.match(section.textContent, /Organisations/);
      assert.match(section.textContent, /Add each organisation once/);
      assert.ok(container.querySelector('[data-testid="repeatable-row-people-0"]'));
      assert.equal(
        container.querySelector(`[data-testid="visible-field-count-${mode}"]`).textContent,
        '0',
        'the standalone/embed projection removes the field while its resolver stays mounted',
      );
      assert.ok(visibility.some(([, hidden, status]) => hidden && status === 'resolved'));

      const notListedDefinition = formDefinition(layout);
      notListedDefinition.fields[1].children[0].not_listed_choice = {
        enabled: true,
        label: 'Another organisation',
      };
      await act(async () => {
        renderHarness({
          root,
          queryClient,
          definition: notListedDefinition,
          mode,
          onVisibilityChange: (...event) => visibility.push(event),
        });
      });
      await settle();
      assert.equal(
        section.hidden,
        false,
        'an enabled Not Listed sentinel keeps an excluded organisation domain actionable',
      );

      const availableDefinition = formDefinition(layout);
      availableDefinition.values = {
        ...availableDefinition.values,
        'source-organisation': '',
      };
      await act(async () => {
        renderHarness({
          root,
          queryClient,
          definition: availableDefinition,
          mode,
          onVisibilityChange: (...event) => visibility.push(event),
        });
      });
      await settle();

      assert.equal(section.hidden, false, 'a restored option domain shows the whole section');
      assert.equal(
        container.querySelector(`[data-testid="visible-field-count-${mode}"]`).textContent,
        '1',
      );
      assert.ok(container.querySelector(`[data-testid="repeatable-row-people-0"]`));
      assert.equal(
        container.querySelector('[data-testid="repeatable-row-people-0"] input[type="text"]')?.value,
        'Retained row',
      );
      assert.ok(visibility.some(([, hidden, status]) => !hidden && status === 'resolved'));
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
}

test('a form-scoped group Not Listed prerequisite remains visible', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const definition = formDefinition('cards');
  definition.fields[0] = {
    id: 'source-group',
    type: 'organisation_group_dropdown',
    label: 'Already selected group',
  };
  definition.fields[1].children[0].organisation_group_parent_field_id = 'source-group';
  definition.fields[1].children[0].organisation_group_parent_scope = 'form';
  definition.values = {
    ...definition.values,
    'source-organisation': undefined,
    'source-group': FORM_NOT_LISTED_VALUE,
  };
  const visibility = [];
  try {
    await act(async () => {
      renderHarness({
        root,
        queryClient,
        definition,
        mode: 'standalone',
        onVisibilityChange: (...event) => visibility.push(event),
      });
    });
    await settle();
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
    );
    assert.ok(container.querySelector('[data-testid="repeatable-rows-people"]'));
    assert.ok(visibility.some(([, hidden, status]) => !hidden && status === 'missing_prerequisite'));
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('external row replacement does not reuse availability from a removed row', async () => {
  const originalList = publicClient.listFormOrganizationOptions;
  let resolvedOptions = [{ id: 'org-1', name: 'One Organisation' }];
  publicClient.listFormOrganizationOptions = async () => resolvedOptions;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const first = formDefinition('cards');
    first.values['source-organisation'] = '';
    await act(async () => {
      renderHarness({
        root,
        queryClient,
        definition: first,
        mode: 'standalone',
      });
    });
    await settle();
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
    );

    resolvedOptions = [];
    const replacement = formDefinition('cards');
    replacement.values = {
      ...replacement.values,
      'source-organisation': '',
      people: [{
        _row_id: 'replacement-row',
        organisation: '',
        notes: 'Replacement',
      }],
    };
    await act(async () => {
      renderHarness({
        root,
        queryClient,
        definition: replacement,
        mode: 'standalone',
      });
    });
    await settle();
    assert.ok(container.querySelector('[data-testid="repeatable-empty-container-people"]'));
  } finally {
    publicClient.listFormOrganizationOptions = originalList;
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/repeatable-row-visibility',
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

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  default: FormRenderer,
  RepeatableAvailabilityProbe,
} = await import('./FormRenderer.jsx');
const { publicClient } = await import('../../api/publicClient.js');

after(() => dom.window.close());

function repeatableField(layout) {
  return {
    id: `rows-${layout}`,
    type: 'repeatable_rows',
    label: 'Rows',
    layout,
    min_rows: 0,
    max_rows: 3,
    children: [
      {
        id: 'driver',
        type: 'dropdown',
        label: 'Driver',
        options: ['show', 'hide'],
      },
      {
        id: 'retained-source',
        type: 'dropdown',
        label: 'Retained source',
        options: ['yes', 'no'],
        row_visibility: {
          mode: 'hide_when',
          source_field_id: 'driver',
          value: 'hide',
        },
      },
      {
        id: 'raw-dependent',
        type: 'text',
        label: 'Raw dependent',
        required: true,
        row_visibility: {
          mode: 'show_when',
          source_field_id: 'retained-source',
          value: 'yes',
        },
      },
      {
        id: 'hideable-required',
        type: 'text',
        label: 'Hideable required',
        required: true,
        row_visibility: {
          mode: 'show_when',
          source_field_id: 'driver',
          value: 'show',
        },
      },
    ],
  };
}

function Harness({ layout }) {
  const field = React.useMemo(() => repeatableField(layout), [layout]);
  const [rows, setRows] = React.useState(() => [{
    _row_id: `retained-${layout}`,
    driver: 'show',
    'retained-source': 'yes',
    'raw-dependent': 'retained answer',
    'hideable-required': '',
  }]);
  const [valid, setValid] = React.useState(null);
  return React.createElement(
    'div',
    null,
    React.createElement(FormRenderer, {
      field,
      value: rows,
      onChange: setRows,
      onValidityChange: (_fieldId, isValid) => setValid(isValid),
      allFields: [field],
      rootAllFields: [field],
      allFormValues: {},
      rootAllFormValues: {},
    }),
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': `toggle-driver-${layout}`,
        onClick: () => setRows(current => current.map(row => ({
          ...row,
          driver: row.driver === 'show' ? 'hide' : 'show',
        }))),
      },
      'Toggle driver',
    ),
    React.createElement('output', { 'data-testid': `rows-${layout}` }, JSON.stringify(rows)),
    React.createElement('output', { 'data-testid': `valid-${layout}` }, String(valid)),
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

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout} hides and restores independently while retaining raw answers`, {
    concurrency: false,
  }, async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Harness, { layout }),
        ));
      });
      await settle();

      assert.match(container.textContent, /Raw dependent/);
      assert.equal(
        container.querySelector(`[data-testid="valid-${layout}"]`).textContent,
        'false',
        'a visible required child reports its initial error',
      );

      await act(async () => {
        container.querySelector(`[data-testid="toggle-driver-${layout}"]`).click();
      });
      await settle();

      // The retained source is hidden, but its raw answer still drives the
      // dependent child. This catches validation/rendering based on projected
      // rows rather than raw rows.
      assert.match(container.textContent, /Raw dependent/);
      if (layout === 'cards') {
        assert.doesNotMatch(container.textContent, /Hideable required/);
      }
      assert.equal(
        container.querySelector(`[data-testid="valid-${layout}"]`).textContent,
        'true',
        'hidden required cells do not leave stale validity behind',
      );
      const retained = JSON.parse(container.querySelector(`[data-testid="rows-${layout}"]`).textContent);
      assert.equal(retained[0]['retained-source'], 'yes');
      assert.equal(retained[0]['raw-dependent'], 'retained answer');

      if (layout === 'cards') {
        assert.equal(
          container.querySelector('[data-testid="repeatable-row-rows-cards-0"]')
            .textContent.includes('Retained source'),
          false,
        );
      } else {
        const hiddenCell = container.querySelector(
          '[data-testid="repeatable-spreadsheet-cell-rows-spreadsheet-0-retained-source"]',
        );
        assert.ok(hiddenCell);
        assert.equal(hiddenCell.querySelector('input, textarea, select, button'), null);
      }

      await act(async () => {
        container.querySelector(`[data-testid="toggle-driver-${layout}"]`).click();
      });
      await settle();
      assert.match(container.textContent, /Retained source/);
      assert.match(container.textContent, /Hideable required/);
      assert.equal(
        container.querySelector(`[data-testid="valid-${layout}"]`).textContent,
        'false',
        'restoring a required child restores its validation error',
      );
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });

  test(`${layout} adds and removes rows without changing retained row identity`, {
    concurrency: false,
  }, async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Harness, { layout }),
        ));
      });
      await settle();
      const add = container.querySelector(`[data-testid="button-add-repeatable-row-rows-${layout}"]`);
      await act(async () => add.click());
      await settle();
      assert.equal(container.querySelectorAll(`[data-testid^="repeatable-row-rows-${layout}-"]`).length, 2);
      const rowsAfterAdd = JSON.parse(container.querySelector(`[data-testid="rows-${layout}"]`).textContent);
      assert.equal(rowsAfterAdd[0]._row_id, `retained-${layout}`);

      await act(async () => {
        container.querySelector(`[data-testid="button-remove-repeatable-row-rows-${layout}-1"]`).click();
      });
      await settle();
      const rowsAfterRemove = JSON.parse(container.querySelector(`[data-testid="rows-${layout}"]`).textContent);
      assert.deepEqual(rowsAfterRemove.map(row => row._row_id), [`retained-${layout}`]);
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
}

function hiddenProbeField(layout) {
  return {
    id: `probe-rows-${layout}`,
    type: 'repeatable_rows',
    label: 'Organisations',
    layout,
    hide_when_first_column_empty: true,
    min_rows: 1,
    max_rows: 2,
    children: [
      {
        id: 'organisation',
        type: 'organisation_dropdown',
        label: 'Organisation',
        row_visibility: {
          mode: 'hide_when',
          source_field_id: 'gate',
          value: 'hide',
        },
      },
      {
        id: 'gate',
        type: 'select',
        label: 'Gate',
        options: ['show', 'hide'],
      },
    ],
  };
}

function FullAvailabilityHarness({ layout, optionsRef }) {
  const field = React.useMemo(() => hiddenProbeField(layout), [layout]);
  const [hidden, setHidden] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  const props = {
    field,
    value: [{
      _row_id: `full-probe-row-${layout}`,
      organisation: 'org-1',
      gate: 'hide',
    }],
    onChange: () => {},
    onValidityChange: () => {},
    onRepeatableVisibilityChange: (_fieldId, nextHidden) => setHidden(nextHidden),
    formSlug: `repeatable-row-visibility-full-${layout}-${revision}`,
    allFields: [field],
    rootAllFields: [field],
    allFormValues: {},
    rootAllFormValues: {},
    hiddenFieldIds: hidden ? new Set([field.id, 'organisation', 'gate']) : new Set(),
  };
  return React.createElement(
    'div',
    null,
    hidden
      ? React.createElement(RepeatableAvailabilityProbe, { ...props, key: 'probe' })
      : React.createElement(FormRenderer, { ...props, key: 'visible' }),
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': `upstream-change-${layout}`,
        onClick: () => {
          optionsRef.current = [{ id: 'org-1', name: 'One Organisation' }];
          setRevision(current => current + 1);
        },
      },
      'Restore organisation domain',
    ),
    React.createElement('output', { 'data-testid': `full-hidden-${layout}` }, String(hidden)),
  );
}

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout} availability probe keeps a hidden first resolver mounted`, {
    concurrency: false,
  }, async () => {
    const originalList = publicClient.listFormOrganizationOptions;
    publicClient.listFormOrganizationOptions = async () => [
      { id: 'org-1', name: 'One Organisation' },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const field = hiddenProbeField(layout);
    const hiddenFieldIds = new Set([field.id, 'organisation', 'gate']);
    try {
      await act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(RepeatableAvailabilityProbe, {
            field,
            value: [{
              _row_id: `probe-row-${layout}`,
              organisation: 'org-1',
              gate: 'hide',
            }],
            onChange: () => {},
            onValidityChange: () => {},
            onRepeatableVisibilityChange: (_fieldId, hidden, status) => {
              const output = container.querySelector(`[data-testid="probe-state-${layout}"]`);
              if (output) output.textContent = JSON.stringify({ hidden, status });
            },
            formSlug: 'repeatable-row-visibility',
            allFields: [field],
            rootAllFields: [field],
            allFormValues: {},
            rootAllFormValues: {},
            hiddenFieldIds,
          }),
          React.createElement('output', { 'data-testid': `probe-state-${layout}` }),
        ));
      });
      await settle();
      await settle();

      const state = JSON.parse(
        container.querySelector(`[data-testid="probe-state-${layout}"]`).textContent,
      );
      assert.equal(state.status, 'resolved');
      assert.equal(
        state.hidden,
        false,
        'the first-column resolver resolves the available organisation domain even while the parent is hidden',
      );
      assert.ok(
        container.querySelector(`[data-testid="repeatable-empty-probe-probe-rows-${layout}"]`),
        'probe remains mounted in the FormView/Embed hidden-field path',
      );
    } finally {
      publicClient.listFormOrganizationOptions = originalList;
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
}

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout} restores after upstream availability changes while first child is row-hidden`, {
    concurrency: false,
  }, async () => {
    const originalList = publicClient.listFormOrganizationOptions;
    const optionsRef = { current: [] };
    publicClient.listFormOrganizationOptions = async () => optionsRef.current;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FullAvailabilityHarness, { layout, optionsRef }),
        ));
      });
      await settle();
      assert.equal(
        container.querySelector(`[data-testid="full-hidden-${layout}"]`).textContent,
        'true',
        'the initial empty domain hides the repeatable field',
      );

      await act(async () => {
        container.querySelector(`[data-testid="upstream-change-${layout}"]`).click();
      });
      await settle();
      await settle();

      assert.equal(
        container.querySelector(`[data-testid="full-hidden-${layout}"]`).textContent,
        'false',
        'the upstream option change restores the repeatable field',
      );
      assert.ok(container.querySelector(`[data-testid="repeatable-rows-probe-rows-${layout}"]`));
      assert.ok(
        container.querySelector(`[data-testid="repeatable-availability-resolver-probe-rows-${layout}-0"]`),
        'the ordinary renderer keeps a hidden first-column resolver mounted',
      );
    } finally {
      publicClient.listFormOrganizationOptions = originalList;
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
}
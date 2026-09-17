import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/future-date',
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
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.localStorage.setItem('tenant_slug', 'test-tenant');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('future-date renderer test must not make network requests');
};
after(() => {
  globalThis.fetch = originalFetch;
});

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: FormRenderer } = await import('./FormRenderer.jsx');
const { tomorrowUtcDate } = await import('../../../../shared/formFutureDates.js');

test('future-only native dates render the UTC min and accessible invalid state', async () => {
  const today = new Date();
  const value = [
    today.getUTCFullYear(),
    String(today.getUTCMonth() + 1).padStart(2, '0'),
    String(today.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const validity = [];
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(FormRenderer, {
          field: {
            id: 'arrival',
            type: 'date',
            label: 'Arrival',
            future_only: true,
          },
          value,
          onChange: () => {},
          onValidityChange: (_fieldId, valid) => validity.push(valid),
        }),
      ),
    );
  });

  const input = container.querySelector('[data-testid="input-date-arrival"]');
  assert.ok(input);
  assert.equal(input.min, tomorrowUtcDate(today));
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'help-date-arrival error-date-arrival');
  assert.match(container.textContent, /Date must be in the future/i);
  assert.deepEqual(validity, [false]);

  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

test('future-only native dates schedule and reschedule at UTC midnight', async () => {
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field: {
              id: 'arrival-timer',
              type: 'date',
              label: 'Arrival',
              future_only: true,
            },
            value: '',
            onChange: () => {},
          }),
        ),
      );
    });

    assert.ok(scheduled.length >= 1);
    const now = new Date();
    const nextUtcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const expectedDelay = nextUtcMidnight - now.getTime();
    const boundaryTimer = scheduled.find(timer => Math.abs(timer.delay - expectedDelay) < 1000);
    assert.ok(boundaryTimer, `a next-midnight timer should be scheduled (timers: ${scheduled.map(timer => timer.delay).join(', ')})`);
    assert.ok(boundaryTimer.delay > 0);
    assert.ok(boundaryTimer.delay <= 24 * 60 * 60 * 1000);
    assert.ok(
      Math.abs(boundaryTimer.delay - expectedDelay) < 1000,
      `expected next UTC midnight delay, got ${boundaryTimer.delay}; expected ${expectedDelay}`,
    );

    await act(async () => boundaryTimer.callback());
    assert.ok(scheduled.length >= 2, 'midnight callback should schedule the next boundary');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('legacy future-date repeatable rows keep deterministic IDs through sibling edits', async () => {
  const changes = [];
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = {
    id: 'people',
    type: 'repeatable_rows',
    label: 'People',
    children: [
      { id: 'date', type: 'date', label: 'Date', future_only: true },
      { id: 'name', type: 'text', label: 'Name' },
    ],
  };
  const legacyValue = [{ date: '2099-01-01', name: 'Original' }];

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: legacyValue,
            onChange: next => changes.push(next),
          }),
        ),
      );
    });

    const canonical = changes.at(-1);
    assert.ok(canonical?.[0]?._row_id?.startsWith('legacy_'));
    const originalId = canonical[0]._row_id;
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: [{ ...canonical[0], name: 'Sibling edit' }],
            onChange: next => changes.push(next),
          }),
        ),
      );
    });

    const dateInput = container.querySelector('input[type="date"]');
    assert.ok(dateInput);
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    await act(async () => {
      setInputValue.call(dateInput, '2026-03-10');
      dateInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const edited = changes.at(-1);
    assert.equal(edited?.[0]?._row_id, originalId);
    assert.equal(edited?.[0]?.name, 'Sibling edit');
    assert.equal(edited?.[0]?.date, '2026-03-10');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('repeatable month dates preserve the original historical value and require an explicit change', async () => {
  const changes = [];
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = {
    id: 'periods',
    type: 'repeatable_rows',
    layout: 'spreadsheet',
    children: [{
      id: 'period',
      type: 'date',
      label: 'Reporting period',
      date_precision: 'month',
      date_restriction: 'any',
    }],
  };
  const historicValue = [{ _row_id: 'historic', period: '2020-04-17' }];

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: historicValue,
            disabled: true,
            onChange: next => changes.push(next),
          }),
        ),
      );
    });

    assert.match(container.textContent, /Saved answer: 2020-04-17/);
    assert.ok(container.querySelector('[data-testid="saved-date-period-historic"]'));
    assert.equal(container.querySelector('[data-testid="button-change-date-period-historic"]'), null);
    assert.deepEqual(changes, []);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field: { ...field, layout: 'cards' },
            value: historicValue,
            disabled: true,
            onChange: next => changes.push(next),
          }),
        ),
      );
    });
    assert.match(container.textContent, /Saved answer: 2020-04-17/);
    assert.equal(container.querySelector('[data-testid="button-change-date-period-historic"]'), null);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('repeatable month entry preserves a month selected before its year and rejects the incomplete optional answer', async () => {
  const changes = [];
  const validity = [];
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = {
    id: 'period',
    type: 'date',
    label: 'Reporting period',
    date_precision: 'month',
    date_restriction: 'any',
    repeatable_container_field_id: 'rows',
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: '',
            onChange: value => changes.push(value),
            onValidityChange: (_id, valid) => validity.push(valid),
          }),
        ),
      );
    });

    const month = container.querySelector('[aria-label="Reporting period Month"]');
    const year = container.querySelector('[aria-label="Reporting period Year"]');
    assert.ok(month);
    assert.ok(year);
    await act(async () => {
      month.value = '02';
      month.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.equal(changes.at(-1), '-02');
    assert.equal(year.value, '');
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: '-02',
            onChange: value => changes.push(value),
            onValidityChange: (_id, valid) => validity.push(valid),
          }),
        ),
      );
    });
    assert.match(container.textContent, /month/i);
    assert.equal(validity.at(-1), false);

    // A controlled remount still displays the incomplete answer instead of
    // treating it as an empty optional value.
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: '-02',
            onChange: value => changes.push(value),
            onValidityChange: (_id, valid) => validity.push(valid),
          }),
        ),
      );
    });
    assert.ok(container.querySelector('[aria-label="Reporting period Month"]'));
    assert.equal(container.querySelector('[aria-label="Reporting period Month"]').value, '02');
    assert.equal(container.querySelector('[aria-label="Reporting period Year"]').value, '');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('repeatable year input keeps invalid pasted text visible instead of sanitizing it', async () => {
  const changes = [];
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = {
    id: 'period',
    type: 'date',
    label: 'Reporting period',
    date_precision: 'year',
    date_restriction: 'any',
    repeatable_container_field_id: 'rows',
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: '',
            onChange: value => changes.push(value),
          }),
        ),
      );
    });
    const year = container.querySelector('[aria-label="Reporting period Year"]');
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    await act(async () => {
      setInputValue.call(year, '20xx26');
      year.dispatchEvent(new window.Event('input', { bubbles: true }));
      year.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.equal(changes.at(-1), '20xx26');
    assert.equal(year.value, '20xx26');
    assert.match(container.textContent, /year/i);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('repeatable future month choices disable months outside the selected year boundary', async () => {
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = {
    id: 'period',
    type: 'date',
    label: 'Reporting period',
    date_precision: 'month',
    date_restriction: 'future',
    repeatable_container_field_id: 'rows',
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FormRenderer, {
            field,
            value: '',
            onChange: () => {},
          }),
        ),
      );
    });
    const now = new Date();
    const currentYear = String(now.getUTCFullYear());
    const currentMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
    const month = container.querySelector('[aria-label="Reporting period Month"]');
    const year = container.querySelector('[aria-label="Reporting period Year"]');
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    await act(async () => {
      setInputValue.call(year, currentYear);
      year.dispatchEvent(new window.Event('input', { bubbles: true }));
      year.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const previousMonth = String(Number(currentMonth) - 1).padStart(2, '0');
    if (previousMonth === '00') {
      assert.equal(month.querySelector('option[value="12"]').disabled, true);
    } else {
      assert.equal(month.querySelector(`option[value="${previousMonth}"]`).disabled, true);
    }
    assert.equal(month.querySelector(`option[value="${currentMonth}"]`).disabled, true);
    const nextMonth = String(Number(currentMonth) + 1).padStart(2, '0');
    if (nextMonth !== '13') {
      assert.equal(month.querySelector(`option[value="${nextMonth}"]`).disabled, false);
    }
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
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
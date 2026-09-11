import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/example',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  history: window.history,
  location: window.location,
  sessionStorage: window.sessionStorage,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const {
  FormPaymentReturnScreen,
  useFormPaymentReturn,
} = await import('./FormPaymentReturn.jsx');
const {
  savePaymentSubmissionContext,
} = await import('../../lib/formPaymentReturn.js');

function HookProbe() {
  const paymentReturn = useFormPaymentReturn();
  if (!paymentReturn.active) return React.createElement('output', { 'data-testid': 'inactive' });
  return React.createElement(FormPaymentReturnScreen, {
    ...paymentReturn,
    onRecheck: paymentReturn.recheck,
    onReturnToForm: paymentReturn.dismiss,
  });
}

test('hook resumes a path-scoped refresh and preserves setup_complete truthfully', async () => {
  window.sessionStorage.clear();
  savePaymentSubmissionContext({
    submissionId: 'submission-1',
    provider: 'stripe_monthly_card',
    pathname: '/forms/example',
  });
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        provider: 'stripe_monthly_card',
        status: 'setup_complete',
        paymentSucceeded: true,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(HookProbe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(calls.length, 1, 'StrictMode effect probe shares the in-flight confirmation');
  assert.equal(calls[0].submission_id, 'submission-1');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment setup complete');
  assert.match(container.textContent, /first collection has not yet been confirmed/i);
  assert.doesNotMatch(container.textContent, /submission is complete/i);
  assert.doesNotMatch(container.textContent, /Payment received/);
  assert.ok(window.sessionStorage.length > 0, 'setup_complete remains resumable on refresh');
  assert.ok(container.querySelector('[data-testid="button-payment-return-recheck"]'));

  await act(async () => root.unmount());
  const refreshedRoot = createRoot(container);
  await act(async () => {
    refreshedRoot.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.length, 2, 'refresh safely rechecks the same setup');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment setup complete');
  await act(async () => refreshedRoot.unmount());
  container.remove();
});

test('verified paid receipt survives refresh without confirming or reopening payment', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-paid',
    provider: 'stripe',
    terminalStatus: 'paid',
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('a paid receipt must not call confirm');
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(calls, 0);
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment received');
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('a paid confirmation writes the terminal receipt used by refresh', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example?form_payment_submission=sub-confirmed&form_payment_provider=stripe');
  savePaymentSubmissionContext({
    submissionId: 'sub-confirmed',
    provider: 'stripe',
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ status: 'paid', provider: 'stripe' }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 1);
  assert.match(window.sessionStorage.getItem('form_payment_pending_submission'), /"terminalStatus":"paid"/);

  await act(async () => root.unmount());
  const refreshedRoot = createRoot(container);
  await act(async () => {
    refreshedRoot.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 1, 'the receipt restores paid UI without a second confirm');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment received');
  await act(async () => refreshedRoot.unmount());
  container.remove();
});

test('blocked screen has safe recheck but no return-to-payment affordance', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'blocked',
    provider: null,
    error: 'The result is not yet clear.',
    canRecheck: true,
    onRecheck: () => {},
    onReturnToForm: () => {},
    embedded: true,
  })));

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment status needs attention');
  assert.ok(container.querySelector('[data-testid="button-payment-return-recheck"]'));
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));

  await act(async () => root.unmount());
  container.remove();
});

test('unknown-provider pending copy stays payment-neutral', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'pending',
    provider: null,
    embedded: true,
  })));

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Checking payment status');
  assert.doesNotMatch(container.textContent, /Direct Debit|card set-up/);
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));

  await act(async () => root.unmount());
  container.remove();
});

test('paid member return provides a non-payment onward destination', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'paid',
    continueHref: '/Dashboard',
    continueLabel: 'Go to member area',
  })));

  const onward = container.querySelector('[data-testid="button-payment-return-continue"]');
  assert.equal(onward?.getAttribute('href'), '/Dashboard');
  assert.match(onward?.textContent || '', /member area/i);
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('same-origin embedded continuation uses the explicit parent callback', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let continued = 0;
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'paid',
    embedded: true,
    continueHref: '/microsite',
    onContinue: () => { continued += 1; },
  })));

  const onward = container.querySelector('[data-testid="button-payment-return-continue"]');
  assert.equal(onward?.tagName, 'BUTTON');
  await act(async () => onward.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(continued, 1);

  await act(async () => root.unmount());
  container.remove();
});

test('unmount clears a scheduled bounded poll', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-pending',
    provider: 'gocardless',
    pathname: '/forms/example',
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      provider: 'gocardless',
      status: 'pending',
      pending: true,
      retryable: true,
    }),
  });

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pollTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 1500 || delay === 3000 || delay === 5000) {
      const id = { callback, delay };
      pollTimers.add(id);
      return id;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (id) => {
    if (pollTimers.delete(id)) return;
    originalClearTimeout(id);
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(HookProbe));
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
    });
    assert.equal(pollTimers.size, 1);
    await act(async () => root.unmount());
    assert.equal(pollTimers.size, 0, 'poll timer must not survive unmount');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    container.remove();
  }
});
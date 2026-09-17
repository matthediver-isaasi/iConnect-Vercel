/**
 * Payment discovery cache contract (Task #4334).
 *
 * Keep this deliberately at the component boundary: a payment field is often
 * rebuilt from normalized form state on every render, while provider
 * discovery is scoped only to its payment purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  sessionStorage: window.sessionStorage,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  DOMParser: window.DOMParser,
  MutationObserver: window.MutationObserver,
  DocumentFragment: window.DocumentFragment,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const FormPaymentSubmit = (await import('./FormPaymentSubmit.jsx')).default;
const { useMembershipFeeQuote } = await import('../../lib/useMembershipFeeQuote.js');
const { SS_KEY, paymentContextKey } = await import('../../lib/formPaymentReturn.js');
const { useFormPaymentReturn, FormPaymentReturnScreen } = await import('./FormPaymentReturn.jsx');

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}; DOM: ${document.body.textContent}`)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const field = () => ({
  id: 'payment-1',
  payment_providers: ['stripe'],
  price_field_id: 'price',
  payment_currency: 'GBP',
});

const directDebitField = () => ({
  ...field(),
  payment_providers: ['gocardless'],
});

const membershipForm = {
  id: 'membership-form',
  fields: [],
  visibility_rules: [{
    id: 'membership-rule',
    trigger_field_id: 'class',
    operator: 'equals',
    value: 'member',
    actions: [{
      action_type: 'membership_structure',
      config_id: 'membership-config',
      field_mappings: { 'core:member_count': 'count' },
    }],
  }],
};

test('provider discovery is once per purpose across equivalent rerenders and switching back', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ providers: [{ id: 'stripe', configured: true }] }) };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (membership = false) => root.render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(FormPaymentSubmit, {
        field: field(),
        formValues: { price: '10' },
        buildPayload: async () => null,
        membershipQuote: membership
          ? { matched: true, quote: { required: true, amount: 10, currency: 'GBP' } }
          : { matched: false },
      }),
    ),
  );

  await act(async () => { render(false); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render(true); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render(false); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.equal(calls.filter((url) => url.includes('purpose=forms')).length, 1);
  assert.equal(calls.filter((url) => url.includes('purpose=membership')).length, 1);
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

function QuoteProbe({ form, values }) {
  const quote = useMembershipFeeQuote({ form, formValues: values });
  return React.createElement('output', { 'data-loading': String(quote.loading) });
}

test('membership quote discovery is once per scalar key and refetches once on key change', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'quote') calls.push(body.submission_data.count);
    return { ok: true, json: async () => ({ required: true, amount: 20, currency: 'GBP' }) };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (count) => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(QuoteProbe, {
        form: { ...membershipForm, fields: [] },
        values: { class: 'member', count },
      })),
  );

  await act(async () => { render('10'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render('10'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render('25'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.deepEqual(calls, ['10', '25']);
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

test('inline Stripe completion stores the verified paid receipt for refresh', async () => {
  window.sessionStorage.clear();
  const calls = [];
  const paid = [];
  const originalStripe = window.Stripe;
  const originalFetch = globalThis.fetch;
  let resolveCreate;
  const createDone = new Promise((resolve) => { resolveCreate = resolve; });
  let resolvePaid;
  const paidDone = new Promise((resolve) => { resolvePaid = resolve; });
  window.Stripe = () => ({
    elements: () => ({
      create: () => ({ mount() {} }),
      submit: async () => ({}),
    }),
    confirmPayment: async () => ({
      paymentIntent: { id: 'pi-inline-test', status: 'succeeded' },
    }),
  });
  // Keep the test entirely local while still exercising the component's
  // create -> Stripe inline confirm -> shared confirm path.
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.action);
    if (body?.action === 'create') {
      resolveCreate();
      return {
        ok: true,
        json: async () => ({
          submissionId: 'inline-submission',
          publishableKey: 'pk_test_inline',
          clientSecret: 'cs_test_inline',
        }),
      };
    }
    if (body?.action === 'confirm') {
      return {
        ok: true,
        json: async () => ({ status: 'paid', provider: 'stripe' }),
      };
    }
    throw new Error(`unexpected payment request: ${body?.action}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  client.setQueryData(
    ['form-payment-providers', 'forms'],
    [{ id: 'stripe', configured: true }],
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(FormPaymentSubmit, {
          field: field(),
          formValues: { price: '10' },
          buildPayload: async () => ({
            form_id: 'inline-form',
            submission_data: { price: '10' },
          }),
          onPaid: (submissionId) => {
            paid.push(submissionId);
            resolvePaid();
          },
        })),
    ));
    const providerButton = container.querySelector('[data-testid="button-form-payment-stripe-payment-1"]');
    assert.ok(providerButton, 'provider discovery should expose the cached Stripe option');
    await act(async () => {
      providerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(createDone, 'create request');
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton, 'inline Stripe controls should mount after create');
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(paidDone, 'paid callback');
    });

    assert.deepEqual(calls, ['create', 'confirm']);
    assert.deepEqual(paid, ['inline-submission']);
    const receipt = JSON.parse(window.sessionStorage.getItem('form_payment_pending_submission'));
    assert.equal(receipt.submissionId, 'inline-submission');
    assert.equal(receipt.status, 'paid');
    assert.equal(receipt.terminalStatus, 'paid');
    assert.doesNotMatch(JSON.stringify(receipt), /clientSecret|paymentIntent|price/);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    window.Stripe = originalStripe;
    globalThis.fetch = originalFetch;
  }
});

for (const monthly of [false, true]) {
test(`real Drop-in success callback confirms ${monthly ? 'verified monthly' : 'legacy'} setup_complete`, async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/inline-dd');
  const originalDropin = window.GoCardlessDropin;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let resolveComplete;
  const complete = new Promise((resolve) => { resolveComplete = resolve; });
  window.GoCardlessDropin = {
    create: (options) => ({
      open: () => options.onSuccess({ id: 'billing-request' }, { id: 'flow' }),
      exit: () => {},
    }),
  };
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.action);
    if (body?.action === 'create') {
      return {
        ok: true,
        json: async () => ({
          submissionId: 'inline-dd-submission',
          flowId: 'flow',
          environment: 'sandbox',
          authorisationUrl: 'https://pay.example/flow',
        }),
      };
    }
    if (body?.action === 'confirm') {
      return {
        ok: true,
        json: async () => ({
          provider: 'gocardless',
          ...(monthly ? { paymentProvider: 'gocardless_monthly_dd', setupVerified: true } : {}),
          status: 'setup_complete',
          paymentSucceeded: false,
        }),
      };
    }
    throw new Error(`unexpected payment request: ${body?.action}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  client.setQueryData(
    ['form-payment-providers', 'membership'],
    [{ id: 'gocardless', configured: true }],
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(FormPaymentSubmit, {
          field: directDebitField(),
          formValues: { price: '10' },
          buildPayload: async () => ({
            form_id: 'inline-dd-form',
            submission_data: { price: '10' },
          }),
          membershipQuote: {
            matched: true,
            quote: {
              required: true,
              amount: 10,
              currency: 'GBP',
              membership: { direct_debit_allowed: true },
            },
          },
          onSetupComplete: (submissionId) => resolveComplete(submissionId),
        })),
    ));
    const providerButton = container.querySelector('[data-testid="button-form-payment-gocardless-payment-1"]');
    assert.ok(providerButton);
    await act(async () => {
      providerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.deepEqual(await bounded(complete, 'Drop-in setup callback'), monthly ? {
      submissionId: 'inline-dd-submission',
      provider: 'gocardless',
      paymentProvider: 'gocardless_monthly_dd',
      setupVerified: true,
      paymentCollected: false,
    } : 'inline-dd-submission');
    assert.deepEqual(calls, ['create', 'confirm']);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
    if (originalDropin === undefined) delete window.GoCardlessDropin;
    else window.GoCardlessDropin = originalDropin;
  }
});
}

test('inline confirm unmount plus SPA navigation cannot write a receipt to the new scope', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/inline-source?instance=source');
  const originalStripe = window.Stripe;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let resolveCreate;
  const createDone = new Promise((resolve) => { resolveCreate = resolve; });
  let resolveConfirmRequested;
  const confirmRequested = new Promise((resolve) => { resolveConfirmRequested = resolve; });
  let resolveConfirmResponse;
  const confirmResponse = new Promise((resolve) => { resolveConfirmResponse = resolve; });
  window.Stripe = () => ({
    elements: () => ({
      create: () => ({ mount() {} }),
      submit: async () => ({}),
    }),
    confirmPayment: async () => ({
      paymentIntent: { id: 'pi-stale-inline', status: 'succeeded' },
    }),
  });
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.action);
    if (body?.action === 'create') {
      resolveCreate();
      return {
        ok: true,
        json: async () => ({
          submissionId: 'stale-inline-submission',
          publishableKey: 'pk_test_stale',
          clientSecret: 'cs_test_stale',
        }),
      };
    }
    if (body?.action === 'confirm') {
      resolveConfirmRequested();
      return confirmResponse;
    }
    throw new Error(`unexpected payment request: ${body?.action}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  client.setQueryData(['form-payment-providers', 'forms'], [{ id: 'stripe', configured: true }]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(FormPaymentSubmit, {
          field: field(),
          formValues: { price: '10' },
          buildPayload: async () => ({ form_id: 'stale-form', submission_data: { price: '10' } }),
        })),
    ));
    const providerButton = container.querySelector('[data-testid="button-form-payment-stripe-payment-1"]');
    assert.ok(providerButton);
    await act(async () => {
      providerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(createDone, 'create request');
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton);
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(confirmRequested, 'confirm request');
    });

    window.history.pushState({}, '', '/forms/inline-destination?instance=destination');
    await act(async () => root.unmount());
    resolveConfirmResponse({
      ok: true,
      json: async () => ({ status: 'paid', provider: 'stripe' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sourceReceipt = JSON.parse(
      window.sessionStorage.getItem(paymentContextKey('/forms/inline-source', '?instance=source')),
    );
    assert.notEqual(sourceReceipt.status, 'paid', 'the stale completion must not update the old scope');
    assert.equal(
      window.sessionStorage.getItem(paymentContextKey('/forms/inline-destination', '?instance=destination')),
      null,
      'SPA navigation must not create a receipt in the destination scope',
    );
    assert.doesNotMatch(window.sessionStorage.getItem(SS_KEY) || '', /"terminalStatus":"paid"/);
    assert.deepEqual(calls, ['create', 'confirm']);
  } finally {
    client.clear();
    container.remove();
    window.Stripe = originalStripe;
    globalThis.fetch = originalFetch;
  }
});

test('repeated inline completion clicks serialize the shared confirm request', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/inline-serialize');
  const originalStripe = window.Stripe;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let resolveCreate;
  const createDone = new Promise((resolve) => { resolveCreate = resolve; });
  let resolveConfirmRequested;
  const confirmRequested = new Promise((resolve) => { resolveConfirmRequested = resolve; });
  let resolveConfirmResponse;
  const confirmResponse = new Promise((resolve) => { resolveConfirmResponse = resolve; });
  let resolvePaid;
  const paidDone = new Promise((resolve) => { resolvePaid = resolve; });
  const paid = [];
  window.Stripe = () => ({
    elements: () => ({
      create: () => ({ mount() {} }),
      submit: async () => ({}),
    }),
    confirmPayment: async () => ({
      paymentIntent: { id: 'pi-serialized-inline', status: 'succeeded' },
    }),
  });
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.action);
    if (body?.action === 'create') {
      resolveCreate();
      return {
        ok: true,
        json: async () => ({
          submissionId: 'serialized-inline-submission',
          publishableKey: 'pk_test_serialized',
          clientSecret: 'cs_test_serialized',
        }),
      };
    }
    if (body?.action === 'confirm') {
      resolveConfirmRequested();
      return confirmResponse;
    }
    throw new Error(`unexpected payment request: ${body?.action}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  client.setQueryData(['form-payment-providers', 'forms'], [{ id: 'stripe', configured: true }]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(FormPaymentSubmit, {
          field: field(),
          formValues: { price: '10' },
          buildPayload: async () => ({ form_id: 'serialize-form', submission_data: { price: '10' } }),
          onPaid: (submissionId) => {
            paid.push(submissionId);
            resolvePaid();
          },
        })),
    ));
    const providerButton = container.querySelector('[data-testid="button-form-payment-stripe-payment-1"]');
    assert.ok(providerButton);
    await act(async () => {
      providerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(createDone, 'create request');
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton);
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(confirmRequested, 'confirm request');
    });
    // The first server confirm is deliberately still pending. A second click
    // must not issue another shared confirm request.
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(calls.filter((action) => action === 'confirm').length, 1);

    resolveConfirmResponse({
      ok: true,
      json: async () => ({ status: 'paid', provider: 'stripe' }),
    });
    await act(async () => { await bounded(paidDone, 'serialized paid callback'); });
    assert.deepEqual(paid, ['serialized-inline-submission']);
    assert.equal(calls.filter((action) => action === 'confirm').length, 1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    window.Stripe = originalStripe;
    globalThis.fetch = originalFetch;
  }
});

test('alreadyPaid inline create writes the paid receipt before the completion callback', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/already-paid');
  const originalStripe = window.Stripe;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let resolveAlreadyPaid;
  const alreadyPaidDone = new Promise((resolve) => { resolveAlreadyPaid = resolve; });
  const paid = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(body?.action);
    if (body?.action === 'create') {
      return {
        ok: true,
        json: async () => ({
          alreadyPaid: true,
          submissionId: 'already-paid-inline-submission',
          provider: 'stripe',
        }),
      };
    }
    throw new Error(`unexpected payment request: ${body?.action}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  client.setQueryData(['form-payment-providers', 'forms'], [{ id: 'stripe', configured: true }]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(FormPaymentSubmit, {
          field: field(),
          formValues: { price: '10' },
          buildPayload: async () => ({ form_id: 'already-paid-form', submission_data: { price: '10' } }),
          onPaid: (submissionId) => {
            paid.push(submissionId);
            resolveAlreadyPaid();
          },
        })),
    ));
    const providerButton = container.querySelector('[data-testid="button-form-payment-stripe-payment-1"]');
    assert.ok(providerButton);
    await act(async () => {
      providerButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await bounded(alreadyPaidDone, 'already paid callback');
    });

    assert.deepEqual(calls, ['create']);
    assert.deepEqual(paid, ['already-paid-inline-submission']);
    const receipt = JSON.parse(window.sessionStorage.getItem(SS_KEY));
    assert.equal(receipt.submissionId, 'already-paid-inline-submission');
    assert.equal(receipt.status, 'paid');
    assert.equal(receipt.terminalStatus, 'paid');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    window.Stripe = originalStripe;
    globalThis.fetch = originalFetch;
  }
});

const reportedFinalizing = {
  success: false, paymentSucceeded: true, provider: 'stripe', status: 'finalizing',
  pending: true, retryable: true, reconciled: false,
};

for (const scenario of [
  { name: 'reported annual finalizing', response: reportedFinalizing, accepted: 'payment' },
  { name: 'verified annual paid', response: { ...reportedFinalizing, status: 'paid' }, accepted: 'payment' },
  { name: 'annual receipt write failure', response: reportedFinalizing, accepted: 'payment', storage: 'write' },
  { name: 'annual receipt read failure', response: reportedFinalizing, accepted: 'payment', storage: 'read' },
  { name: 'annual unavailable storage', response: reportedFinalizing, accepted: 'payment', storage: 'missing' },
  ...[false, true].map(collected => ({
    name: `verified monthly card collected=${collected}`,
    response: { provider: 'stripe', paymentProvider: 'stripe_monthly_card', setupVerified: true,
      status: 'setup_complete', paymentSucceeded: collected }, accepted: 'setup',
  })),
  { name: 'monthly receipt write failure', response: { provider: 'stripe', paymentProvider: 'stripe_monthly_card',
    setupVerified: true, status: 'setup_complete', paymentSucceeded: false }, accepted: 'setup', storage: 'write' },
  { name: 'missing provider identity', response: { status: 'finalizing', paymentSucceeded: true } },
  { name: 'missing payment verification', response: { provider: 'stripe', status: 'finalizing' } },
  { name: 'monthly without setup proof even when paid', response: { provider: 'stripe',
    paymentProvider: 'stripe_monthly_card', status: 'paid', paymentSucceeded: true } },
  { name: 'monthly mismatched identity', response: { provider: 'stripe',
    paymentProvider: 'gocardless_monthly_dd', setupVerified: true, status: 'paid', paymentSucceeded: true } },
]) {
  test(`real inline confirmation: ${scenario.name}`, { timeout: 5000 }, async () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/forms/inline-regression');
    const originalFetch = globalThis.fetch;
    const originalStripe = window.Stripe;
    const originalStorage = globalThis.sessionStorage;
    const callbacks = [];
    const calls = [];
    const errors = [];
    const onError = event => errors.push(event.error || event.reason || event.message);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    window.Stripe = () => ({
      elements: () => ({ create: () => ({ mount() {} }), submit: async () => ({}) }),
      confirmPayment: async () => {
        calls.push('stripe-confirm');
        return { paymentIntent: { id: 'pi_mock_only', status: 'succeeded' } };
      },
    });
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.action);
      if (body.action === 'create') return { ok: true, json: async () => ({
        submissionId: 'inline-mock-only', publishableKey: 'pk_test_mock', clientSecret: 'cs_mock',
      }) };
      assert.equal(body.action, 'confirm');
      assert.equal(body.acknowledge_setup, true);
      assert.equal(body.submission_id, 'inline-mock-only');
      return { ok: true, json: async () => scenario.response };
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(['form-payment-providers', 'forms'], [{ id: 'stripe', configured: true }]);
    function InlinePage() {
      const result = useFormPaymentReturn();
      return result.active
        ? React.createElement(FormPaymentReturnScreen, { ...result, continueHref: '/membership' })
        : React.createElement(FormPaymentSubmit, {
          field: field(), formValues: { price: '10' }, continueHref: '/membership',
          buildPayload: async () => ({ form_id: 'inline-mock-form', submission_data: { price: '10' } }),
          onPaid: value => callbacks.push(['paid', value]),
          onPaymentAccepted: value => {
            callbacks.push(['payment', value]);
            result.adoptPaymentAcceptance(value);
          },
          onSetupComplete: value => {
            callbacks.push(['setup', value]);
            result.adoptCompletion(value);
          },
        });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    const render = () => root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(InlinePage)),
    );
    const click = async testId => {
      const button = container.querySelector(`[data-testid="${testId}"]`);
      assert.ok(button, `Missing ${testId}: ${container.textContent}`);
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 10));
      });
    };
    try {
      await act(async () => render());
      await click('button-form-payment-stripe-payment-1');
      // Fail persistence only after checkout has started, exercising both the
      // inline receipt and the page-level adoption with the same storage fault.
      if (scenario.storage === 'missing') globalThis.sessionStorage = null;
      if (scenario.storage === 'read' || scenario.storage === 'write') {
        globalThis.sessionStorage = {
          getItem: key => {
            if (scenario.storage === 'read') throw new Error('Storage read denied');
            return originalStorage.getItem(key);
          },
          setItem: () => { throw new Error('Storage write denied'); },
        };
      }
      await click('button-form-payment-confirm-payment-1');
      assert.doesNotMatch(container.textContent, /setupAccepted is not defined|ReferenceError/);
      assert.deepEqual(errors, []);
      assert.deepEqual(calls, ['create', 'stripe-confirm', 'confirm']);
      if (scenario.accepted) {
        assert.deepEqual(callbacks.map(([kind]) => kind), [scenario.accepted]);
        const title = scenario.accepted === 'payment'
          ? 'Payment received — application submitted'
          : 'Application submitted — monthly payments set up';
        assert.equal(container.querySelector('[data-testid="payment-return-title"]')?.textContent, title);
        assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));
        assert.equal(container.querySelector('[data-testid="form-payment-submit-payment-1"]'), null);
        if (scenario.accepted === 'setup') {
          assert.equal(callbacks[0][1].setupVerified, true);
          assert.equal(callbacks[0][1].paymentCollected, scenario.response.paymentSucceeded);
          assert.match(container.textContent, scenario.response.paymentSucceeded
            ? /first payment has been received/i : /monthly payments are set up/i);
          if (!scenario.response.paymentSucceeded) {
            assert.doesNotMatch(container.textContent, /payment (?:has been )?received/i);
          }
        }
        if (!scenario.storage) {
          const receipt = JSON.parse(originalStorage.getItem(SS_KEY));
          assert.doesNotMatch(JSON.stringify(receipt), /clientSecret|paymentIntent|price/);
          assert.equal(scenario.accepted === 'payment' ? receipt.presentationAccepted : receipt.setupVerified, true);
          await act(async () => root.unmount());
          root = createRoot(container);
          await act(async () => render());
          assert.equal(container.querySelector('[data-testid="payment-return-title"]')?.textContent, title);
          assert.equal(container.querySelector('[data-testid="form-payment-submit-payment-1"]'), null);
          assert.deepEqual(calls, ['create', 'stripe-confirm', 'confirm']);
          assert.equal(callbacks.length, 1);
        }
      } else {
        assert.deepEqual(callbacks, [], 'Unverified results cannot invoke completion callbacks');
        const receipt = JSON.parse(originalStorage.getItem(SS_KEY));
        assert.notEqual(receipt.presentationAccepted, true);
        assert.notEqual(receipt.setupVerified, true);
        assert.notEqual(receipt.terminalStatus, 'paid');
        assert.equal(container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]'), null);
      }
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.sessionStorage = originalStorage;
      globalThis.fetch = originalFetch;
      window.Stripe = originalStripe;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
      // Let the component's existing delayed element mount finish before the
      // next test reuses the same element IDs.
      await new Promise(resolve => setTimeout(resolve, 110));
    }
  });
}
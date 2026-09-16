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
      await createDone;
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton, 'inline Stripe controls should mount after create');
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await paidDone;
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

test('real Drop-in success callback confirms setup_complete and adopts application completion', async () => {
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
    assert.equal(await Promise.race([
      complete,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]), 'inline-dd-submission');
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
      await createDone;
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton);
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await confirmRequested;
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
      await createDone;
    });
    const confirmButton = container.querySelector('[data-testid="button-form-payment-confirm-payment-1"]');
    assert.ok(confirmButton);
    await act(async () => {
      confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await confirmRequested;
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
    await act(async () => { await paidDone; });
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
      await alreadyPaidDone;
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
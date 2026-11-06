import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/bundle' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useMembershipFeeQuote } = await import('./useMembershipFeeQuote.js');
const { useFormBundleUnavailable } = await import('./useFormBundleUnavailable.js');
const { resolveEffectivePayment } = await import('./formPaymentQuote.js');
const { default: FormPaymentSubmit, derivePaymentAmountClient } = await import('../components/forms/FormPaymentSubmit.jsx');
const { useSubmissionIdempotencyKey } = await import('./useSubmissionIdempotencyKey.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const first = '12345678-1234-4234-8234-123456789012';
const second = '87654321-1234-4234-8234-123456789012';
const form = { id: 'bundle-form', fields: [
  { id: 'bundle', type: 'sales_bundle', allowed_bundle_ids: [first, second] },
  { id: 'pay', type: 'payment', price_field_id: 'bundle' },
] };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };

test('bundle selections trigger a server quote; changing UUID cannot display the previous quote or a numeric fallback', async () => {
  const calls = [];
  let pending;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (calls.length === 1) return { ok: true, json: async () => ({ required: true, amount: 87.5, currency: 'GBP' }) };
    return new Promise(resolve => { pending = resolve; });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let result;
  function Fixture({ value }) {
    result = useMembershipFeeQuote({ form, formValues: { bundle: value }, credentialDiscriminator: 'private-scope' });
    return null;
  }
  const render = value => act(async () => root.render(<QueryClientProvider client={client}><Fixture value={value} /></QueryClientProvider>));
  try {
    await render(first);
    await settle();
    assert.equal(result.source, 'bundle');
    assert.equal(result.quote.amount, 87.5);
    assert.equal(calls[0].url, '/api/public/form-payment');
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].body.action, 'quote');
    assert.equal(calls[0].body.submission_data.bundle, first);
    await render(second);
    assert.equal(result.loading, true);
    assert.equal(result.quote, null);
    assert.equal(derivePaymentAmountClient(form.fields[1], { bundle: second }), 0);
    assert.equal(resolveEffectivePayment({ membershipMatched: result.matched, quoteLoading: result.loading, derivedAmount: 999 }).blocked, true);
    await act(async () => pending({ ok: false, status: 503, json: async () => ({ error: 'Cannot calculate bundle price' }) }));
    await settle();
    assert.equal(result.quote, null);
    assert.match(result.error, /Cannot calculate/);
    assert.equal(resolveEffectivePayment({ membershipMatched: result.matched, quoteError: result.error, derivedAmount: 999 }).amount, null);
    await render(first);
    assert.equal(calls.length, 3, 'returning to the first bundle requests a fresh quote');
    assert.equal(result.loading, true);
    assert.equal(result.quote, null, 'cached first-bundle price is not displayed during re-quote');
    await act(async () => pending({ ok: true, json: async () => ({ required: true, amount: 91.25, currency: 'GBP' }) }));
    await settle();
    assert.equal(result.quote.amount, 91.25);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove();
  }
});

test('paginated form handles a stock conflict even while the bundle renderer is unmounted', async () => {
  const client = new QueryClient();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let answers;
  let message;
  function Fixture() {
    const [values, setValues] = React.useState({ bundle: first, email: 'delegate@example.org', consent: true });
    answers = values;
    useFormBundleUnavailable(form, setValues, value => { message = value; });
    return null;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>));
    await act(async () => window.dispatchEvent(new CustomEvent('form-bundle-unavailable', { detail: { formId: form.id } })));
    assert.deepEqual(answers, { bundle: '', email: 'delegate@example.org', consent: true });
    assert.match(message, /Please choose again/);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove();
  }
});

for (const code of ['BUNDLE_ATTEMPT_ENDED', 'BUNDLE_ATTEMPT_UNRESOLVED']) {
  test(`payment handles ${code} without blindly retrying the same attempt`, async () => {
    const creates = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('form-payment-providers')) return { ok: true, json: async () => ({ providers: [{ id: 'stripe', configured: true }] }) };
      creates.push(JSON.parse(options.body));
      return { ok: false, status: 409, json: async () => ({ code, error: 'Attempt cannot continue' }) };
    };
    const client = new QueryClient();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Fixture() {
      const { getIdempotencyKey, rotateIdempotencyKey } = useSubmissionIdempotencyKey();
      return <FormPaymentSubmit field={{ ...form.fields[1], payment_providers: ['stripe'] }} formValues={{ bundle: first }}
        idempotencyKey={getIdempotencyKey()} onNewAttempt={rotateIdempotencyKey}
        buildPayload={async () => ({ form_id: form.id, submission_data: { bundle: first } })}
        membershipQuote={{ matched: true, source: 'bundle', quote: { required: true, amount: 87.5, currency: 'GBP' } }} />;
    }
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>));
      await settle();
      const pay = () => container.querySelector('[data-testid="button-form-payment-stripe-pay"]');
      await act(async () => pay().click());
      assert.equal(creates.length, 1);
      assert.equal(pay(), null);
      if (code === 'BUNDLE_ATTEMPT_ENDED') {
        const restart = [...container.querySelectorAll('button')].find(button => button.textContent === 'Start a new payment attempt');
        assert.ok(restart);
        await act(async () => restart.click());
        await act(async () => pay().click());
        assert.equal(creates.length, 2);
        assert.notEqual(creates[0].idempotency_key, creates[1].idempotency_key);
      } else {
        assert.match(container.textContent, /Administrator review required/);
        assert.match(container.textContent, /Do not pay again/);
        assert.equal(container.querySelectorAll('button').length, 0);
      }
    } finally {
      await act(async () => root.unmount()); client.clear(); container.remove();
    }
  });
}

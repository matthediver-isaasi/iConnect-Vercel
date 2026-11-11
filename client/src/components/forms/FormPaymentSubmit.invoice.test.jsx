import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/invoice' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const FormPaymentSubmit = (await import('./FormPaymentSubmit.jsx')).default;
const { default: InvoicePaymentSetting, invoiceBillingConfigurationError } = await import('./InvoicePaymentSetting.jsx');

const invoiceResult = { submissionId: 'submission-invoice', invoiceOrderConfirmed: true, paymentStatus: 'unpaid' };
const payload = { form_id: 'invoice-form', submission_data: { name: 'Mira Shah' } };
async function mount(overrides = {}, response = invoiceResult, configured = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  for (const purpose of ['forms', 'membership']) {
    client.setQueryData(['form-payment-providers', purpose], [{ id: 'invoice', configured }]);
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const calls = [], confirmed = [], paid = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => response };
  };
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <FormPaymentSubmit
        field={{ id: 'invoice', type: 'payment', price_field_id: 'price', payment_providers: ['invoice'] }}
        formValues={{ price: 87.50 }}
        buildPayload={async () => payload}
        idempotencyKey="stable-invoice-attempt"
        onInvoiceConfirmed={outcome => confirmed.push(outcome)}
        onPaid={id => paid.push(id)}
        {...overrides}
      />
    </QueryClientProvider>,
  ));
  return {
    container, calls, confirmed, paid,
    button: () => container.querySelector('[data-testid="button-form-payment-invoice-invoice"]'),
    async cleanup() {
      await act(async () => root.unmount());
      client.clear(); container.remove(); globalThis.fetch = originalFetch;
    },
  };
}

test('invoice setting is off by default, capability gated and uses explicit helper copy', () => {
  const html = renderToStaticMarkup(<InvoicePaymentSetting field={{ id: 'p', type: 'payment' }} provider={{ configured: true }} />);
  assert.match(html, /data-state="unchecked"/);
  assert.match(html, /Pay by invoice/);
  assert.match(html, /Confirms the order immediately. Payment remains outstanding until the invoice is paid./);
  assert.doesNotMatch(html, /Billing name field/);
  const unavailable = renderToStaticMarkup(<InvoicePaymentSetting field={{ id: 'p', type: 'payment' }} provider={{ configured: false }} />);
  assert.match(unavailable, /disabled/);
  assert.equal(renderToStaticMarkup(<InvoicePaymentSetting field={{ type: 'membership_payment' }} provider={{ configured: true }} />), '');
});

test('invoice recipient mappings are required, type checked and irrelevant when invoice is off', () => {
  const fields = [{ id: 'name', type: 'text' }, { id: 'email', type: 'email' }];
  const field = { payment_providers: ['invoice'] };
  assert.match(invoiceBillingConfigurationError(field, fields), /Billing name field/);
  field.invoice_billing_name_field_id = 'name';
  assert.match(invoiceBillingConfigurationError(field, fields), /Billing email field/);
  field.invoice_billing_email_field_id = 'name';
  assert.match(invoiceBillingConfigurationError(field, fields), /Billing email field/);
  field.invoice_billing_email_field_id = 'email';
  assert.equal(invoiceBillingConfigurationError(field, fields), null);
  assert.match(invoiceBillingConfigurationError(field, fields.slice(1)), /Billing name field/);
  assert.equal(invoiceBillingConfigurationError({}, fields), null);
});

test('billing selectors offer only matching field types and persist explicit mapping keys', () => {
  const calls = [];
  const tree = InvoicePaymentSetting({
    field: { id: 'p', type: 'payment', payment_providers: ['invoice'], invoice_billing_name_field_id: 'name' },
    provider: { configured: true },
    allFields: [{ id: 'name', type: 'text' }, { id: 'email', type: 'email' }, { id: 'notes', type: 'textarea' }],
    onChange: update => calls.push(update),
  });
  const selects = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.props?.onValueChange) selects.push(node);
    [node.props?.children].flat(Infinity).forEach(walk);
  }
  walk(tree);
  assert.equal(selects.length, 3);
  assert.equal(selects[0].props.value, 'name');
  function choices(select) {
    return select.props.children[1].props.children.flat(Infinity).filter(Boolean).map(item => item.props.value);
  }
  assert.deepEqual(choices(selects[0]), ['name']);
  assert.deepEqual(choices(selects[1]), ['email']);
  selects[0].props.onValueChange('name');
  selects[1].props.onValueChange('email');
  selects[2].props.onValueChange('notes');
  selects[2].props.onValueChange('_none');
  assert.deepEqual(calls, [
    { invoice_billing_name_field_id: 'name' },
    { invoice_billing_email_field_id: 'email' },
    { invoice_address_field_id: 'notes' },
    { invoice_address_field_id: null },
  ]);
});

test('invoice card confirms unpaid order through its own callback without Stripe or Direct Debit', async () => {
  const fixture = await mount();
  try {
    assert.match(fixture.button().textContent, /Pay by invoice.*Confirms the order immediately.*Payment remains outstanding/s);
    assert.ok(fixture.button().querySelector('.lucide-file-text'));
    await act(async () => { fixture.button().click(); fixture.button().click(); });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].body.action, 'create');
    assert.equal(fixture.calls[0].body.provider, 'invoice');
    assert.equal(fixture.calls[0].body.idempotency_key, 'stable-invoice-attempt');
    assert.deepEqual(fixture.calls[0].body.submission_data, payload.submission_data);
    assert.equal(fixture.calls[0].credentials, 'include');
    assert.deepEqual(fixture.confirmed, [invoiceResult]);
    assert.deepEqual(fixture.paid, []);
    assert.match(fixture.container.textContent, /Order confirmed.*Payment remains outstanding/s);
    assert.equal(fixture.button(), null);
    assert.equal(document.querySelector('script[src*="stripe"]'), null);
    assert.equal(fixture.container.querySelector('[data-testid*="stripe-element"]'), null);
  } finally { await fixture.cleanup(); }
});

for (const overrides of [
  { field: { id: 'invoice', price_field_id: 'price' } },
  { membershipQuote: { matched: true, loading: true } },
  { membershipQuote: { matched: true, quote: { required: true, amount: 87.50, currency: 'GBP', membership: {} } } },
]) {
  test(`invoice unavailable when not opted in or membership quote applies: ${JSON.stringify(overrides)}`, async () => {
    const fixture = await mount(overrides);
    try { assert.equal(fixture.button(), null); assert.deepEqual(fixture.calls, []); }
    finally { await fixture.cleanup(); }
  });
}

test('unconfigured invoice is unavailable', async () => {
  const fixture = await mount({}, invoiceResult, false);
  try { assert.equal(fixture.button(), null); }
  finally { await fixture.cleanup(); }
});

test('invoice keeps validation abort and never creates a submission', async () => {
  const fixture = await mount({ buildPayload: async () => null });
  try {
    await act(async () => fixture.button().click());
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.confirmed, []);
  } finally { await fixture.cleanup(); }
});

test('malformed invoice response never falls through to paid or payment widgets', async () => {
  const fixture = await mount({}, { submissionId: 'bad', alreadyPaid: true });
  try {
    await act(async () => fixture.button().click());
    assert.match(fixture.container.textContent, /invoice order could not be confirmed/);
    assert.deepEqual(fixture.confirmed, []);
    assert.deepEqual(fixture.paid, []);
    assert.equal(document.querySelector('script[src*="stripe"]'), null);
  } finally { await fixture.cleanup(); }
});

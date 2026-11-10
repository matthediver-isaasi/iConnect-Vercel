import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/cart' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'location']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
localStorage.setItem('tenant_slug', 'cart-test');
const output = await build({
  stdin: { contents: 'export {default} from "./client/src/components/forms/CartField.jsx"; export {default as CartSettings} from "./client/src/components/forms/CartSettings.jsx"; export {testCatalogue} from "@/pages/sales/useCatalogue"; export {default as FormPaymentSubmit} from "./client/src/components/forms/FormPaymentSubmit.jsx"; export {useMembershipFeeQuote} from "./client/src/lib/useMembershipFeeQuote.js"; export {useFormBundleUnavailable} from "./client/src/lib/useFormBundleUnavailable.js";', resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'catalogue-fixture', setup(builder) {
    builder.onResolve({ filter: /^@\/pages\/sales\/useCatalogue$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const testCatalogue = {}; export const useCatalogue = section => testCatalogue[section];' }));
  } }],
});
const module = new Module(`${process.cwd()}/cart-field-test.cjs`);
module.filename = `${process.cwd()}/cart-field-test.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(output.outputFiles[0].text, module.filename);
const CartField = module.exports.default;
const { CartSettings, testCatalogue, FormPaymentSubmit, useMembershipFeeQuote, useFormBundleUnavailable } = module.exports;
const require = createRequire(import.meta.url);
const React = require('react');
globalThis.React = React;
const { act } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const id = '12345678-1234-4234-8234-123456789012';
const item = { kind: 'product', id, name: 'Annual handbook', description: 'Printed edition', unitPriceMinor: 1735, currency: 'GBP', taxTreatment: 'standard', taxRateBps: 2000, available: true, remaining: 7 };
const saved = { version: 1, lines: [{ kind: 'product', id, quantity: 2 }] };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
async function mount(initialValue = '', formId = 'form-one') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = createClient();
  const answers = [];
  const validity = [];
  function Fixture() {
    const [value, setValue] = React.useState(initialValue);
    return React.createElement(CartField, {
      field: { id: 'cart', type: 'sales_cart', required: true }, formId, value,
      onChange: next => { answers.push(next); setValue(next); },
      onValidityChange: (_id, valid) => validity.push(valid),
    });
  }
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
  return { container, answers, validity, close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test('items start at zero; removing an item emits identities and quantities only', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item] }) });
  const empty = await mount();
  try {
    await settle();
    assert.equal(empty.container.querySelector('input').value, '0');
    assert.equal(empty.answers.length, 0, 'no accidental preselection');
    assert.equal(empty.validity.at(-1), false);
    assert.match(empty.container.textContent, /17.35 each/);
    assert.match(empty.container.textContent, /Plus 20% tax/);
  } finally { await empty.close(); }
  const selected = await mount(saved);
  try {
    await settle();
    assert.equal(selected.container.querySelector('input').value, '2');
    assert.equal(selected.validity.at(-1), true);
    await act(async () => selected.container.querySelector('button').click());
    assert.deepEqual(selected.answers, [{ version: 1, lines: [] }]);
  } finally { await selected.close(); }
});

test('cart conflicts refresh options without clearing saved selections; checkout lock is form-scoped', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ items: [item] }) }; };
  const fixture = await mount(saved);
  try {
    await settle();
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-unavailable', { detail: { formId: 'other-form' } })));
    assert.equal(calls, 1);
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-unavailable', { detail: { formId: 'form-one' } })));
    await settle();
    assert.equal(calls, 2);
    assert.deepEqual(fixture.answers, []);
    assert.equal(fixture.container.querySelector('input').value, '2');
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'other-form' } })));
    assert.equal(fixture.container.querySelector('input').disabled, false);
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'form-one' } })));
    assert.equal(fixture.container.querySelector('input').disabled, true);
    assert.equal(fixture.container.querySelector('button').disabled, true);
  } finally { await fixture.close(); }
});

test('missing and unreadable selections are retained, with explicit removal', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
  const fixture = await mount(saved);
  try {
    await settle();
    assert.match(fixture.container.textContent, /Saved product unavailable/);
    assert.match(fixture.container.textContent, /quantity 2/);
    assert.deepEqual(fixture.answers, []);
    assert.equal(fixture.validity.at(-1), false);
  } finally { await fixture.close(); }
  const unreadable = await mount({ version: 6, lines: [] });
  try {
    await settle();
    assert.match(unreadable.container.textContent, /cannot be read/);
    assert.deepEqual(unreadable.answers, []);
    const clear = [...unreadable.container.querySelectorAll('button')].find(button => button.textContent === 'Clear unreadable cart');
    await act(async () => clear.click());
    assert.deepEqual(unreadable.answers, [{ version: 1, lines: [] }]);
  } finally { await unreadable.close(); }
});

test('missing runtime schema produces a retryable error, not an empty catalogue', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{"error":"Cart schema unavailable"}' });
  const fixture = await mount(saved);
  try {
    await settle();
    assert.match(fixture.container.textContent, /Cart options are unavailable/);
    assert.doesNotMatch(fixture.container.textContent, /No items are currently offered/);
    assert.deepEqual(fixture.answers, []);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item] }) });
    const retry = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Retry cart options');
    await act(async () => retry.click());
    await settle();
    assert.equal(fixture.container.querySelector('input').value, '2');
    assert.equal(fixture.validity.at(-1), true);
  } finally { await fixture.close(); }
});

test('cart quotes include all answers in their key and never fall back to stale amounts', async () => {
  const requests = [];
  let finish;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return { ok: true, json: async () => ({ required: true, amount: 41.64, currency: 'GBP', cart: { version: 1, lines: [] } }) };
    return new Promise(resolve => { finish = resolve; });
  };
  const client = createClient();
  const container = document.createElement('div');
  const root = createRoot(container);
  const form = { id: 'form-one', fields: [{ id: 'cart', type: 'sales_cart' }, { id: 'pay', type: 'payment', price_field_id: 'cart' }] };
  let result;
  function Fixture({ visible }) {
    result = useMembershipFeeQuote({ form, formValues: { cart: saved, show_shop: visible } });
    return null;
  }
  const render = visible => act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture, { visible }))));
  try {
    await render(true);
    await settle();
    assert.equal(result.source, 'cart');
    assert.equal(result.quote.amount, 41.64);
    assert.deepEqual(requests[0].submission_data, { cart: saved, show_shop: true });
    await render(false);
    assert.equal(requests.length, 2, 'a non-cart answer can change conditional visibility');
    assert.equal(result.quote, null);
    assert.equal(result.loading, true);
    await act(async () => finish({ ok: false, status: 503, json: async () => ({ error: 'Cart not ready' }) }));
    await settle();
    assert.equal(result.quote, null);
    assert.match(result.error, /Cart not ready/);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

test('page-level cart conflict retains every answer and lock survives a paginated field unmount', async () => {
  const client = createClient();
  const container = document.createElement('div');
  const root = createRoot(container);
  const form = { id: 'form-one', fields: [{ id: 'cart', type: 'sales_cart' }] };
  let values;
  let error;
  function Fixture() {
    const [answers, setAnswers] = React.useState({ cart: saved, email: 'registrar@example.org', consent: true });
    values = answers;
    useFormBundleUnavailable(form, setAnswers, message => { error = message; });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-unavailable', { detail: { formId: 'form-one' } })));
    assert.deepEqual(values, { cart: saved, email: 'registrar@example.org', consent: true });
    assert.match(error, /have been kept/);
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'form-one' } })));
    assert.equal(client.getQueryData(['form-cart-locked', 'form-one']), true);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

for (const conflict of [true, false]) {
  test(`cart checkout uses commerce discovery and buildPayload; ${conflict ? 'conflicts retain answers' : 'successful checkout locks only its form'}`, async () => {
    const requests = [];
    let validations = 0;
    let paid = null;
    let unavailable = null;
    let locked = null;
    const receiveUnavailable = event => { unavailable = event.detail; };
    const receiveLocked = event => { locked = event.detail; };
    window.addEventListener('form-cart-unavailable', receiveUnavailable);
    window.addEventListener('form-cart-locked', receiveLocked);
    const answers = { cart: saved, email: 'registrar@example.org' };
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      if (String(url).includes('form-payment-providers')) return { ok: true, json: async () => ({ providers: [{ id: 'stripe', name: 'Card', configured: true }] }) };
      return conflict
        ? { ok: false, status: 409, json: async () => ({ code: 'CART_UNAVAILABLE', field_id: 'cart', error: 'Not enough stock' }) }
        : { ok: true, json: async () => ({ alreadyPaid: true, submissionId: 'paid-submission' }) };
    };
    const client = createClient();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(FormPaymentSubmit, {
        field: { id: 'pay', type: 'payment', price_field_id: 'cart', payment_providers: ['stripe'] },
        formValues: answers,
        buildPayload: async () => { validations++; return { form_id: 'form-one', submission_data: answers }; },
        onPaid: id => { paid = id; },
        membershipQuote: { matched: true, source: 'cart', quote: { required: true, amount: 41.64, currency: 'GBP' } },
      }))));
      await settle();
      assert.equal(requests[0].url, '/api/public/form-payment-providers?purpose=forms');
      const button = container.querySelector('[data-testid="button-form-payment-stripe-pay"]');
      assert.ok(button);
      await act(async () => button.click());
      assert.equal(validations, 1);
      assert.deepEqual(requests[1].body.submission_data, answers);
      assert.equal(answers.cart.lines[0].quantity, 2);
      if (conflict) {
        assert.deepEqual(unavailable, { formId: 'form-one', fieldId: 'cart' });
        assert.equal(locked, null);
        assert.match(container.textContent, /cart and other answers have been kept/);
      } else {
        assert.deepEqual(locked, { formId: 'form-one' });
        assert.equal(paid, 'paid-submission');
      }
    } finally {
      await act(async () => root.unmount()); client.clear(); container.remove();
      window.removeEventListener('form-cart-unavailable', receiveUnavailable);
      window.removeEventListener('form-cart-locked', receiveLocked);
    }
  });
}

const setInput = async (input, value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

test('mixed product and bundle quantities use separate identities and stock violations block validity', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item, { ...item, kind: 'bundle', name: 'Reading pack', remaining: 4 }] }) });
  const fixture = await mount(saved);
  try {
    await settle();
    const inputs = fixture.container.querySelectorAll('input');
    await setInput(inputs[1], '3');
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [
      { kind: 'product', id, quantity: 2 }, { kind: 'bundle', id, quantity: 3 },
    ] });
    assert.equal(fixture.validity.at(-1), true);
    await setInput(inputs[0], '8');
    assert.equal(fixture.validity.at(-1), false);
    await setInput(inputs[0], '1');
    assert.equal(fixture.validity.at(-1), true);
    const beforeFraction = fixture.answers.length;
    await setInput(inputs[0], '1.5');
    assert.equal(fixture.answers.length, beforeFraction, 'fractional quantities never become answers');
    await setInput(inputs[1], '0');
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [{ kind: 'product', id, quantity: 1 }] });
  } finally { await fixture.close(); }
});

test('mounted settings preserve missing selections and require explicit bundle tax before save', async () => {
  const bundleId = '12345678-1234-4234-8234-123456789013';
  testCatalogue.products = { data: { cartStockReady: true, items: [{ id, name: 'Handbook' }, { id: 'event', name: 'Event ticket', eventReference: { eventId: 'event-one' } }] } };
  testCatalogue.bundles = { data: { cartStockReady: true, items: [{ id: bundleId, name: 'Reading pack', items: [{ productId: id }] }] } };
  let field;
  function Fixture() {
    const [value, setValue] = React.useState({ id: 'cart', type: 'sales_cart', cart_version: 1, allowed_product_ids: ['missing'], allowed_bundle_ids: [], bundle_tax: {} });
    field = value;
    return React.createElement(CartSettings, { field: value, onChange: patch => setValue(old => ({ ...old, ...patch })) });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    assert.match(container.textContent, /Unavailable saved product \(missing\)/);
    const eventChoice = [...container.querySelectorAll('[role="checkbox"]')].find(choice => choice.closest('label')?.textContent.includes('Event ticket'));
    assert.equal(eventChoice.disabled, true);
    const bundleChoice = [...container.querySelectorAll('[role="checkbox"]')].find(choice => choice.closest('label')?.textContent.includes('Reading pack'));
    await act(async () => bundleChoice.click());
    assert.deepEqual(field.allowed_bundle_ids, [bundleId]);
    assert.deepEqual(field.allowed_product_ids, ['missing']);
    assert.equal(field.bundle_tax[bundleId], undefined);
    const treatment = container.querySelector('select');
    await act(async () => { treatment.value = 'standard'; treatment.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(field.bundle_tax[bundleId].rateBps, null);
    const rate = container.querySelector('input[type="number"]');
    await setInput(rate, '17.5');
    assert.equal(field.bundle_tax[bundleId].rateBps, 1750);
    testCatalogue.products.data.cartStockReady = false;
    await act(async () => root.render(React.createElement(Fixture)));
    assert.match(container.textContent, /Cart stock is not ready for products/);
    assert.match(container.textContent, /Cart stock is not ready for bundles/);
    const choices = [...container.querySelectorAll('[role="checkbox"]')];
    assert.equal(choices.find(choice => choice.closest('label')?.textContent === 'Handbook').disabled, true);
    const selectedBundle = choices.find(choice => choice.closest('label')?.textContent.includes('Reading pack'));
    assert.equal(selectedBundle.disabled, false, 'saved choices remain removable');
    await act(async () => selectedBundle.click());
    assert.deepEqual(field.allowed_bundle_ids, []);
    assert.equal(selectedBundle.disabled, true, 'new additions are blocked while stock is not ready');
    assert.deepEqual(field.allowed_product_ids, ['missing']);
    testCatalogue.products.data.cartStockReady = true;
    testCatalogue.bundles.data.cartStockReady = false;
    await act(async () => root.render(React.createElement(Fixture)));
    assert.equal(container.querySelector('[role="checkbox"]').disabled, false, 'ready product catalogue remains selectable');
    assert.match(container.textContent, /Cart stock is not ready for bundles/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('validation abort cannot create a checkout or emit a cart lock', async () => {
  let requests = 0;
  let validations = 0;
  let locks = 0;
  const handleLock = () => { locks++; };
  window.addEventListener('form-cart-locked', handleLock);
  globalThis.fetch = async url => {
    requests++;
    assert.match(String(url), /form-payment-providers\?purpose=forms/);
    return { ok: true, json: async () => ({ providers: [{ id: 'stripe', configured: true }] }) };
  };
  const client = createClient();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(FormPaymentSubmit, {
      field: { id: 'pay', type: 'payment', price_field_id: 'cart', payment_providers: ['stripe'] }, formValues: { cart: saved },
      buildPayload: async () => { validations++; return null; },
      membershipQuote: { source: 'cart', matched: true, quote: { required: true, amount: 41.64, currency: 'GBP' } },
    }))));
    await settle();
    await act(async () => container.querySelector('[data-testid="button-form-payment-stripe-pay"]').click());
    assert.equal(validations, 1);
    assert.equal(requests, 1, 'only provider discovery; no payment create');
    assert.equal(locks, 0);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove();
    window.removeEventListener('form-cart-locked', handleLock);
  }
});

for (const code of ['CART_ATTEMPT_ENDED', 'CART_ATTEMPT_UNRESOLVED', 'BUNDLE_ATTEMPT_ENDED', 'BUNDLE_ATTEMPT_UNRESOLVED']) {
  test(`${code}: cart locks persist until an ended attempt successfully rotates its key`, async () => {
    const creates = [];
    let rotations = 0;
    let failRotation = true;
    const form = { id: 'form-one', fields: [{ id: 'cart', type: 'sales_cart' }] };
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('form-payment-providers')) return { ok: true, json: async () => ({ providers: [{ id: 'stripe', configured: true }] }) };
      if (String(url).includes('form-bundles')) return { ok: true, json: async () => ({ items: [item] }) };
      creates.push(JSON.parse(options.body));
      return { ok: false, status: 409, json: async () => ({ code, error: 'This attempt cannot continue' }) };
    };
    const client = createClient();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Fixture() {
      const [values, setValues] = React.useState({ cart: saved });
      const [key, setKey] = React.useState('attempt-one');
      useFormBundleUnavailable(form, setValues, () => {});
      return React.createElement(React.Fragment, null,
        React.createElement(CartField, { field: form.fields[0], formId: form.id, value: values.cart, onChange: cart => setValues({ cart }) }),
        React.createElement(FormPaymentSubmit, {
          field: { id: 'pay', type: 'payment', price_field_id: 'cart', payment_providers: ['stripe'] },
          formValues: values, idempotencyKey: key,
          buildPayload: async () => ({ form_id: form.id, submission_data: values }),
          membershipQuote: { source: 'cart', matched: true, quote: { required: true, amount: 41.64, currency: 'GBP' } },
          onNewAttempt: async () => {
            if (failRotation) throw new Error('Key rotation failed');
            rotations++;
            setKey('attempt-two');
          },
        }));
    }
    const checkout = () => container.querySelector('[data-testid="button-form-payment-stripe-pay"]');
    const restart = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Start a new payment attempt');
    try {
      await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
      await settle();
      assert.equal(container.querySelector('input').min, '1');
      await act(async () => checkout().click());
      assert.equal(creates.length, 1);
      assert.equal(checkout(), null, 'never blindly retry the same checkout');
      assert.equal(container.querySelector('input').disabled, true);
      assert.equal(client.getQueryData(['form-cart-locked', form.id]), true);
      await act(async () => window.dispatchEvent(new CustomEvent('form-cart-unlocked', { detail: { formId: 'another-form' } })));
      assert.equal(container.querySelector('input').disabled, true);
      if (code.endsWith('_ENDED')) {
        assert.ok(restart());
        await act(async () => restart().click());
        assert.match(container.textContent, /Key rotation failed/);
        assert.equal(client.getQueryData(['form-cart-locked', form.id]), true);
        assert.equal(container.querySelector('input').disabled, true);
        failRotation = false;
        await act(async () => restart().click());
        await settle();
        assert.equal(rotations, 1);
        assert.equal(client.getQueryData(['form-cart-locked', form.id]), false);
        assert.equal(container.querySelector('input').disabled, false);
        assert.equal(container.querySelector('input').value, '2', 'answers survive restart');
        await act(async () => checkout().click());
        assert.equal(creates.length, 2);
        assert.notEqual(creates[0].idempotency_key, creates[1].idempotency_key);
      } else {
        assert.equal(restart(), undefined);
        assert.match(container.textContent, /Administrator review required/);
        assert.match(container.textContent, /Do not pay again/);
        assert.equal(rotations, 0);
        assert.equal(creates.length, 1);
      }
    } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
  });
}

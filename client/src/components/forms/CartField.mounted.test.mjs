import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/cart' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'sessionStorage', 'location']) {
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
async function mount(initialValue = '', formId = 'form-one', settings = {}, props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = createClient();
  const answers = [];
  const validity = [];
  function Fixture() {
    const [value, setValue] = React.useState(initialValue);
    return React.createElement(CartField, {
      field: { id: 'cart', type: 'sales_cart', required: true, ...settings }, formId, value,
      onChange: next => { answers.push(next); setValue(next); },
      onValidityChange: (_id, valid) => validity.push(valid),
      ...props,
    });
  }
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
  return { container, client, answers, validity, close: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test('drafts start at one without committing; removing an item emits identities and quantities only', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item] }) });
  const empty = await mount();
  try {
    await settle();
    assert.equal(empty.container.querySelector('input').value, '1');
    assert.equal(empty.answers.length, 0, 'no accidental preselection');
    assert.equal(empty.validity.at(-1), false);
    assert.match(empty.container.textContent, /17.35 each/);
    assert.match(empty.container.textContent, /Plus 20% tax/);
  } finally { await empty.close(); }
  const selected = await mount(saved);
  try {
    await settle();
    assert.equal(selected.container.querySelector(`#cart-cart-product-${id}`).value, '2');
    assert.equal(selected.validity.at(-1), true);
    await act(async () => [...selected.container.querySelectorAll('button')].find(button => button.textContent === 'Remove').click());
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
    assert.equal(fixture.container.querySelector(`#cart-cart-product-${id}`).value, '2');
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'other-form' } })));
    assert.equal(fixture.container.querySelector('input').disabled, false);
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'form-one' } })));
    assert.equal(fixture.container.querySelector('input').disabled, true);
    assert.ok([...fixture.container.querySelectorAll('button:not([data-testid="cart-recover-payment"])')].every(button => button.disabled));
    assert.equal(fixture.container.querySelector('[data-testid="cart-recover-payment"]'), null);
  } finally { await fixture.close(); }
});

test('loading saved cart never shows missing-item warnings or internal identifiers', async () => {
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const fixture = await mount(saved);
  try {
    assert.match(fixture.container.textContent, /Loading cart options/);
    assert.doesNotMatch(fixture.container.textContent, /unavailable|Review unavailable/);
    assert.equal(fixture.container.textContent.includes(id), false);
    await act(async () => finish({ ok: true, json: async () => ({ items: [item] }) }));
    await settle();
    assert.match(fixture.container.textContent, new RegExp(item.name));
  } finally { await fixture.close(); }
});

test('cart recovery preserves answers and only unlocks after server cancellation', async () => {
  let release;
  let rotations = 0;
  let navigations = 0;
  const form = { id: 'form-one', fields: [{ id: 'cart', type: 'sales_cart' }] };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('form-bundles')) return { ok: true, json: async () => ({ items: [item] }) };
    assert.equal(JSON.parse(options.body).action, 'cancel_cart');
    return new Promise(resolve => { release = resolve; });
  };
  const client = createClient();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const [values, setValues] = React.useState({ cart: saved });
    const goBack = useFormBundleUnavailable(form, setValues, () => {}, {
      getIdempotencyKey: () => 'original-checkout-key', rotateIdempotencyKey: () => { rotations++; },
    });
    return React.createElement(React.Fragment, null,
      React.createElement('button', { 'data-testid': 'previous', onClick: () => goBack(() => { navigations++; }) }, 'Previous'),
      React.createElement(CartField, { field: form.fields[0], formId: form.id, value: values.cart, onChange: cart => setValues({ cart }) }));
  }
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
    await settle();
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: form.id } })));
    await act(async () => container.querySelector('[data-testid="previous"]').click());
    await settle();
    assert.match(container.textContent, /Cancelling unfinished payment/);
    assert.equal(navigations, 0);
    assert.equal(client.getQueryData(['form-cart-locked', form.id]), true);
    await act(async () => release({ ok: false, json: async () => ({ error: 'Payment is processing' }) }));
    await settle();
    assert.equal(rotations, 0);
    assert.equal(navigations, 0);
    assert.match(container.textContent, /Payment is processing/);
    await act(async () => container.querySelector('[data-testid="previous"]').click());
    await act(async () => release({ ok: true, json: async () => ({ released: true }) }));
    await settle();
    assert.equal(rotations, 1);
    assert.equal(navigations, 1);
    assert.equal(client.getQueryData(['form-cart-locked', form.id]), false);
    assert.equal(container.querySelector(`#cart-cart-product-${id}`).value, '2');
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
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
    assert.equal(fixture.container.querySelector(`#cart-cart-product-${id}`).value, '2');
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
        assert.deepEqual(locked, { formId: 'form-one', provider: 'stripe' });
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

const selectValue = async (select, value) => act(async () => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
test('dropdown preserves restored sold-out bundles and blocks mutations during option failures', async () => {
  const restored = { version: 1, lines: [{ kind: 'bundle', id, quantity: 2 }] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ...item, kind: 'bundle', remaining: 0, available: false }] }) });
  const fixture = await mount(restored, 'form-one', { bundle_display: 'dropdown', show_bundle_category: true });
  try {
    await settle();
    const { container, answers, validity } = fixture;
    assert.equal(container.querySelector(`option[value="${id}"]`).disabled, true);
    assert.equal(container.querySelector(`#cart-cart-bundle-${id}`).value, '2');
    assert.equal(container.querySelector(`#cart-cart-bundle-${id}`).disabled, true);
    assert.equal(validity.at(-1), false);
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    await act(async () => window.dispatchEvent(new CustomEvent('form-cart-unavailable', { detail: { formId: 'form-one' } })));
    assert.ok([...container.querySelectorAll('input,select,button')].every(control => control.disabled));
    await act(async () => finish({ ok: false, status: 503, text: async () => '{"error":"Catalogue unavailable"}' }));
    await settle();
    assert.match(container.textContent, /Cart options are unavailable/);
    assert.deepEqual(answers, []);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry cart options').click());
    await settle();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Remove saved item').click());
    assert.deepEqual(answers.at(-1), { version: 1, lines: [] });
  } finally { await fixture.close(); }
});
for (const bundle_display of ['cards', 'dropdown']) {
  test(`${bundle_display}: categories retain selected bundles and product identity; quantities and locks are enforced`, async () => {
    const other = '12345678-1234-4234-8234-123456789013';
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item,
      { ...item, kind: 'bundle', name: 'Pack A', categoryId: 'a', categoryName: 'Books' },
      { ...item, id: other, kind: 'bundle', name: 'Pack B', categoryId: null, categoryName: null },
    ] }) });
    const fixture = await mount(saved, 'form-one', { bundle_display, show_bundle_category: true });
    const { container, answers } = fixture;
    const picker = () => container.querySelector('[aria-label="Bundle"]');
    const draft = () => container.querySelector('[aria-label="Bundle quantity"]');
    const action = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Add to cart');
    try {
      await settle();
      assert.equal(answers.length, 0);
      if (bundle_display === 'dropdown') {
        assert.equal(container.querySelectorAll('input').length, 3, 'only bundle draft and product draft/committed quantity');
        await selectValue(picker(), id);
        await setInput(draft(), '3');
        await act(async () => action().click());
        await selectValue(picker(), other);
        await act(async () => action().click());
        await selectValue(picker(), id);
        assert.equal(draft().value, '1', 'switching choices resets only the draft');
        assert.equal(action().textContent, 'Add to cart');
        await setInput(draft(), '1');
        await act(async () => action().click());
        assert.equal(answers.at(-1).lines.length, 3);
        await setInput(draft(), '8');
        assert.equal(action().disabled, true);
      } else {
        await setInput(container.querySelector(`#cart-draft-cart-bundle-${id}`), '4');
        assert.equal(answers.length, 0, 'draft editing does not change the answer');
        const card = container.querySelector(`#cart-draft-cart-bundle-${id}`).closest('div.rounded-md');
        await act(async () => card.querySelector('button').click());
      }
      await selectValue(container.querySelector('[aria-label="Bundle category"]'), '_uncategorised');
      assert.equal(container.querySelector(`#cart-cart-bundle-${id}`).value, '4');
      assert.equal(container.querySelector(`#cart-cart-product-${id}`).value, '2');
      if (picker()) assert.equal(picker().value, '', 'only uncommitted choice clears');
      const before = answers.length;
      await act(async () => window.dispatchEvent(new CustomEvent('form-cart-locked', { detail: { formId: 'form-one' } })));
      assert.ok([...container.querySelectorAll('input,select,button:not([data-testid="cart-recover-payment"])')].every(control => control.disabled));
      assert.equal(answers.length, before);
    } finally { await fixture.close(); }
  });
}

test('adding reserves stock, countdown survives remount, and verified expiry clears only the cart', async () => {
  sessionStorage.clear();
  let hold = null;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'reserve') hold = {
        id: body.reservation_id, state: 'shopping', version: (hold?.version || 0) + 1,
        answer: body.answer, serverNow: new Date().toISOString(),
        expiresAt: hold?.expiresAt || new Date(Date.now() + 300000).toISOString(),
      };
      return { ok: true, json: async () => ({ reservation: { ...hold, serverNow: new Date().toISOString() } }) };
    }
    return { ok: true, json: async () => ({ items: [item], reservationReady: true, reservation: hold }) };
  };
  const settings = { show_reservation_countdown: true, reservation_label: 'Reserved: {time}' };
  let fixture = await mount('', 'form-one', settings);
  try {
    await settle();
    assert.equal(calls.length, 0, 'opening the cart does not reserve stock');
    await act(async () => [...fixture.container.querySelectorAll('button')].find(b => b.textContent === 'Add to cart').click());
    await settle(); await settle();
    assert.equal(calls.find(c => c.action === 'reserve').answer.lines[0].quantity, 1);
    assert.equal(fixture.answers.at(-1).reservation_id, hold.id);
    assert.match(fixture.container.textContent, /Reserved: [45]:[0-5][0-9]/);
    const expiry = hold.expiresAt;
    await fixture.close();
    fixture = await mount('', 'form-one', settings);
    await settle(); await settle();
    assert.equal(hold.expiresAt, expiry);
    assert.equal(fixture.answers.at(-1).reservation_id, hold.id, 'refresh restores the same reservation');
    hold = { ...hold, state: 'released', version: hold.version + 1 };
    await act(async () => fixture.client.invalidateQueries({ queryKey: ['form-cart-reservation'] }));
    await settle();
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [] });
    assert.match(fixture.container.textContent, /reservation has ended/);
    assert.equal(sessionStorage.length, 0);
  } finally { await fixture.close(); sessionStorage.clear(); }
});

test('unknown payment at expiry never clears the held cart', async () => {
  sessionStorage.clear();
  const token = '12345678-1234-4234-8234-123456789099';
  const hold = { id: token, version: 2, state: 'held', answer: saved,
    expiresAt: new Date(Date.now() - 5000).toISOString(), serverNow: new Date().toISOString() };
  globalThis.fetch = async (_url, options) => options?.method === 'POST'
    ? { ok: true, json: async () => ({ reservation: hold }) }
    : { ok: true, json: async () => ({ items: [item], reservationReady: true }) };
  const fixture = await mount({ ...saved, reservation_id: token }, 'form-one', { show_reservation_countdown: true });
  try {
    await settle(); await settle();
    assert.match(fixture.container.textContent, /Checking payment before clearing/);
    assert.deepEqual(fixture.answers, []);
    assert.equal(fixture.container.querySelector('input').disabled, true);
  } finally { await fixture.close(); sessionStorage.clear(); }
});

test('reservation expires on another form page without erasing other answers', async () => {
  sessionStorage.clear();
  const token = '12345678-1234-4234-8234-123456789098';
  sessionStorage.setItem('form-cart-reservation:cart-test:form-one', token);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ reservation: {
    id: token, state: 'released', version: 3, answer: saved,
    expiresAt: new Date(Date.now() - 5000).toISOString(), serverNow: new Date().toISOString(),
  } }) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container), client = createClient();
  let current, rotations = 0;
  function LaterPage() {
    const [values, setValues] = React.useState({ cart: { ...saved, reservation_id: token }, name: 'Keep this answer' });
    current = values;
    useFormBundleUnavailable({ id: 'form-one', fields: [{ id: 'cart', type: 'sales_cart' }] }, setValues, () => {}, {
      rotateIdempotencyKey: () => { rotations++; },
    });
    return React.createElement('p', null, values.name);
  }
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(LaterPage))));
    await settle(); await settle();
    assert.equal(current.name, 'Keep this answer');
    assert.deepEqual(current.cart, { version: 1, lines: [] });
    assert.equal(rotations, 1);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove(); sessionStorage.clear();
  }
});

test('product quantities match bundle layout and optional heading separates the groups', async () => {
  const bundle = { ...item, kind: 'bundle', name: 'Exhibitor package' };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item, bundle] }) });
  for (const bundle_display of ['cards', 'dropdown']) {
    const fixture = await mount('', 'form-one', { bundle_display, products_heading: 'Select other options' });
    try {
      await settle();
      const heading = fixture.container.querySelector('h3');
      assert.equal(heading.textContent, 'Select other options');
      assert.equal(fixture.container.querySelectorAll('h3').length, 1);
      const productInput = fixture.container.querySelector(`#cart-draft-cart-product-${id}`);
      const bundleInput = bundle_display === 'cards'
        ? fixture.container.querySelector(`#cart-draft-cart-bundle-${id}`)
        : fixture.container.querySelector('[aria-label="Bundle quantity"]');
      assert.equal(productInput.parentElement.tagName, 'LABEL');
      assert.equal(productInput.parentElement.className, bundleInput.parentElement.className);
      assert.equal(productInput.className, bundleInput.className);
      assert(productInput.parentElement.parentElement.classList.contains('items-end'));
      assert(heading.compareDocumentPosition(productInput) & Node.DOCUMENT_POSITION_FOLLOWING);
      assert(bundleInput.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
      await act(async () => [...fixture.container.querySelectorAll('button')].filter(b => b.textContent === 'Add to cart').at(-1).click());
      assert.deepEqual(fixture.answers.at(-1).lines, [{ kind: 'product', id, quantity: 1 }]);
    } finally { await fixture.close(); }
  }
  for (const settings of [{}, { products_heading: '   ' }]) {
    const fixture = await mount('', 'form-one', settings);
    try { await settle(); assert.equal(fixture.container.querySelector('h3'), null); }
    finally { await fixture.close(); }
  }
  const view = await mount(saved, 'form-one', { products_heading: 'Select other options' }, { viewOnly: true });
  try { await settle(); assert.equal(view.container.querySelector('h3'), null); }
  finally { await view.close(); }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [bundle] }) });
  const bundlesOnly = await mount('', 'form-one', { products_heading: 'Select other options' });
  try { await settle(); assert.equal(bundlesOnly.container.querySelector('h3'), null); }
  finally { await bundlesOnly.close(); }
});

test('custom labels, alphabetical choices and bundle-only requiredness', async () => {
  const other = '12345678-1234-4234-8234-123456789013';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item,
    { ...item, kind: 'bundle', name: 'Zulu' },
    { ...item, id: other, kind: 'bundle', name: 'alpha' },
  ] }) });
  const fixture = await mount(saved, 'form-one', { bundle_display: 'dropdown', show_bundle_category: true,
    bundle_label: 'Package', bundle_category_label: 'Exhibitor level', bundle_required: true });
  try {
    await settle();
    const picker = fixture.container.querySelector('[aria-label="Package"]');
    assert(fixture.container.querySelector('[aria-label="Exhibitor level"]'));
    assert.deepEqual([...picker.options].slice(1).map(o => o.value), [other, id]);
    assert.equal(fixture.validity.at(-1), false, 'product alone does not satisfy bundle requirement');
    await selectValue(picker, other);
    assert.equal(fixture.validity.at(-1), false, 'uncommitted selection is not a cart line');
    await act(async () => [...fixture.container.querySelectorAll('button')].find(b => b.textContent === 'Add to cart').click());
    assert.equal(fixture.validity.at(-1), true);
  } finally { await fixture.close(); }
});

test('mixed product and bundle quantities use separate identities and stock violations block validity', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item, { ...item, kind: 'bundle', name: 'Reading pack', remaining: 4 }] }) });
  const fixture = await mount(saved);
  try {
    await settle();
    const bundleDraft = fixture.container.querySelector(`#cart-draft-cart-bundle-${id}`);
    await setInput(bundleDraft, '3');
    assert.equal(fixture.answers.length, 0);
    await act(async () => bundleDraft.closest('div.rounded-md').querySelector('button').click());
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [
      { kind: 'product', id, quantity: 2 }, { kind: 'bundle', id, quantity: 3 },
    ] });
    assert.equal(fixture.validity.at(-1), true);
    const productQuantity = fixture.container.querySelector(`#cart-cart-product-${id}`);
    await setInput(productQuantity, '8');
    assert.equal(fixture.answers.at(-1).lines.find(line => line.kind === 'product').quantity, 2, 'over-stock mutation is rejected');
    await setInput(productQuantity, '1');
    assert.equal(fixture.validity.at(-1), true);
    const beforeFraction = fixture.answers.length;
    await setInput(productQuantity, '1.5');
    assert.equal(fixture.answers.length, beforeFraction, 'fractional quantities never become answers');
    await setInput(fixture.container.querySelector(`#cart-cart-bundle-${id}`), '0');
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [{ kind: 'product', id, quantity: 1 }] });
  } finally { await fixture.close(); }
});

for (const bundle_display of ['cards', 'dropdown']) {
  test(`${bundle_display}: a maximum of one hides quantity controls and repeated Add cannot exceed the cap`, async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ...item, kind: 'bundle' }] }) });
    const fixture = await mount('', 'form-one', { bundle_display, bundle_max_quantities: { [id]: 1 }, bundle_required: true });
    try {
      await settle();
      if (bundle_display === 'dropdown') await selectValue(fixture.container.querySelector('[aria-label="Bundle"]'), id);
      assert.equal(fixture.container.querySelector('input'), null);
      assert.equal(fixture.answers.length, 0);
      const add = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Add to cart');
      assert.ok(add.querySelector('svg'), 'Add includes ShoppingCart icon');
      await act(async () => add.click());
      assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [{ kind: 'bundle', id, quantity: 1 }] });
      assert.equal(fixture.validity.at(-1), true);
      assert.equal(add.disabled, true);
      await act(async () => add.click());
      assert.equal(fixture.answers.length, 1);
      assert.equal(fixture.container.querySelector('input'), null, 'committed max-one bundle also has no quantity input');
      await act(async () => [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Remove').click());
      assert.equal(add.disabled, false);
      assert.equal(fixture.validity.at(-1), false);
    } finally { await fixture.close(); }
  });

  for (const cap of [3, 9]) {
    test(`${bundle_display}: repeated additions accumulate without exceeding ${cap < 7 ? 'bundle maximum' : 'stock'}`, async () => {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ...item, kind: 'bundle' }] }) });
      const fixture = await mount('', 'form-one', { bundle_display, bundle_max_quantities: { [id]: cap } });
      try {
        await settle();
        if (bundle_display === 'dropdown') await selectValue(fixture.container.querySelector('[aria-label="Bundle"]'), id);
        const draft = fixture.container.querySelector('input');
        const add = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Add to cart');
        await setInput(draft, '2');
        assert.equal(fixture.answers.length, 0);
        await act(async () => add.click());
        assert.equal(fixture.answers.at(-1).lines[0].quantity, 2);
        if (cap === 3) {
          assert.equal(add.disabled, true, 'second draft of two would exceed cap');
          await setInput(draft, '1');
          await act(async () => add.click());
        } else {
          await act(async () => add.click());
          assert.equal(fixture.answers.at(-1).lines[0].quantity, 4);
          await setInput(draft, '3');
          await act(async () => add.click());
        }
        assert.equal(fixture.answers.at(-1).lines[0].quantity, Math.min(cap, item.remaining));
        assert.equal(add.disabled, true);
        const before = fixture.answers.length;
        await act(async () => add.click());
        assert.equal(fixture.answers.length, before);
      } finally { await fixture.close(); }
    });
  }
}

test('product additions are explicit, cumulative, stock-bounded and use the cart icon', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item] }) });
  const fixture = await mount();
  try {
    await settle();
    const draft = fixture.container.querySelector('input');
    const add = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Add to cart');
    assert.ok(add.querySelector('svg'));
    await setInput(draft, '3');
    assert.equal(fixture.answers.length, 0);
    await act(async () => add.click());
    await act(async () => add.click());
    assert.equal(fixture.answers.at(-1).lines[0].quantity, 6);
    assert.equal(add.disabled, true);
    await setInput(draft, '1');
    await act(async () => add.click());
    assert.equal(fixture.answers.at(-1).lines[0].quantity, 7);
    assert.equal(add.disabled, true);
  } finally { await fixture.close(); }
});

test('view-only uses the original field catalogue, renders only committed lines, and derives editable totals from catalogue prices', async () => {
  const requests = [];
  const other = '12345678-1234-4234-8234-123456789013';
  globalThis.fetch = async url => {
    requests.push(String(url));
    return { ok: true, json: async () => ({ items: [item, { ...item, id: other, kind: 'bundle', name: 'Unselected pack' }] }) };
  };
  const fixture = await mount(saved, 'form-one', { bundle_display: 'dropdown', show_bundle_category: true }, { viewOnly: true, showCartContents: false });
  try {
    await settle();
    assert.equal(new URL(requests[0], 'http://localhost').searchParams.get('field_id'), 'cart');
    assert.equal(fixture.container.querySelector('select'), null);
    assert.doesNotMatch(fixture.container.textContent, /Unselected pack|Add to cart/);
    assert.equal(fixture.container.querySelectorAll('input').length, 1);
    const totals = () => [...fixture.container.querySelectorAll('dl > div')].map(row => row.textContent);
    assert.deepEqual(totals(), ['Subtotal£34.70', 'Tax£6.94', 'Total£41.64']);
    assert.equal(fixture.answers.length, 0);
    await setInput(fixture.container.querySelector('input'), '3');
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [{ kind: 'product', id, quantity: 3 }] });
    assert.deepEqual(totals(), ['Subtotal£52.05', 'Tax£10.41', 'Total£62.46']);
    await act(async () => fixture.container.querySelector('button').click());
    assert.deepEqual(fixture.answers.at(-1), { version: 1, lines: [] });
    assert.match(fixture.container.textContent, /Your cart is empty/);
    assert.deepEqual(totals(), ['Subtotal£0.00', 'Tax£0.00', 'Total£0.00']);
  } finally { await fixture.close(); }
});

test('regular mode can hide committed contents without hiding purchasing controls or resetting the answer', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [item] }) });
  const fixture = await mount(saved, 'form-one', {}, { showCartContents: false });
  try {
    await settle();
    assert.equal(fixture.container.querySelector('[aria-label="Cart contents"]'), null);
    assert.equal(fixture.container.querySelector('input').value, '1');
    const add = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Add to cart');
    await act(async () => add.click());
    assert.equal(fixture.answers.at(-1).lines[0].quantity, 3);
  } finally { await fixture.close(); }
});

test('restored over-cap bundles remain unchanged and invalid until corrected in the view', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [{ ...item, kind: 'bundle' }] }) });
  const fixture = await mount({ version: 1, lines: [{ kind: 'bundle', id, quantity: 4 }] }, 'form-one',
    { bundle_max_quantities: { [id]: 3 } }, { viewOnly: true });
  try {
    await settle();
    assert.equal(fixture.validity.at(-1), false);
    assert.equal(fixture.answers.length, 0);
    await setInput(fixture.container.querySelector('input'), '3');
    assert.equal(fixture.validity.at(-1), true);
    assert.equal(fixture.answers.at(-1).lines[0].quantity, 3);
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
    const treatment = container.querySelector('select[aria-label="Tax treatment for Reading pack"]');
    await act(async () => { treatment.value = 'standard'; treatment.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(field.bundle_tax[bundleId].rateBps, null);
    const rate = container.querySelector('[aria-label="Tax rate for Reading pack"]');
    await setInput(rate, '17.5');
    assert.equal(field.bundle_tax[bundleId].rateBps, 1750);
    const heading = container.querySelector('input[placeholder="Select other options"]');
    assert.equal(heading.maxLength, 120);
    await setInput(heading, 'Select other options');
    assert.equal(field.products_heading, 'Select other options');
    await setInput(heading, '');
    assert.equal(field.products_heading, '');
    const duration = container.querySelector('input[max="60"]');
    await setInput(duration, '12');
    assert.equal(field.reservation_minutes, 12);
    const countdown = [...container.querySelectorAll('[role="checkbox"]')].find(c => c.closest('label').textContent.includes('Show reservation countdown'));
    await act(async () => countdown.click());
    assert.equal(field.show_reservation_countdown, true);
    await setInput(container.querySelector('input[placeholder="Your items are reserved for {time}"]'), 'Complete within {time}');
    assert.equal(field.reservation_label, 'Complete within {time}');
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
        assert.equal(container.querySelector(`#cart-cart-product-${id}`).value, '2', 'answers survive restart');
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

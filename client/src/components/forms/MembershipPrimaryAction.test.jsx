import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PrimaryAction, MembershipPrimaryActionContext: Context, membershipReadyToSubmit } = await import('./MembershipPrimaryAction.jsx');

test('one footer action replaces the inline action, validates, blocks double clicks and unregisters', async () => {
  const field = document.createElement('div');
  const footer = document.createElement('div');
  document.body.append(field, footer);
  const root = createRoot(field);
  const registrations = new Set();
  let allowed = false, calls = 0, resolvePayment;
  const register = (id, active) => active ? registrations.add(id) : registrations.delete(id);
  const context = { target: footer, register, validate: async () => allowed, blocked: false };
  const render = (active = true) => root.render(<Context.Provider value={context}>
    <PrimaryAction active={active}><button onClick={() => {
      calls++;
      return new Promise(resolve => { resolvePayment = resolve; });
    }}>Continue with selected credit and payment method</button></PrimaryAction>
  </Context.Provider>);
  await act(async () => render());
  assert.equal(field.querySelectorAll('button').length, 0);
  assert.equal(footer.querySelectorAll('button').length, 1);
  assert.equal(registrations.size, 1);
  assert.equal(footer.querySelector('button').type, 'button');
  await act(async () => footer.querySelector('button').click());
  assert.equal(calls, 0, 'invalid form must not open checkout');
  allowed = true;
  await act(async () => {
    footer.querySelector('button').click();
    footer.querySelector('button').click();
  });
  assert.equal(calls, 1);
  await act(async () => resolvePayment());
  context.blocked = true;
  await act(async () => render());
  assert.equal(footer.querySelector('button').disabled, true);
  await act(async () => render(false));
  assert.equal(footer.querySelectorAll('button').length, 0);
  assert.equal(registrations.size, 0);
  await act(async () => root.unmount());
  field.remove(); footer.remove();
});

test('standalone payment pages retain their existing action', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PrimaryAction><button>Pay by card</button></PrimaryAction>));
  assert.equal(host.querySelectorAll('button').length, 1);
  await act(async () => root.unmount());
  host.remove();
});

test('only paid or scoped verified voucher setup statuses can finish the form', () => {
  assert.equal(membershipReadyToSubmit({ status: 'paid' }), true);
  assert.equal(membershipReadyToSubmit({ status: 'voucher_checkout_pending', voucherCheckoutId: 'checkout' }), false);
  assert.equal(membershipReadyToSubmit({ status: 'direct_debit_started' }), false);
  for (const status of ['direct_debit_started', 'monthly_card_started']) {
    assert.equal(membershipReadyToSubmit({ status, voucherCheckoutId: 'checkout', agreementId: 'agreement' }), true);
  }
});

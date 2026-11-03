import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/FormView?slug=renew' });
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Credit } = await import('./FormMembershipCredit.jsx');
const { MembershipCheckoutDraftContext } = await import('./MembershipCheckoutDraftContext.jsx');
const { MembershipPrimaryActionContext } = await import('./MembershipPrimaryAction.jsx');
test('credit discovery shows loading, empty, error and staged availability without creating a checkout', async () => {
  for (const scenario of ['loading', 'empty', 'error', 'available']) {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      if (scenario === 'loading') return new Promise(() => {});
      return new Response(JSON.stringify(scenario === 'error' ? { error: 'Credit service is unavailable' }
        : { enabled: true, checkoutReady: false, currency: 'GBP', vouchers: scenario === 'available'
          ? [{ id: 'v', code: 'TESTCREDIT', value: 10, displayName: 'Member credit' }] : [] }),
      { status: scenario === 'error' ? 503 : 200 });
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<Credit memberId="member" context={{ formId: 'form', paymentFieldId: 'field' }}
        methods={[{ id: 'upfront', label: 'Pay in full by card' }]} onRefresh={() => {}} />);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /action=vouchers/);
    assert.match(requests[0].url, /formId=form/);
    assert.equal(requests[0].options.credentials, 'include');
    if (scenario === 'loading') assert.match(host.textContent, /Checking for available/);
    if (scenario === 'empty') assert.match(host.textContent, /no eligible credit/);
    if (scenario === 'error') {
      assert.match(host.textContent, /Credit service is unavailable/);
      assert.doesNotMatch(host.textContent, /no eligible credit/);
    }
    if (scenario === 'available') {
      assert.match(host.textContent, /TESTCREDIT.*£10\.00/);
      assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 1);
      assert.equal(host.querySelectorAll('select').length, 0);
      assert.match(host.textContent, /not yet enabled/);
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('voucher cards combine selections and support deselection without a payment request', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(options);
    return new Response(JSON.stringify({ enabled: true, currency: 'GBP',
      vouchers: [{ id: 'a', code: 'FIRST', value: 10 }, { id: 'b', code: 'SECOND', value: 15 }] }));
  };
  let selected;
  function Harness() {
    const [vouchers, setVouchers] = React.useState([]);
    selected = vouchers;
    return <Credit memberId="member" context={{ formId: 'f' }}
      selectedVouchers={vouchers} onSelectionChange={setVouchers} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Harness />); await new Promise(r => setTimeout(r, 15)); });
  const boxes = host.querySelectorAll('input[type="checkbox"]');
  await act(async () => boxes[0].click());
  await act(async () => boxes[1].click());
  assert.deepEqual(selected.map(v => v.id), ['a', 'b']);
  await act(async () => boxes[0].click());
  assert.deepEqual(selected.map(v => v.id), ['b']);
  assert.equal(requests.length, 1);
  await act(async () => root.unmount());
  host.remove();
});

test('continue sends the selected card and voucher IDs, and retains selection on rejection', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ error: 'Checkout is temporarily unavailable' }), { status: 409 });
    }
    return new Response(JSON.stringify({ enabled: true, checkoutReady: true, currency: 'GBP',
      vouchers: [{ id: 'a', code: 'FIRST', value: 10 }, { id: 'b', code: 'SECOND', value: 15 }] }));
  };
  const host = document.createElement('div');
  const footer = document.createElement('div');
  document.body.append(host, footer);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MembershipCheckoutDraftContext.Provider value={async () => '/FormView?slug=renew&draft=saved'}>
      <MembershipPrimaryActionContext.Provider value={{ target: footer, register: () => {}, validate: async () => true }}>
      <Credit memberId="member" context={{ formId: 'f', paymentFieldId: 'p' }}
        selectedMethod="monthly_card" selectedVouchers={[{ id: 'a' }, { id: 'b' }]} />
      </MembershipPrimaryActionContext.Provider>
    </MembershipCheckoutDraftContext.Provider>);
    await new Promise(resolve => setTimeout(resolve, 15));
  });
  assert.equal(host.querySelectorAll('button').length, 0, 'no competing action remains in the credit panel');
  assert.equal(footer.querySelectorAll('button').length, 1);
  const button = footer.querySelector('button');
  assert.ok(button);
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.deepEqual(requests[0], { formId: 'f', paymentFieldId: 'p', memberId: 'member',
    action: 'start_voucher_checkout', paymentMethod: 'monthly_card', voucherIds: ['a', 'b'] });
  assert.match(host.textContent, /Checkout is temporarily unavailable/);
  assert.equal(host.querySelectorAll('input:checked').length, 2);
  await act(async () => root.unmount());
  host.remove(); footer.remove();
});

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
      assert.equal([...host.querySelectorAll('button')].find(b => b.textContent === 'Use membership credit').disabled, true);
      assert.match(host.textContent, /not yet enabled/);
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/forms/renew' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MembershipPaymentField } = await import('./MembershipPaymentField.jsx');

test('membership payment uses delayed canonical prefill identity; explicit URL never falls back', async () => {
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Response(JSON.stringify(String(input).includes('payment-plan')
      ? { currentPlan: null }
      : { error: 'Quote fixture reached' }), { status: String(input).includes('payment-plan') ? 200 : 403 });
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async id => act(async () => {
    root.render(<MembershipPaymentField key={id || 'none'} field={{}} resolvedMemberId={id} />);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  await render(null);
  assert.equal(requests.length, 0, 'anonymous/unresolved session does not quote');
  await render('session-member');
  assert.ok(requests.some(url => url.includes('membership-payment?memberId=session-member')));
  requests.length = 0;
  await render('session-member');
  assert.equal(requests.length, 0, 'ordinary rerender does not reset quote or input');
  window.history.replaceState({}, '', '/forms/renew?member_id=explicit-member');
  await render('different-session-member');
  assert.ok(requests.some(url => url.includes('membership-payment?memberId=explicit-member')));
  assert.ok(requests.every(url => !url.includes('different-session-member')));
  requests.length = 0;
  window.history.replaceState({}, '', '/forms/renew?member_id=');
  await render('another-session-member');
  assert.equal(requests.length, 0, 'empty explicit applicant never becomes session member');
  await act(async () => root.unmount());
  host.remove();
});
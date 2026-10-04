import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/forms/renew' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
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

test('active access alone is not reported as paid; explicitly settled scheduled terms show commencement', async () => {
  window.history.replaceState({}, '', '/forms/renew');
  for (const record of [
    { id: 'unpaid', status: 'active', paymentStatus: 'unpaid' },
    { id: 'partial', status: 'active', paymentStatus: 'partially_paid' },
    { id: 'unknown', status: 'active' },
    { id: 'settled', status: 'active', paymentStatus: 'paid' },
    { id: 'next', status: 'scheduled', paymentStatus: 'paid', termStart: '2027-01-01' },
  ]) {
    const changes = [];
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('payment-plan')
      ? { currentPlan: null }
      : {
          membershipYear: '2027', finalCost: 120, totalWithVat: 120, currency: 'GBP',
          stripeEnabled: false, existingRecord: record,
        }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" onChange={value => changes.push(value)} />);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    const paid = record.paymentStatus === 'paid';
    assert.equal(!!host.querySelector('[data-testid="text-payment-success"]'), paid, record.id);
    assert.equal(changes.some(value => value.status === 'already_paid'), paid, record.id);
    if (record.status === 'scheduled') {
      assert.match(host.querySelector('[data-testid="text-membership-scheduled"]').textContent, /2027-01-01/);
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('unused renewal restart uses authenticated request and displays refusal rather than another payment', async () => {
  window.history.replaceState({}, '', '/forms/renew');
  const requests = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ input: String(input), options });
    if (options?.method === 'POST') return new Response(JSON.stringify({
      error: 'An existing payment must be reconciled, not replaced.',
    }), { status: 409 });
    return new Response(JSON.stringify(String(input).includes('payment-plan') ? { currentPlan: null }
      : { renewal: { state: 'renewal_pending', eligible: false, currentEnd: '2026-12-31',
        currentPaymentStatus: 'paid', electionId: 'election' } }));
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" onChange={() => {}} />);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Restart unused renewal');
  assert.ok(button);
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.match(host.querySelector('[role="alert"]').textContent, /must be reconciled/);
  const post = requests.find(request => request.options?.method === 'POST');
  assert.equal(post.options.credentials, 'include');
  assert.deepEqual(JSON.parse(post.options.body), { action: 'release_unused_renewal', memberId: 'member' });
  await act(async () => root.unmount());
  host.remove();
});
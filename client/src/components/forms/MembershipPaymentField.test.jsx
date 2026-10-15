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
      assert.match(host.querySelector('[data-testid="text-membership-scheduled"]').textContent, /01\/01\/2027/);
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('payment method change uses authenticated request and displays refusal rather than another payment', async () => {
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
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Change payment method');
  assert.ok(button);
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.match(host.querySelector('[role="alert"]').textContent, /must be reconciled/);
  const post = requests.find(request => request.options?.method === 'POST');
  assert.equal(post.options.credentials, 'include');
  assert.deepEqual(JSON.parse(post.options.body), { action: 'change_renewal_payment_method', memberId: 'member', electionId: 'election' });
  await act(async () => root.unmount());
  host.remove();
});

test('legacy renewal summaries show useful dates without administrative evidence wording', async () => {
  window.history.replaceState({}, '', '/forms/renew');
  for (const quoted of [false, true]) {
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('payment-plan')
      ? { currentPlan: null } : {
        ...(quoted ? { membershipYear: 'rolling:2026-09-26', finalCost: 120,
          totalWithVat: 120, currency: 'GBP', stripeEnabled: false } : {}),
        renewal: { state: quoted ? 'eligible_renewal' : 'renewal_closed', eligible: quoted,
          currentStart: null, currentEnd: '2026-09-25', currentPaymentStatus: 'paid',
          successorStart: '2026-09-26', successorEnd: '2027-09-25',
          closesOn: '2026-12-24',
          evidenceSource: 'operator_attested_expiry_only' },
      }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" />);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    assert.doesNotMatch(host.textContent, /administrator attestation|provider settlement|Historical commencement/);
    assert.match(host.textContent, /Your renewal covers: 26\/09\/2026 to 25\/09\/2027/);
    assert.match(host.textContent, /Current membership ends: 25\/09\/2026/);
    if (!quoted) assert.match(host.textContent, /Online renewal closed on 24\/12\/2026/);
    assert.doesNotMatch(host.textContent, /2026-09-25|2026-09-26|2027-09-25/);
    assert.doesNotMatch(host.textContent, /2025-09-26/);
    await act(async () => root.unmount());
    host.remove();
  }
});

const renewalQuote = (method = 'upfront') => ({
  membershipYear: '2027', finalCost: 120, totalWithVat: 120, currency: 'GBP',
  stripeEnabled: true, stripePublishableKey: 'pk_test_fixture',
  cardMonthly: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120, currency: 'GBP' },
  directDebit: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120, currency: 'GBP', scope: 'member' },
  renewal: { state: 'renewal_pending', eligible: false, selectedMethod: method, electionId: 'election', switchState: 'idle' },
});

async function mountRenewal(quote, postResponse = { released: true }, afterRelease) {
  window.history.replaceState({}, '', '/forms/renew');
  const posts = [];
  let current = quote;
  globalThis.fetch = async (input, options) => {
    if (options?.method === 'POST') {
      posts.push({ ...JSON.parse(options.body), credentials: options.credentials });
      const result = typeof postResponse === 'function' ? await postResponse(posts.at(-1)) : postResponse;
      if (result.released) current = afterRelease || {
        ...quote, renewal: { state: 'eligible_renewal', eligible: true, quoteKey: 'fresh' },
      };
      return new Response(JSON.stringify(result), { status: result.error ? 409 : 200 });
    }
    return new Response(JSON.stringify(String(input).includes('payment-plan') ? { currentPlan: null } : current));
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" />);
  });
  return { host, posts,
    card: id => [...host.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.includes({
      upfront: 'Pay in full by card', monthly_card: 'Pay monthly by card', direct_debit: 'Pay monthly by Direct Debit',
    }[id])),
    close: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}
const click = async button => act(async () => { assert.ok(button); button.click(); });

test('abandoned card renewals retain all eligible cards and allow same-method continuation without cancellation', async () => {
  for (const method of ['upfront', 'monthly_card']) {
    const mounted = await mountRenewal(renewalQuote(method));
    const { host, posts, card } = mounted;
    assert.equal(host.querySelectorAll('button[aria-pressed]').length, 3);
    assert.equal(card(method).getAttribute('aria-pressed'), 'true');
    assert.ok(card(method).querySelector('svg'), 'non-text selected indicator');
    assert.doesNotMatch(host.textContent, /in progress/i);
    assert.equal(host.querySelector('[data-testid="button-monthly-card-payment"]'), null);
    await click(card(method));
    assert.equal(posts.length, 0, 'selecting a card is not consent or a charge');
    assert.ok(host.querySelector(`[data-testid="${method === 'upfront' ? 'button-pay-membership' : 'button-monthly-card'}-payment"]`));
    await mounted.close();
  }
});

test('switching waits for release, rejects repeated clicks and uses refreshed prices before consent', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fresh = renewalQuote();
  fresh.renewal = { state: 'eligible_renewal', eligible: true, quoteKey: 'new' };
  fresh.directDebit.monthlyAmount = 15;
  const mounted = await mountRenewal(renewalQuote(), () => gate, fresh);
  const { host, posts, card } = mounted;
  await act(async () => { card('direct_debit').click(); card('monthly_card').click(); });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].credentials, 'include');
  assert.equal(posts[0].action, 'change_renewal_payment_method');
  assert.ok([...host.querySelectorAll('button')].every(button => button.disabled));
  assert.match(card('direct_debit').textContent, /Checking Pay monthly by Direct Debit/);
  assert.equal(card('upfront').getAttribute('aria-pressed'), 'true');
  await act(async () => { release({ released: true }); });
  assert.equal(card('direct_debit').getAttribute('aria-pressed'), 'true');
  assert.match(card('direct_debit').textContent, /15.00/);
  assert.ok(host.querySelector('[data-testid="text-dd-first-collection-payment"]'));
  assert.ok(host.querySelector('[data-testid="button-direct-debit-payment"]'));
  assert.equal(posts.length, 1, 'replacement does not start until explicit continuation');
  await mounted.close();
});

test('refused or uncertain switching retains original method and explains recovery', async () => {
  for (const response of [{ error: 'Payment must be reconciled. Check renewal status.' }, { released: false }]) {
    const mounted = await mountRenewal(renewalQuote('monthly_card'), response);
    await click(mounted.card('upfront'));
    assert.equal(mounted.card('monthly_card').getAttribute('aria-pressed'), 'true');
    assert.equal(mounted.posts.length, 1);
    assert.ok(mounted.host.querySelector('[role="alert"]'));
    await mounted.close();
  }
});

test('fresh eligibility removes unavailable method and never starts stale replacement', async () => {
  const fresh = { ...renewalQuote(), directDebit: null, renewal: { state: 'eligible_renewal', eligible: true } };
  const mounted = await mountRenewal(renewalQuote(), { released: true }, fresh);
  await click(mounted.card('direct_debit'));
  assert.equal(mounted.card('direct_debit'), undefined);
  assert.match(mounted.host.querySelector('[role="alert"]').textContent, /could not be confirmed/);
  assert.equal(mounted.posts.length, 1);
  await mounted.close();
});

test('missing quote invents no choices and reconciliation blocks payment while retaining alternatives', async () => {
  const missing = await mountRenewal({ renewal: renewalQuote().renewal });
  assert.equal(missing.host.querySelectorAll('button[aria-pressed]').length, 0);
  assert.match(missing.host.textContent, /Check renewal status/);
  await missing.close();
  const quote = renewalQuote();
  quote.renewal.switchState = 'reconciling';
  const mounted = await mountRenewal(quote);
  await click(mounted.card('upfront'));
  assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
  assert.equal(mounted.posts.length, 0);
  await mounted.close();
});

test('upfront continuation keeps alternatives visible and confirms using existing payment controls', async () => {
  const calls = [];
  window.Stripe = () => ({
    elements: () => ({ create: () => ({ mount() {} }), submit: async () => ({}) }),
    confirmPayment: async () => { calls.push('confirm'); return { paymentIntent: { id: 'pi_fixture', status: 'succeeded' } }; },
  });
  const mounted = await mountRenewal(renewalQuote(), request => {
    if (request.action === 'create_payment') return { clientSecret: 'fixture', membershipYear: '2027', renewalElectionId: 'election' };
    if (request.action === 'confirm_payment') return { success: true };
    throw new Error('Unexpected cancellation');
  });
  await click(mounted.card('upfront'));
  await click(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'));
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
  await click(mounted.host.querySelector('[data-testid="button-confirm-payment-payment"]'));
  assert.deepEqual(calls, ['confirm']);
  assert.ok(mounted.host.querySelector('[data-testid="text-payment-success"]'));
  assert.deepEqual(mounted.posts.map(post => post.action), ['create_payment', 'confirm_payment']);
  await mounted.close();
  delete window.Stripe;
});

test('monthly card and Direct Debit require explicit continuation after selection', async () => {
  for (const method of ['monthly_card', 'direct_debit']) {
    const mounted = await mountRenewal(renewalQuote(method), request => {
      assert.equal(request.action, method === 'monthly_card' ? 'start_monthly_card' : 'start_direct_debit');
      return { agreementId: 'mock-agreement' };
    });
    await click(mounted.card(method));
    assert.equal(mounted.posts.length, 0);
    if (method === 'direct_debit') {
      assert.ok(mounted.host.querySelector('[data-testid="text-dd-first-collection-payment"]'));
      assert.match(mounted.host.textContent, /Direct Debit Guarantee/);
    }
    await click(mounted.host.querySelector(`[data-testid="${method === 'monthly_card' ? 'button-monthly-card' : 'button-direct-debit'}-payment"]`));
    assert.equal(mounted.posts.length, 1);
    await mounted.close();
  }
});

test('switch refresh finding completed renewal cannot start the replacement', async () => {
  const mounted = await mountRenewal(renewalQuote(), { released: true }, {
    renewal: { state: 'next_term_purchased', eligible: false },
  });
  await click(mounted.card('monthly_card'));
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
  assert.match(mounted.host.textContent, /already been paid/);
  assert.equal(mounted.posts.length, 1);
  await mounted.close();
});

test('joining behaviour keeps original continuation buttons without renewal chooser', async () => {
  const mounted = await mountRenewal({ ...renewalQuote(), renewal: { state: 'joining' } });
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
  for (const id of ['button-pay-membership', 'button-monthly-card', 'button-direct-debit']) {
    assert.ok(mounted.host.querySelector(`[data-testid="${id}-payment"]`));
  }
  await mounted.close();
});
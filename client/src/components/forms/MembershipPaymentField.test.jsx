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

test('the existing payment cards show combined credit estimates and restore gross prices on deselection', async () => {
  const { renewalOptions } = await import('./MembershipPaymentField.jsx');
  const data = { membershipYear: {}, stripeEnabled: true, currency: 'GBP', totalWithVat: 47,
    cardMonthly: { monthlyAmount: 3.92, instalmentCount: 12 },
    directDebit: { monthlyAmount: 3.92, instalmentCount: 12 } };
  const discounted = renewalOptions(data, [{ id: 'one', value: 20 }, { id: 'two', value: 12.79 }]);
  assert.equal(discounted.length, 3);
  assert.match(discounted[0].price, /£14\.21.*estimate/);
  assert.match(discounted[1].price, /£1\.18.*first month.*estimate/);
  assert.match(discounted[2].price, /£1\.18.*first month.*estimate/);
  assert.equal(renewalOptions(data)[0].price, '£47.00');
  assert.equal(renewalOptions(data)[1].price, '£3.92/month');
});

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

test('voucher background refresh is single-flight and does not disable return to choices', async () => {
  window.history.replaceState({}, '', '/forms/renew');
  dom.reconfigure({ windowTop: {} });
  const quote = { ...renewalQuote(), memberScoped: true, voucherCheckoutToken: 'saved-checkout' };
  let quoteRequests = 0, resolvePoll;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('payment-plan')) return new Response(JSON.stringify({ currentPlan: null }));
    if (url.includes('action=vouchers')) return new Response(JSON.stringify({ vouchers: [] }));
    quoteRequests++;
    if (quoteRequests === 1) return new Response(JSON.stringify(quote));
    return new Promise(resolve => { resolvePoll = resolve; });
  };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<MembershipPaymentField field={{ id: 'payment' }} formId="form" resolvedMemberId="member" />);
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(quoteRequests, 1, 'mount effects share the initial request');
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Back');
    assert.ok(button);
    assert.equal(button.disabled, false);
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.Event('focus'));
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    assert.equal(quoteRequests, 2, 'focus and visibility share one pending request');
    assert.equal(button.disabled, false, 'background checking must not consume the click');
    await act(async () => {
      resolvePoll(new Response(JSON.stringify(quote)));
      await new Promise(r => setTimeout(r, 10));
    });
    assert.equal(button.disabled, false);
  } finally { await act(async () => root.unmount()); host.remove(); dom.reconfigure({ windowTop: dom.window }); }
});

async function mountRenewal(quote, postResponse = { released: true }, afterRelease, props = {}) {
  window.history.replaceState({}, '', '/forms/renew');
  const posts = [];
  const gets = [];
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
    gets.push(String(input));
    return new Response(JSON.stringify(String(input).includes('payment-plan') ? { currentPlan: null } : current));
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" {...props} />);
  });
  return { host, posts, gets,
    card: id => [...host.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.includes({
      upfront: 'Pay in full by card', monthly_card: 'Pay monthly by card', direct_debit: 'Pay monthly by Direct Debit',
    }[id])),
    close: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}
const click = async button => act(async () => { assert.ok(button); button.click(); });
const continueToPayment = async host => click([...host.querySelectorAll('button')].find(button => button.textContent === 'Continue to payment'));

test('rendered renewal Direct Debit choices stay concise before and after selection; consent stays separate', async () => {
  for (const pricing_policy of ['fixed', 'dynamic']) {
    const mounted = await mountRenewal({
      ...renewalQuote(),
      directDebit: { monthlyAmount: 3.92, currency: 'GBP', instalmentCount: 12, planTotal: 47,
        firstCollectionRule: 'nominated_day', collectionDay: 21, scope: 'member',
        collectionPolicy: { end_policy: 'continue', pricing_policy } },
      renewal: { state: 'eligible_renewal', eligible: true },
    });
    try {
      const card = () => mounted.card('direct_debit');
      assert.equal(card().getAttribute('aria-pressed'), 'false');
      assert.equal(card().textContent, 'Pay monthly by Direct Debit£3.92/month');
      await click(card());
      assert.equal(card().getAttribute('aria-pressed'), 'true');
      assert.equal(card().textContent, 'Pay monthly by Direct Debit£3.92/month');
      assert.equal(mounted.posts.length, 0);
      await continueToPayment(mounted.host);
      assert.ok(mounted.host.querySelector('[data-testid="button-direct-debit-payment"]'));
      const consent = mounted.host.querySelector('[data-testid="text-dd-first-collection-payment"]');
      assert.match(consent.textContent, /21st/);
      assert.match(consent.textContent, /Collections continue/);
      assert.match(consent.textContent, pricing_policy === 'dynamic' ? /amount can change.*provider processing/ : /fixed for this membership term/);
      assert.equal(mounted.posts.length, 0);
    } finally { await mounted.close(); }
  }
});

test('rendered credit choices retain first-month estimates and unavailable estimates, then restore the monthly rate', async () => {
  const { renewalOptions } = await import('./MembershipPaymentField.jsx');
  const { default: Chooser } = await import('./RenewalMethodChooser.jsx');
  for (const count of [12, null]) {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const quote = { ...renewalQuote(), totalWithVat: 47,
      directDebit: { monthlyAmount: 3.92, instalmentCount: count, currency: 'GBP' } };
    const render = async (vouchers, selectedMethod) => act(async () => {
      root.render(<Chooser options={renewalOptions(quote, vouchers)} selectedMethod={selectedMethod}
        onSelect={id => { assert.equal(id, 'direct_debit'); }} />);
    });
    try {
      for (const selected of [null, 'direct_debit']) {
        await render([{ id: 'credit', value: 32.79 }], selected);
        const card = [...host.querySelectorAll('button')].find(b => b.textContent.startsWith('Pay monthly by Direct Debit'));
        assert.equal(card.textContent, 'Pay monthly by Direct Debit' + (count
          ? '£1.18 first month after credit (estimate)' : 'Credit estimate unavailable'));
        assert.equal(card.getAttribute('aria-pressed'), String(selected === 'direct_debit'));
        await click(card);
      }
      await render([], 'direct_debit');
      assert.ok([...host.querySelectorAll('button')].some(b => b.textContent === 'Pay monthly by Direct Debit£3.92/month'));
    } finally { await act(async () => root.unmount()); host.remove(); }
  }
});

test('class mapping and saved form identity accompany quotes and every payment method', async () => {
  for (const method of ['upfront', 'monthly_card', 'direct_debit']) {
    const mounted = await mountRenewal({
      ...renewalQuote(), renewal: { state: 'eligible_renewal', eligible: true, quoteKey: 'class-quote' },
    }, { error: 'Test stops before provider work' }, undefined, {
      formId: 'renew-form',
      field: { id: 'payment', membership_config_id: 'base', field_mappings: { class: 'answer' } },
      allFormValues: { answer: 'Overseas associate' },
    });
    const quote = new URL(mounted.gets.find(url => url.includes('/api/forms/membership-payment')), 'https://test.invalid');
    assert.equal(quote.searchParams.get('formId'), 'renew-form');
    assert.equal(quote.searchParams.get('paymentFieldId'), 'payment');
    assert.deepEqual(JSON.parse(quote.searchParams.get('fieldOverrides')), { class: 'Overseas associate' });
    await click(mounted.card(method));
    const testId = { upfront: 'button-pay-membership', monthly_card: 'button-monthly-card', direct_debit: 'button-direct-debit' }[method];
    await continueToPayment(mounted.host);
    await click(mounted.host.querySelector(`[data-testid="${testId}-payment"]`));
    assert.equal(mounted.posts.length, 1);
    assert.equal(mounted.posts[0].formId, 'renew-form');
    assert.equal(mounted.posts[0].paymentFieldId, 'payment');
    assert.deepEqual(mounted.posts[0].fieldOverrides, { class: 'Overseas associate' });
    await mounted.close();
  }
});

test('explicit schedule answer is sent for all payment methods without a base schedule', async () => {
  for (const method of ['upfront', 'monthly_card', 'direct_debit']) {
    const mounted = await mountRenewal({
      ...renewalQuote(), renewal: { state: 'eligible_renewal', eligible: true, quoteKey: 'explicit-quote' },
    }, { error: 'Test stops before provider work' }, undefined, {
      formId: 'renew-form',
      field: { id: 'payment', membership_schedule_mapping: { source_field_id: 'answer',
        entries: [{ value: 'Overseas associate', config_id: 'overseas' }] } },
      allFormValues: { answer: 'Overseas associate' },
    });
    const quote = new URL(mounted.gets.find(url => url.includes('/api/forms/membership-payment')), 'https://test.invalid');
    assert.equal(quote.searchParams.get('renewalScheduleAnswer'), 'Overseas associate');
    assert.equal(quote.searchParams.has('configId'), false);
    await click(mounted.card(method));
    const testId = { upfront: 'button-pay-membership', monthly_card: 'button-monthly-card', direct_debit: 'button-direct-debit' }[method];
    await continueToPayment(mounted.host);
    await click(mounted.host.querySelector(`[data-testid="${testId}-payment"]`));
    assert.equal(mounted.posts.length, 1);
    assert.equal(mounted.posts[0].renewalScheduleAnswer, 'Overseas associate');
    assert.equal(mounted.posts[0].configId, undefined);
    await mounted.close();
  }
});

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
    await continueToPayment(host);
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
  const reads = mounted.gets.length;
  await click(card('direct_debit'));
  assert.equal(posts.length, 0, 'choosing a different card is local only');
  assert.equal(mounted.gets.length, reads, 'choosing a card does not check checkout status');
  assert.equal(card('direct_debit').getAttribute('aria-pressed'), 'true');
  await act(async () => {
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Continue to payment');
    button.click(); button.click();
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].credentials, 'include');
  assert.equal(posts[0].action, 'change_renewal_payment_method');
  assert.ok([...host.querySelectorAll('button')].every(button => button.disabled));
  assert.match(card('direct_debit').textContent, /Checking Pay monthly by Direct Debit/);
  assert.equal(card('direct_debit').getAttribute('aria-pressed'), 'true');
  await act(async () => { release({ released: true }); });
  assert.equal(card('direct_debit').getAttribute('aria-pressed'), 'true');
  assert.match(card('direct_debit').textContent, /15.00/);
  assert.match(host.querySelector('[role="alert"]').textContent, /safely cancelled.*Review the updated amount/);
  assert.equal(host.querySelector('[data-testid="button-direct-debit-payment"]'), null, 'release stays on choices for confirmation');
  await continueToPayment(host);
  assert.ok(host.querySelector('[data-testid="text-dd-first-collection-payment"]'));
  assert.ok(host.querySelector('[data-testid="button-direct-debit-payment"]'));
  assert.equal(posts.length, 1, 'replacement does not start until explicit continuation');
  await mounted.close();
});

test('refused or uncertain switching retains the local choice without starting payment and explains recovery', async () => {
  for (const response of [{ error: 'Payment must be reconciled. Check renewal status.' }, { released: false }]) {
    const mounted = await mountRenewal(renewalQuote('monthly_card'), response);
    await click(mounted.card('upfront'));
    assert.equal(mounted.posts.length, 0);
    await continueToPayment(mounted.host);
    assert.equal(mounted.card('upfront').getAttribute('aria-pressed'), 'true');
    assert.equal(mounted.posts.length, 1);
    assert.ok(mounted.host.querySelector('[role="alert"]'));
    await mounted.close();
  }
});

test('fresh eligibility removes unavailable method and never starts stale replacement', async () => {
  const fresh = { ...renewalQuote(), directDebit: null, renewal: { state: 'eligible_renewal', eligible: true } };
  const mounted = await mountRenewal(renewalQuote(), { released: true }, fresh);
  await click(mounted.card('direct_debit'));
  assert.equal(mounted.posts.length, 0);
  await continueToPayment(mounted.host);
  assert.equal(mounted.card('direct_debit'), undefined);
  assert.match(mounted.host.querySelector('[role="alert"]').textContent, /could not be confirmed/);
  assert.equal(mounted.posts.length, 1);
  await mounted.close();
});

test('missing quote invents no choices and reconciliation blocks payment while retaining alternatives', async () => {
  const missing = await mountRenewal({ renewal: renewalQuote().renewal });
  assert.equal(missing.host.querySelectorAll('button[aria-pressed]').length, 0);
  assert.match(missing.host.textContent, /previous checkout needs to be checked/);
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

test('upfront continuation hides choices and confirms using existing payment controls', async () => {
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
  await continueToPayment(mounted.host);
  await click(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'));
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
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
    await continueToPayment(mounted.host);
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
  assert.equal(mounted.posts.length, 0);
  await continueToPayment(mounted.host);
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
  assert.match(mounted.host.textContent, /already been paid/);
  assert.equal(mounted.posts.length, 1);
  await mounted.close();
});

const joiningQuote = () => ({ ...renewalQuote(), renewal: { state: 'joining', eligible: false } });
const setupButton = {
  upfront: 'button-pay-membership', monthly_card: 'button-monthly-card', direct_debit: 'button-direct-debit',
};

test('priced joining shares renewal cards and one Continue, then only the selected payment setup', async () => {
  for (const method of Object.keys(setupButton)) {
    const mounted = await mountRenewal(joiningQuote(), { error: 'Provider fixture refuses setup' });
    try {
      assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
      const next = [...mounted.host.querySelectorAll('button')].filter(button => button.textContent === 'Continue to payment');
      assert.equal(next.length, 1);
      assert.equal(next[0].disabled, true);
      for (const id of Object.values(setupButton)) {
        assert.equal(mounted.host.querySelector(`[data-testid="${id}-payment"]`), null);
      }
      await click(mounted.card(method));
      assert.equal(mounted.card(method).getAttribute('aria-pressed'), 'true');
      assert.equal(mounted.posts.length, 0);
      await continueToPayment(mounted.host);
      assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
      for (const [id, button] of Object.entries(setupButton)) {
        assert.equal(!!mounted.host.querySelector(`[data-testid="${button}-payment"]`), id === method);
      }
      await click(mounted.host.querySelector(`[data-testid="${setupButton[method]}-payment"]`));
      assert.equal(mounted.posts.length, 1);
      assert.equal(mounted.posts[0].credentials, 'include');
      assert.equal(mounted.posts[0].action, {
        upfront: 'create_payment', monthly_card: 'start_monthly_card', direct_debit: 'start_direct_debit',
      }[method]);
      assert.match(mounted.host.querySelector('[role="alert"]').textContent, /Provider fixture refuses setup/);
    } finally { await mounted.close(); }
  }
});

test('joining Back before setup refreshes choices without attempting a renewal cancellation', async () => {
  const mounted = await mountRenewal(joiningQuote());
  try {
    await click(mounted.card('monthly_card'));
    await continueToPayment(mounted.host);
    const reads = mounted.gets.length;
    await click([...mounted.host.querySelectorAll('button')].find(button => button.textContent === 'Back'));
    assert.ok(mounted.gets.length > reads);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
    assert.equal(mounted.card('monthly_card').getAttribute('aria-pressed'), 'true');
    assert.equal(mounted.posts.length, 0);
  } finally { await mounted.close(); }
});

test('joining cannot offer choices without pricing, during approval, or after monthly setup', async () => {
  for (const change of [
    { membershipYear: null }, { totalWithVat: null, finalCost: null },
    { totalWithVat: 'invalid' }, { approvalPending: true },
    { voucherSetup: { agreementId: 'existing-agreement', status: 'monthly_card_started' } },
  ]) {
    const mounted = await mountRenewal({ ...joiningQuote(), ...change });
    try {
      assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
      for (const id of Object.values(setupButton)) assert.equal(mounted.host.querySelector(`[data-testid="${id}-payment"]`), null);
      assert.equal(mounted.posts.length, 0);
    } finally { await mounted.close(); }
  }
});

test('joining Continue reviews changed quotes and refuses an existing agreement', async () => {
  for (const change of ['amount', 'agreement']) {
    const quote = joiningQuote();
    const mounted = await mountRenewal(quote);
    try {
      await click(mounted.card('direct_debit'));
      if (change === 'amount') quote.totalWithVat = 137.42;
      else quote.voucherSetup = { agreementId: 'already-started', status: 'direct_debit_started' };
      await continueToPayment(mounted.host);
      assert.match(mounted.host.querySelector('[role="alert"]').textContent,
        change === 'amount' ? /details have changed/ : /already been recorded/);
      assert.equal(mounted.host.querySelector('[data-testid="button-direct-debit-payment"]'), null);
      assert.equal(mounted.posts.length, 0);
    } finally { await mounted.close(); }
  }
});

test('joining Back never sends an outstanding Stripe checkout to renewal cancellation', async () => {
  window.Stripe = () => ({ elements: () => ({ create: () => ({ mount() {} }) }) });
  const mounted = await mountRenewal(joiningQuote(), { clientSecret: 'fixture', membershipYear: '2027' });
  try {
    await click(mounted.card('upfront'));
    await continueToPayment(mounted.host);
    await click(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'));
    await click([...mounted.host.querySelectorAll('button')].find(button => button.textContent === 'Back'));
    assert.match(mounted.host.querySelector('[role="alert"]').textContent, /already started.*Do not start another payment/);
    assert.ok(mounted.host.querySelector('[data-testid="button-confirm-payment-payment"]'));
    assert.deepEqual(mounted.posts.map(post => post.action), ['create_payment']);
  } finally { await mounted.close(); delete window.Stripe; }
});

test('joining reuses voucher estimates and one Continue, preserving checkout refusals', async () => {
  const { MembershipCheckoutDraftContext } = await import('./MembershipCheckoutDraftContext.jsx');
  const posts = [];
  let saves = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ error: 'Joining credit checkout is not available.' }), { status: 409 });
    }
    return new Response(JSON.stringify(url.includes('payment-plan') ? { currentPlan: null }
      : url.includes('action=vouchers') ? {
        enabled: true, checkoutReady: true, currency: 'GBP',
        vouchers: [{ id: 'credit', value: 17.31, code: 'CREDIT-17' }],
      } : { ...joiningQuote(), memberScoped: true }));
  };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<MembershipCheckoutDraftContext.Provider value={async () => { saves++; }}>
        <MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" formId="join" />
      </MembershipCheckoutDraftContext.Provider>);
    });
    await click(host.querySelector('input[type="checkbox"]'));
    await click([...host.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.includes('Pay in full by card')));
    assert.match(host.textContent, /£102\.69 after credit \(estimate\)/);
    assert.equal([...host.querySelectorAll('button')].filter(button => button.textContent === 'Continue to payment').length, 1);
    assert.equal(posts.length, 0);
    await continueToPayment(host);
    assert.equal(saves, 1);
    assert.deepEqual(posts, [{ formId: 'join', paymentFieldId: 'payment', memberId: 'member',
      action: 'start_voucher_checkout', paymentMethod: 'upfront', voucherIds: ['credit'] }]);
    assert.match(host.querySelector('[role="alert"]').textContent, /Joining credit checkout is not available/);
    assert.equal(host.querySelector('input[type="checkbox"]').checked, true);
    assert.equal(host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('joining voucher availability errors remain visible and do not invent selectable credit', async () => {
  const mounted = await mountRenewal({ ...joiningQuote(), memberScoped: true });
  const previousFetch = globalThis.fetch;
  // Remount the credit resource with a distinct saved form context.
  await mounted.close();
  globalThis.fetch = async (input, options) => String(input).includes('action=vouchers')
    ? new Response(JSON.stringify({ error: 'Credit eligibility must be checked by the membership team.' }), { status: 409 })
    : previousFetch(input, options);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" formId="join" />));
    assert.match(host.querySelector('[role="alert"]').textContent, /Credit eligibility must be checked/);
    assert.equal(host.querySelector('input[type="checkbox"]'), null);
    assert.equal(host.querySelectorAll('button[aria-pressed]').length, 3);
    assert.equal(mounted.posts.length, 0);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

const restartQuote = eligible => ({
  ...renewalQuote(),
  membershipYear: 'rolling:2027-02-04', scheduleName: 'Associate restart',
  renewal: {
    state: 'post_grace_renewal', eligible, commencementBasis: 'confirmed_payment', provisional: true,
    currentEnd: '2026-09-25', successorStart: '2027-02-04', successorEnd: '2028-02-03',
  },
});

test('post-grace restart uses provisional payment-based dates and retains all quoted methods and schedule', async () => {
  for (const method of ['upfront', 'monthly_card', 'direct_debit']) {
    const quote = restartQuote(true);
    quote.cardMonthly.firstChargeDate = '2027-02-04';
    const mounted = await mountRenewal(quote, { error: 'Fixture stops before payment provider' }, undefined, {
      formId: 'renew-form', field: { id: 'payment', membership_schedule_mapping: { source_field_id: 'schedule' } },
      allFormValues: { schedule: 'Associate' },
    });
    assert.match(mounted.host.textContent, /Restart your membership/);
    assert.match(mounted.host.textContent, /Previous membership ended: 25\/09\/2026/);
    assert.match(mounted.host.textContent, /Estimated membership dates: 04\/02\/2027 to 03\/02\/2028/);
    assert.match(mounted.host.textContent, /restarts on successful payment/);
    assert.match(mounted.host.textContent, /Associate restart/);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
    assert.doesNotMatch(mounted.host.textContent, /Your renewal covers|From 4 February|dates.*remain fixed/);
    await click(mounted.card(method));
    await continueToPayment(mounted.host);
    assert.doesNotMatch(mounted.host.textContent, /Nothing due now|current membership stays unchanged/);
    if (method === 'direct_debit') {
      assert.match(mounted.host.querySelector('[data-testid="text-dd-first-collection-payment"]').textContent, /only after successful payment/);
    }
    await click(mounted.host.querySelector(`[data-testid="${{
      upfront: 'button-pay-membership', monthly_card: 'button-monthly-card', direct_debit: 'button-direct-debit',
    }[method]}-payment"]`));
    assert.equal(mounted.posts.length, 1);
    assert.equal(mounted.posts[0].renewalScheduleAnswer, 'Associate');
    assert.equal(mounted.posts[0].credentials, 'include');
    await mounted.close();
  }
});

test('post-grace restart never offers payment without explicit server true eligibility', async () => {
  for (const eligible of [false, undefined, 'true']) {
    for (const withQuote of [true, false]) {
      const quote = restartQuote(eligible);
      if (!withQuote) delete quote.membershipYear;
      const mounted = await mountRenewal(quote);
      assert.match(mounted.host.textContent, /restart is not currently available/);
      assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
      assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
      assert.equal(mounted.host.querySelector('[data-testid="button-monthly-card-payment"]'), null);
      assert.equal(mounted.host.querySelector('[data-testid="button-direct-debit-payment"]'), null);
      assert.doesNotMatch(mounted.host.textContent, /Check renewal status/);
      assert.equal(mounted.posts.length, 0);
      await mounted.close();
    }
  }
});

test('post-grace Stripe checkout and completion never present provisional dates as fixed entitlement', async () => {
  window.Stripe = () => ({
    elements: () => ({ create: () => ({ mount() {} }), submit: async () => ({}) }),
    confirmPayment: async () => ({ paymentIntent: { id: 'pi_restart_fixture', status: 'succeeded' } }),
  });
  const mounted = await mountRenewal(restartQuote(true), request => request.action === 'create_payment'
    ? { clientSecret: 'fixture', membershipYear: 'rolling:2027-02-04', renewalElectionId: 'election',
        membershipStartDate: '2027-02-04', membershipRenewalDate: '2028-02-04' }
    : { success: true });
  try {
    await click(mounted.card('upfront'));
    await continueToPayment(mounted.host);
    await click(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'));
    assert.equal(mounted.host.querySelector('[data-testid="membership-agreed-term"]'), null);
    assert.match(mounted.host.textContent, /Estimated membership dates/);
    await click(mounted.host.querySelector('[data-testid="button-confirm-payment-payment"]'));
    assert.ok(mounted.host.querySelector('[data-testid="text-payment-success"]'));
    assert.equal(mounted.host.querySelector('[data-testid="text-membership-scheduled"]'), null);
    assert.doesNotMatch(mounted.host.textContent, /From 4 February|Membership starts on/);
  } finally {
    await mounted.close();
    delete window.Stripe;
  }
});

test('post-grace Direct Debit set-up does not claim activation before successful payment', async () => {
  const mounted = await mountRenewal(restartQuote(true), { agreementId: 'fixture-only' });
  await click(mounted.card('direct_debit'));
  await continueToPayment(mounted.host);
  await click(mounted.host.querySelector('[data-testid="button-direct-debit-payment"]'));
  const notice = mounted.host.querySelector('[data-testid="dd-started-payment"]');
  assert.match(notice.textContent, /pending payment confirmation/);
  assert.match(notice.textContent, /does not restart your membership/);
  assert.doesNotMatch(notice.textContent, /activated automatically|membership will be confirmed once they complete the set-up/);
  await mounted.close();
});

test('ordinary within-grace renewal retains fixed successor dates and existing renewal copy', async () => {
  const mounted = await mountRenewal({
    ...renewalQuote(),
    renewal: { state: 'eligible_renewal', eligible: true, currentEnd: '2026-09-25',
      successorStart: '2026-09-26', successorEnd: '2027-09-25' },
  });
  assert.match(mounted.host.textContent, /Renew your membership for the next term/);
  assert.match(mounted.host.textContent, /Your renewal covers: 26\/09\/2026 to 25\/09\/2027/);
  assert.match(mounted.host.textContent, /Current membership ends: 25\/09\/2026/);
  assert.doesNotMatch(mounted.host.textContent, /Restart your membership|provisional|Estimated membership/);
  assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
  await mounted.close();
});

test('Continue refreshes amount, terms and method availability on the choices stage before payment', async () => {
  for (const change of ['amount', 'dates', 'monthly terms', 'method']) {
    const quote = { ...renewalQuote(), renewal: { state: 'eligible_renewal', eligible: true,
      successorStart: '2027-01-01', successorEnd: '2027-12-31' } };
    const mounted = await mountRenewal(quote);
    try {
      await click(mounted.card('upfront'));
      assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
      const reads = mounted.gets.length;
      if (change === 'amount') quote.totalWithVat = 137.42;
      if (change === 'dates') quote.renewal.successorEnd = '2028-01-14';
      if (change === 'monthly terms') quote.directDebit = { ...quote.directDebit, instalmentCount: 11 };
      if (change === 'method') quote.stripeEnabled = false;
      await continueToPayment(mounted.host);
      assert.ok(mounted.gets.length > reads, 'Continue makes an authenticated fresh read');
      assert.match(mounted.host.querySelector('[role="alert"]').textContent, /details have changed/);
      assert.ok(mounted.host.querySelector('button[aria-pressed]'), 'choices stay visible for review');
      assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
      assert.equal(mounted.posts.length, 0, 'review cannot create or charge a payment');
      if (change === 'amount') assert.match(mounted.host.textContent, /137\.42/);
      if (change === 'dates') assert.match(mounted.host.textContent, /14\/01\/2028/);
      if (change === 'monthly terms') assert.equal(mounted.card('direct_debit').textContent, 'Pay monthly by Direct Debit£10.00/month');
      if (change === 'method') assert.equal(mounted.card('upfront'), undefined);
    } finally { await mounted.close(); }
  }
});

test('Continue finding an already paid renewal shows completion without creating another checkout', async () => {
  const quote = renewalQuote();
  const mounted = await mountRenewal(quote);
  try {
    quote.existingRecord = { id: 'settled', paymentStatus: 'paid', status: 'scheduled' };
    await continueToPayment(mounted.host);
    assert.ok(mounted.host.querySelector('[data-testid="text-payment-success"]'));
    assert.equal(mounted.posts.length, 0);
    assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
  } finally { await mounted.close(); }
});

test('Continue failure stays on choices and retry never starts payment automatically', async () => {
  const mounted = await mountRenewal(renewalQuote());
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Fixture offline'); };
    await continueToPayment(mounted.host);
    assert.match(mounted.host.querySelector('[role="alert"]').textContent, /No new payment has been started/);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
    globalThis.fetch = previousFetch;
    await continueToPayment(mounted.host);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
    assert.equal(mounted.posts.length, 0);
  } finally { globalThis.fetch = previousFetch; await mounted.close(); }
});

test('Back safely releases a reserved checkout, rejects double clicks, and returns to choices', async () => {
  let resolveRelease;
  const mounted = await mountRenewal(renewalQuote(), () => new Promise(resolve => { resolveRelease = resolve; }));
  try {
    await continueToPayment(mounted.host);
    const back = [...mounted.host.querySelectorAll('button')].find(button => button.textContent === 'Back');
    await act(async () => { back.click(); back.click(); });
    assert.equal(mounted.posts.length, 1);
    assert.equal(mounted.posts[0].action, 'change_renewal_payment_method');
    assert.equal(back.disabled, true);
    assert.ok(back.querySelector('svg'));
    await act(async () => resolveRelease({ released: true }));
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 3);
    assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
  } finally { await mounted.close(); }
});

test('Back refusal retains payment stage and shows the provider safety error', async () => {
  const mounted = await mountRenewal(renewalQuote(), { error: 'Your payment is being confirmed. Do not pay again.' });
  try {
    await continueToPayment(mounted.host);
    await click([...mounted.host.querySelectorAll('button')].find(button => button.textContent === 'Back'));
    assert.match(mounted.host.querySelector('[role="alert"]').textContent, /Do not pay again/);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
    assert.equal(mounted.posts.length, 1);
  } finally { await mounted.close(); }
});

test('bound voucher checkout suppresses outer unavailable warning and all outer payment actions', async () => {
  dom.reconfigure({ windowTop: {} });
  const quote = { ...renewalQuote(), memberScoped: true, voucherCheckoutToken: 'saved-checkout',
    stripeEnabled: false, cardMonthly: null, directDebit: null };
  const mounted = await mountRenewal(quote);
  try {
    assert.doesNotMatch(mounted.host.textContent, /Online payment is not currently available|Check renewal status/);
    assert.equal(mounted.host.querySelectorAll('button[aria-pressed]').length, 0);
    assert.equal(mounted.host.querySelector('[data-testid="button-pay-membership-payment"]'), null);
    assert.ok([...mounted.host.querySelectorAll('button')].find(button => button.textContent === 'Back'));
  } finally { await mounted.close(); dom.reconfigure({ windowTop: dom.window }); }
});

test('nested saved voucher checkout registers the real enabled Pay footer action despite disabled outer providers', async () => {
  const { MemoryRouter } = await import('react-router-dom');
  const { MembershipPrimaryActionContext } = await import('./MembershipPrimaryAction.jsx');
  const host = document.createElement('div');
  const back = document.createElement('span');
  const pay = document.createElement('span');
  document.body.append(host, back, pay);
  const root = createRoot(host);
  const registrations = new Set();
  globalThis.fetch = async (input, options = {}) => {
    assert.notEqual(options.method, 'POST', 'rendering controls must not start payment');
    const url = String(input);
    if (url.includes('payment-plan')) return new Response(JSON.stringify({ currentPlan: null }));
    if (url.includes('action=vouchers')) return new Response(JSON.stringify({ vouchers: [] }));
    if (url.startsWith('/api/public/membership-fees/')) return new Response(JSON.stringify({
      isMember: true, memberName: 'Renewal fixture', membershipYear: '2027', status: 'pending',
      finalCost: 137.42, totalWithVat: 137.42, currency: 'GBP', stripeEnabled: true,
      stripePublishableKey: 'pk_test_fixture', formVoucher: { paymentMode: 'stripe_upfront' },
    }));
    return new Response(JSON.stringify({ ...renewalQuote(), memberScoped: true,
      voucherCheckoutToken: 'saved-checkout', stripeEnabled: false, cardMonthly: null, directDebit: null }));
  };
  try {
    await act(async () => {
      root.render(<MemoryRouter><MembershipPrimaryActionContext.Provider value={{
        target: pay, backTarget: back, validate: async () => true,
        register: (id, active) => active ? registrations.add(id) : registrations.delete(id),
      }}>
        <MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" formId="renew" />
      </MembershipPrimaryActionContext.Provider></MemoryRouter>);
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    assert.equal(registrations.size, 1);
    assert.equal(pay.querySelectorAll('button').length, 1);
    assert.match(pay.textContent, /Pay £137\.42/);
    assert.equal(pay.querySelector('button').disabled, false);
    assert.equal(back.textContent, 'Back');
    assert.doesNotMatch(host.textContent, /Online payment is not currently available|Check renewal status/);
  } finally { await act(async () => root.unmount()); host.remove(); back.remove(); pay.remove(); }
});

test('pending checkout with vouchers honors the locally selected method and releases only at Continue', async () => {
  const { MembershipCheckoutDraftContext } = await import('./MembershipCheckoutDraftContext.jsx');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const posts = [];
  let reads = 0, released = false, saves = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push(body);
      if (body.action === 'change_renewal_payment_method') {
        released = true;
        return new Response(JSON.stringify({ released: true }));
      }
      return new Response(JSON.stringify({ error: 'Fixture stops before starting payment' }), { status: 409 });
    }
    reads++;
    if (url.includes('payment-plan')) return new Response(JSON.stringify({ currentPlan: null }));
    if (url.includes('action=vouchers')) return new Response(JSON.stringify({
      enabled: true, checkoutReady: true, currency: 'GBP', vouchers: [{ id: 'credit', value: 17.31, code: 'CREDIT-17' }],
    }));
    return new Response(JSON.stringify({ ...renewalQuote(), memberScoped: true,
      ...(released ? { renewal: { state: 'eligible_renewal', eligible: true, quoteKey: 'released-quote' } } : {}),
    }));
  };
  try {
    await act(async () => {
      root.render(<MembershipCheckoutDraftContext.Provider value={async () => { saves++; }}>
        <MembershipPaymentField field={{ id: 'payment' }} resolvedMemberId="member" formId="renew" />
      </MembershipCheckoutDraftContext.Provider>);
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    await click(host.querySelector('input[type="checkbox"]'));
    const beforeSelection = reads;
    const monthly = [...host.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.includes('Pay monthly by card'));
    await click(monthly);
    assert.equal(monthly.getAttribute('aria-pressed'), 'true', 'local choice overrides the saved pending method');
    assert.equal(posts.length, 0);
    assert.equal(reads, beforeSelection, 'voucher method cards do not check status');
    await continueToPayment(host);
    assert.deepEqual(posts.map(body => body.action), ['change_renewal_payment_method']);
    assert.equal(saves, 0, 'no new voucher checkout or draft preparation before renewed consent');
    assert.equal(host.querySelector('input[type="checkbox"]').checked, true);
    assert.match(host.querySelector('[role="alert"]').textContent, /safely cancelled.*Review the updated amount/);
    assert.equal(host.querySelectorAll('button[aria-pressed]').length, 3);
    await continueToPayment(host);
    assert.equal(posts[1].action, 'start_voucher_checkout');
    assert.equal(posts[1].paymentMethod, 'monthly_card');
    assert.deepEqual(posts[1].voucherIds, ['credit']);
    assert.equal(saves, 1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/choices' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const FormPaymentSubmit = (await import('./FormPaymentSubmit.jsx')).default;

const offer = { monthlyAmount: 10.66, instalmentCount: 12, planTotal: 127.92, currency: 'GBP' };
const membershipQuote = {
  matched: true,
  quote: { required: true, amount: 128, currency: 'GBP', membership: {
    config_name: 'Full member junior', membership_year: '2026/2027',
    monthly_card: offer, direct_debit_allowed: true, direct_debit: offer,
  } },
};

for (const end_policy of ['stop', 'continue']) {
  for (const pricing_policy of ['fixed', 'dynamic']) {
    test(`mounted payment choice summarizes ${end_policy}/${pricing_policy} before starting payment`, async () => {
      const fixture = await mount({
        membershipQuote: { ...membershipQuote, quote: { ...membershipQuote.quote,
          membership: { ...membershipQuote.quote.membership,
            direct_debit: { ...offer, collectionPolicy: { version: 1, end_policy, pricing_policy } },
          },
        } },
      });
      try {
        const choice = fixture.container.querySelector('[data-testid="button-form-payment-gocardless-choice"]');
        if (pricing_policy === 'dynamic') {
          assert.equal(choice.textContent, 'Pay monthly by Direct DebitCurrent monthly price £10.66');
          assert.doesNotMatch(choice.textContent, /variable|No fixed term total|First collection|Collections|127.92/);
          assert.equal(choice.lastElementChild.children.length, 2);
        } else {
          assert.match(choice.textContent, end_policy === 'stop' ? /Collections stop/ : /Collections continue/);
          assert.match(choice.textContent, /Plan total for this term £127.92/);
          assert.match(choice.textContent, /First collection: As soon as the mandate permits/);
        }
        assert.equal(fixture.calls.length, 0);
      } finally { await fixture.cleanup(); }
    });
  }
}

async function mount(overrides = {}, paymentResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(['form-payment-providers', 'membership'],
    [{ id: 'stripe', configured: true }, { id: 'gocardless', configured: true }]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  let validations = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (paymentResponse) return paymentResponse();
    return { ok: false, json: async () => ({ error: 'Fixture checkout unavailable' }) };
  };
  const render = props => root.render(
    <QueryClientProvider client={client}>
      <FormPaymentSubmit
        field={{ id: 'choice', payment_providers: ['stripe', 'gocardless'] }}
        membershipQuote={membershipQuote}
        buildPayload={async () => { validations++; return null; }}
        {...props}
      />
    </QueryClientProvider>,
  );
  await act(async () => render(overrides));
  return {
    container, calls, validations: () => validations,
    buttons: () => [...container.querySelectorAll('[data-testid^="button-form-payment-"]')],
    async render(props) { await act(async () => render({ ...overrides, ...props })); },
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test('variable price uses the offer currency and amount', async () => {
  const fixture = await mount({
    membershipQuote: { ...membershipQuote, quote: { ...membershipQuote.quote,
      membership: { ...membershipQuote.quote.membership, direct_debit: {
        ...offer, monthlyAmount: 27.45, currency: 'EUR',
        collection_policy: { end_policy: 'stop', pricing_policy: 'dynamic' },
      } },
    } },
  });
  try {
    assert.equal(fixture.buttons()[2].textContent, 'Pay monthly by Direct DebitCurrent monthly price €27.45');
  } finally { await fixture.cleanup(); }
});

test('initial choices are neutral action buttons with aligned quote text and no checkout', async () => {
  const fixture = await mount();
  try {
    const { container } = fixture;
    const choices = container.querySelector('[data-testid="form-payment-provider-choices-choice"]');
    assert.match(document.getElementById(choices.getAttribute('aria-labelledby')).textContent,
      /Select your desired payment method/);
    assert.match(choices.textContent, /Click an option below to start secure payment or set up your payment plan/);
    assert.match(container.textContent, /Amount due: £128.00/);
    assert.match(container.textContent, /Full member junior/);
    assert.equal(fixture.buttons().length, 3);
    const [monthly, full, dd] = fixture.buttons();
    assert.match(monthly.textContent, /Pay monthly by card.*£10.66 × 12 instalments.*Plan total £127.92/s);
    assert.match(full.textContent, /Pay in full by card.*£128.00/s);
    assert.match(dd.textContent, /Pay monthly by Direct Debit.*£10.66 × 12 instalments.*Plan total for this term £127.92.*First collection: As soon as the mandate permits/s);
    assert.equal(new Set(fixture.buttons().map(button => button.className)).size, 1);
    for (const button of fixture.buttons()) {
      assert.equal(button.type, 'button');
      assert.equal(button.hasAttribute('aria-pressed'), false);
      assert.equal(button.disabled, false);
      assert.match(button.className, /bg-background/);
      assert.doesNotMatch(button.className, /bg-primary/);
    }
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.validations(), 0);
    // Each provider still goes through the existing form validator.
    for (const button of fixture.buttons()) await act(async () => button.click());
    assert.equal(fixture.validations(), 3);
    assert.deepEqual(fixture.calls, []);
  } finally { await fixture.cleanup(); }
});

for (const state of [{ disabled: true, disabledMessage: 'Complete the required fields' }, { busy: true }]) {
  test(`disabled choices cannot validate or launch: ${Object.keys(state)[0]}`, async () => {
    const fixture = await mount(state);
    try {
      for (const button of fixture.buttons()) {
        assert.equal(button.disabled, true);
        assert.equal(button.querySelector('.animate-spin'), null);
        assert.equal(button.hasAttribute('aria-pressed'), false);
        await act(async () => button.click());
      }
      assert.equal(fixture.validations(), 0);
      assert.deepEqual(fixture.calls, []);
      if (state.disabledMessage) assert.match(fixture.container.textContent, /Complete the required fields/);
    } finally { await fixture.cleanup(); }
  });
}

test('quote pending/error stays blocked and zero due keeps ordinary submission explicit', async () => {
  const fixture = await mount({ membershipQuote: { matched: true, loading: true } });
  let submissions = 0;
  try {
    assert.match(fixture.container.textContent, /Calculating the amount due/);
    assert.equal(fixture.buttons().length, 0);
    await fixture.render({ membershipQuote: { matched: true, error: 'Quote unavailable' } });
    assert.match(fixture.container.textContent, /Quote unavailable/);
    assert.equal(fixture.buttons().length, 0);
    await fixture.render({
      membershipQuote: { matched: true, quote: { required: false } },
      onNormalSubmit: () => submissions++,
    });
    assert.equal(fixture.buttons().length, 0);
    assert.equal(submissions, 0);
    await act(async () => fixture.container.querySelector('[data-testid="button-submit-form"]').click());
    assert.equal(submissions, 1);
    assert.deepEqual(fixture.calls, []);
  } finally { await fixture.cleanup(); }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function assertChoiceState(fixture, pendingIndex, disabled = pendingIndex !== null) {
  fixture.buttons().forEach((button, index) => {
    assert.equal(button.disabled, disabled);
    assert.equal(!!button.querySelector('.animate-spin'), index === pendingIndex);
    if (index !== pendingIndex) {
      assert.ok(button.querySelector(index === 2 ? '.lucide-landmark' : '.lucide-credit-card'));
    }
  });
  assert.equal(!!fixture.container.querySelector('[role="status"]'), pendingIndex !== null);
}

const payload = { form_id: 'fixture-form', submission_data: { answers: {} } };
for (const [index, method] of ['monthly card', 'full card', 'Direct Debit'].entries()) {
  test(`${method} alone spins through validation and startup, prevents duplicates, and allows a different retry`, async () => {
    const validation = deferred();
    const response = deferred();
    let validations = 0;
    const fixture = await mount({
      membershipQuote: { ...membershipQuote, quote: { ...membershipQuote.quote,
        membership: { ...membershipQuote.quote.membership, direct_debit: {
          ...offer, collectionPolicy: { end_policy: 'continue', pricing_policy: 'dynamic' },
        } },
      } },
      buildPayload: () => { validations++; return validation.promise; },
    }, () => response.promise);
    try {
      await act(async () => {
        // Same-turn clicks exercise the ref guard before React commits disabled.
        fixture.buttons()[index].click();
        fixture.buttons().forEach(button => button.click());
      });
      assert.equal(validations, 1);
      assert.equal(fixture.calls.length, 0);
      assertChoiceState(fixture, index);
      await act(async () => validation.resolve(payload));
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0].body.action, index === 0 ? 'create_monthly_card' : 'create');
      if (index !== 0) assert.equal(fixture.calls[0].body.provider, index === 1 ? 'stripe' : 'gocardless');
      assertChoiceState(fixture, index);
      await act(async () => fixture.buttons().forEach(button => button.click()));
      assert.equal(validations, 1);
      assert.equal(fixture.calls.length, 1);
      await act(async () => response.resolve({ ok: false, json: async () => ({ error: 'Startup failed' }) }));
      assertChoiceState(fixture, null);
      assert.match(fixture.container.textContent, /Startup failed/);

      const retry = deferred();
      await fixture.render({ buildPayload: () => { validations++; return retry.promise; } });
      await act(async () => fixture.buttons()[(index + 1) % 3].click());
      assertChoiceState(fixture, (index + 1) % 3);
      assert.doesNotMatch(fixture.container.textContent, /Startup failed/);
      await act(async () => retry.resolve(payload));
      assert.equal(validations, 2);
      assert.equal(fixture.calls.length, 2);
      assertChoiceState(fixture, null);
    } finally { await fixture.cleanup(); }
  });

  for (const outcome of ['abort', 'throw']) {
    test(`${method} clears pending after validation ${outcome} and still respects form rules`, async () => {
      const validation = deferred();
      const fixture = await mount({ buildPayload: () => validation.promise });
      try {
        await act(async () => fixture.buttons()[index].click());
        assertChoiceState(fixture, index);
        await fixture.render({ disabled: true });
        await act(async () => outcome === 'abort'
          ? validation.resolve(null)
          : validation.reject(new Error('Validation failed')));
        assertChoiceState(fixture, null, true);
        assert.equal(fixture.calls.length, 0);
        if (outcome === 'throw') assert.match(fixture.container.textContent, /Validation failed/);
        await fixture.render({ disabled: false, buildPayload: async () => payload });
        await act(async () => fixture.buttons()[(index + 1) % 3].click());
        assert.equal(fixture.calls.length, 1);
        assertChoiceState(fixture, null);
      } finally { await fixture.cleanup(); }
    });
  }
}
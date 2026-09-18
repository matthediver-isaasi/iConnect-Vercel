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

async function mount(overrides = {}) {
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
    assert.match(dd.textContent, /Pay monthly by Direct Debit.*£10.66 × 12 instalments.*Plan total £127.92.*First collection: As soon as the mandate permits/s);
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
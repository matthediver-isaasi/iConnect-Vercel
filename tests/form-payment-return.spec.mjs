import { test, expect } from '@playwright/test';

// All data/provider endpoints are intercepted: these tests must never confirm
// the reported submission or create payment/member records on any backend.
async function fixtures(page, responses, {
  form: formOverrides = {},
  paymentProviders = null,
  allowPaymentCreate = false,
  createResponse = {
    submissionId: 'return-fixture-submission',
    publishableKey: 'pk_test_return_fixture',
    clientSecret: 'cs_test_return_fixture',
  },
} = {}) {
  const calls = [];
  const createCalls = [];
  const confirmCalls = [];
  const escapedWrites = [];
  const runtimeErrors = [];
  const form = {
    id: 'return-fixture-form', slug: 'return-fixture', name: 'Return fixture',
    fields: [], pages: [], visibility_rules: [], is_active: true,
    entity_pipelines: {}, require_authentication: false, form_type: 'application',
    ...formOverrides,
  };
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });
  await page.context().route(/\/(rest|auth)\/v1\//, route => json(route, []));
  // Inline Stripe is supplied by the init-script fixture below. Keep script
  // and provider traffic inert as a guard against an accidental live request.
  await page.context().route(/^https:\/\/(?:js|api|checkout)\.stripe\.com\//, route => (
    route.fulfill({ status: 204, body: '' })
  ));
  page.on('pageerror', error => runtimeErrors.push(error));
  await page.context().route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/public/form-payment-providers' && paymentProviders) {
      return json(route, { providers: paymentProviders });
    }
    if (path === '/api/public/form-payment') {
      const body = req.postDataJSON();
      calls.push(body);
      if (allowPaymentCreate && body.action === 'create') {
        createCalls.push(body);
        return json(route, createResponse);
      }
      if (body.action === 'confirm') confirmCalls.push(body);
      if (body.action !== 'confirm' || body.submission_id !== 'return-fixture-submission') {
        escapedWrites.push(body);
        return json(route, { error: 'Forbidden test mutation' }, 599);
      }
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      return json(route, response.body || response, response.httpStatus || 200);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      escapedWrites.push(path);
      return json(route, { error: 'Forbidden test mutation' }, 599);
    }
    if (path === '/api/public/form/return-fixture') return json(route, form);
    if (path === '/api/auth/me') return json(route, null, 401);
    if (path === '/api/auth/tenant-user-me') return json(route, { user: null }, 401);
    return json(route, []);
  });
  return { calls, createCalls, confirmCalls, escapedWrites, runtimeErrors };
}

test('/FormView: payment return scrolls a below-the-fold standalone status once', async ({ page }) => {
  test.setTimeout(90_000); // The first visit may compile the large form bundle.
  // Install layout space before React mounts so the effect measures the actual
  // return target, rather than the click or the test harness moving the page.
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '#root { padding-top: 1800px !important; }';
    const install = () => document.head?.appendChild(style);
    if (document.head) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  });
  const state = await fixtures(page, [
    { success: true, provider: 'stripe', status: 'paid', paymentSucceeded: true },
  ]);
  await page.goto('/FormView?slug=return-fixture&form_payment_submission=return-fixture-submission&form_payment_provider=stripe&payment_intent_client_secret=must-be-removed');
  await expect(page.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'paid');
  await page.waitForTimeout(80);
  const scrollY = await page.evaluate(() => {
    const target = document.querySelector('[data-testid="payment-return-scroll-target"]');
    const rect = target?.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      targetTop: rect?.top,
      targetBottom: rect?.bottom,
    };
  });
  expect(scrollY.scrollY).toBeGreaterThan(500);
  expect(state.escapedWrites).toEqual([]);
});

const inlineStripeForm = {
  id: 'return-fixture-form',
  slug: 'return-fixture',
  fields: [
    {
      id: 'inline-price',
      type: 'number',
      label: 'Amount',
      required: true,
    },
    {
      id: 'inline-payment',
      type: 'payment',
      label: 'Card payment',
      payment_providers: ['stripe'],
      price_field_id: 'inline-price',
      payment_currency: 'GBP',
    },
  ],
};

async function installInlineStripe(page) {
  await page.addInitScript(() => {
    window.__returnFixtureStripeConfirmCalls = 0;
    window.Stripe = () => ({
      elements: () => ({
        create: type => ({
          mount: element => {
            element.dataset.returnFixtureStripeElement = type;
          },
        }),
        submit: async () => ({}),
      }),
      confirmPayment: async () => {
        window.__returnFixtureStripeConfirmCalls += 1;
        return {
          paymentIntent: {
            id: 'pi_return_fixture_inline',
            status: 'succeeded',
          },
        };
      },
    });
  });
}

const inlineFinalizingReceipt = {
  success: false,
  paymentSucceeded: true,
  provider: 'stripe',
  status: 'finalizing',
  pending: true,
  retryable: true,
  reconciled: false,
};

test('/FormView: inline Stripe finalizing receipt is acknowledged once and survives refresh', async ({ page }, testInfo) => {
  await installInlineStripe(page);
  const state = await fixtures(page, [inlineFinalizingReceipt], {
    form: inlineStripeForm,
    paymentProviders: [{ id: 'stripe', configured: true }],
    allowPaymentCreate: true,
  });

  await page.goto('/FormView?slug=return-fixture');
  await page.locator('input[inputmode="numeric"]').fill('10');
  await page.getByTestId('button-form-payment-stripe-inline-payment').click();
  await expect(page.getByTestId('form-payment-stripe-element-inline-payment')).toBeVisible();
  await page.getByTestId('button-form-payment-confirm-inline-payment').click();

  const screen = page.getByTestId('payment-return-screen');
  await expect(screen).toHaveAttribute('data-payment-status', 'finalizing');
  await expect(page.getByTestId('payment-return-title')).toHaveText(
    'Payment received — application submitted',
  );
  await expect(page.getByTestId('payment-return-body')).toHaveText(
    'Thank you. Your payment has been received and your application has been submitted. We’ll email you with the next steps and login instructions when your membership is ready. You can now leave this page.',
  );
  await expect(page.getByTestId('button-payment-return-continue')).toHaveAttribute('href', '/');
  expect(state.createCalls).toHaveLength(1);
  expect(state.confirmCalls).toHaveLength(1);
  expect(await page.evaluate(() => window.__returnFixtureStripeConfirmCalls)).toBe(1);
  expect(state.escapedWrites).toEqual([]);
  expect(state.runtimeErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath('inline-stripe-acknowledgement.png'),
    fullPage: true,
  });

  await page.reload();
  await expect(page.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'finalizing');
  await expect(page.getByTestId('payment-return-title')).toHaveText(
    'Payment received — application submitted',
  );
  await expect(page.getByTestId('button-form-payment-confirm-inline-payment')).toHaveCount(0);
  await expect(page.getByTestId('button-form-payment-stripe-inline-payment')).toHaveCount(0);
  expect(state.createCalls).toHaveLength(1);
  expect(state.confirmCalls).toHaveLength(1);
  expect(state.runtimeErrors).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test('same-origin embedded EmbedForm acknowledges inline Stripe finalization, refreshes idempotently, and navigates onward', async ({ page }, testInfo) => {
  await installInlineStripe(page);
  const state = await fixtures(page, [inlineFinalizingReceipt], {
    form: inlineStripeForm,
    paymentProviders: [{ id: 'stripe', configured: true }],
    allowPaymentCreate: true,
  });
  const appOrigin = new URL(testInfo.project.use.baseURL).origin;

  await page.goto('/');
  await page.setContent(`
    <main><iframe
      data-testid="same-origin-inline-stripe-frame"
      src="${appOrigin}/embed/form/return-fixture?payment_embed_continue=%2Fmembership"
      title="Inline Stripe application"
    ></iframe></main>
  `);

  const frame = page.frameLocator('[data-testid="same-origin-inline-stripe-frame"]');
  await frame.locator('input[inputmode="numeric"]').fill('10');
  await frame.getByTestId('button-form-payment-stripe-inline-payment').click();
  await expect(frame.getByTestId('form-payment-stripe-element-inline-payment')).toBeVisible();
  await frame.getByTestId('button-form-payment-confirm-inline-payment').click();

  await expect(frame.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'finalizing');
  await expect(frame.getByTestId('payment-return-title')).toHaveText(
    'Payment received — application submitted',
  );
  const onward = frame.getByTestId('button-payment-return-continue');
  await expect(onward).toHaveCount(1);
  await expect(onward).toHaveJSProperty('tagName', 'BUTTON');
  expect(state.createCalls).toHaveLength(1);
  expect(state.confirmCalls).toHaveLength(1);
  expect(state.escapedWrites).toEqual([]);
  expect(state.runtimeErrors).toEqual([]);

  // Refresh only the embedded document. Reloading the host after setContent
  // would discard the intercepted iframe wrapper and turn this into a
  // standalone navigation test.
  const iframe = page.locator('[data-testid="same-origin-inline-stripe-frame"]');
  const frameNavigation = page.waitForEvent('framenavigated', {
    predicate: candidate => candidate.url().includes('/embed/form/return-fixture'),
  });
  await iframe.evaluate(element => element.contentWindow.location.reload());
  await frameNavigation;
  await expect(frame.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'finalizing');
  await expect(frame.getByTestId('payment-return-title')).toHaveText(
    'Payment received — application submitted',
  );
  await expect(frame.getByTestId('button-form-payment-confirm-inline-payment')).toHaveCount(0);
  await expect(frame.getByTestId('button-form-payment-stripe-inline-payment')).toHaveCount(0);
  expect(state.createCalls).toHaveLength(1);
  expect(state.confirmCalls).toHaveLength(1);
  expect(state.runtimeErrors).toEqual([]);

  await frame.getByTestId('button-payment-return-continue').click();
  await expect.poll(() => page.url()).toContain('/membership');
});

for (const surface of ['/FormView?slug=return-fixture', '/embed/form/return-fixture']) {
  const openReturn = async page => {
    const join = surface.includes('?') ? '&' : '?';
    await page.goto(`${surface}${join}form_payment_submission=return-fixture-submission&form_payment_provider=stripe&payment_intent_client_secret=must-be-removed`);
  };

  test(`${surface}: Stripe pending survives refresh, cleans secrets and safely rechecks`, async ({ page }) => {
    const state = await fixtures(page, [
      { success: false, provider: 'stripe', pending: true, status: 'pending', retryable: false },
      { success: false, provider: 'stripe', pending: true, status: 'finalizing', retryable: false },
      { success: true, provider: 'stripe', status: 'paid', paymentSucceeded: true },
    ]);
    await openReturn(page);
    const screen = page.getByTestId('payment-return-screen');
    await expect(screen).toHaveAttribute('data-payment-status', 'pending');
    await expect(screen).not.toContainText('Direct Debit');
    expect(page.url()).not.toContain('form_payment_');
    expect(page.url()).not.toContain('client_secret');
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain('must-be-removed');
    await page.reload();
    await expect(screen).toHaveAttribute('data-payment-status', 'finalizing');
    await page.getByTestId('button-payment-return-recheck').click();
    await expect(screen).toHaveAttribute('data-payment-status', 'paid');
    expect(state.calls.every(c => c.action === 'confirm')).toBe(true);
    expect(state.escapedWrites).toEqual([]);
  });

  test(`${surface}: verified Stripe receipt is accepted without polling across finalization states`, async ({ page }) => {
    for (const [status, httpStatus] of [
      ['finalizing', 503],
      ['accounting_pending', 503],
      ['attention', 200],
    ]) {
      const state = await fixtures(page, [{
        httpStatus,
        body: {
          provider: 'stripe',
          status,
          paymentSucceeded: true,
          retryable: true,
          error: 'Internal completion detail must not replace the receipt.',
        },
      }]);
      const join = surface.includes('?') ? '&' : '?';
      await page.goto(
        `${surface}${join}payment_case=${status}&form_payment_submission=return-fixture-submission&form_payment_provider=gocardless`,
      );
      const screen = page.getByTestId('payment-return-screen');
      await expect(screen).toHaveAttribute('data-payment-status', status);
      await expect(page.getByTestId('payment-return-title')).toHaveText(
        'Payment received — application submitted',
      );
      await expect(page.getByTestId('payment-return-body')).toHaveText(
        'Thank you. Your payment has been received and your application has been submitted. We’ll email you with the next steps and login instructions when your membership is ready. You can now leave this page.',
      );
      await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
      expect(state.calls).toHaveLength(1);
      await page.reload();
      await expect(page.getByTestId('payment-return-title')).toHaveText(
        'Payment received — application submitted',
      );
      await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
      expect(state.calls).toHaveLength(1);
    }
  });

  test(`${surface}: setup without collection never claims payment or submission completion`, async ({ page }) => {
    const state = await fixtures(page, [{ success: true, provider: 'stripe', status: 'setup_complete', paymentSucceeded: false }]);
    await openReturn(page);
    const screen = page.getByTestId('payment-return-screen');
    await expect(screen).toHaveAttribute('data-payment-status', 'setup_complete');
    await expect(page.getByTestId('payment-return-title')).toHaveText('Payment setup complete');
    await expect(screen).not.toContainText('Payment received');
    await expect(screen).not.toContainText('submission is complete');
    await expect(page.getByTestId('button-return-to-form')).toHaveCount(0);
    expect(state.escapedWrites).toEqual([]);
  });

  test(`${surface}: blocked and accounting failures expose safe rechecking, not checkout`, async ({ page }) => {
    const state = await fixtures(page, [
      { httpStatus: 409, body: { success: false, provider: 'stripe', status: 'blocked', retryable: false, error: 'Membership needs administrator attention.' } },
      { success: false, provider: 'stripe', status: 'accounting_pending', paymentSucceeded: false, retryable: false, error: 'Accounting status is not yet clear.' },
    ]);
    await openReturn(page);
    const screen = page.getByTestId('payment-return-screen');
    await expect(screen).toHaveAttribute('data-payment-status', 'blocked');
    await expect(screen).toContainText('Membership needs administrator attention.');
    await expect(page.getByTestId('button-return-to-form')).toHaveCount(0);
    await page.getByTestId('button-payment-return-recheck').click();
    await expect(screen).toHaveAttribute('data-payment-status', 'accounting_pending');
    await expect(screen).toContainText('Accounting status is not yet clear.');
    await expect(screen).not.toContainText('Direct Debit');
    expect(state.escapedWrites).toEqual([]);
  });
}

test('monthly setup uses the server paymentProvider when the return hint is absent or wrong', async ({ page }) => {
  for (const hint of ['', '&form_payment_provider=gocardless']) {
    const state = await fixtures(page, [{
      success: true,
      provider: 'stripe',
      paymentProvider: 'stripe_monthly_card',
      setupVerified: true,
      status: 'finalizing',
      paymentSucceeded: false,
      retryable: true,
    }]);
    await page.goto(
      `/FormView?slug=return-fixture&receipt_case=${hint ? 'wrong-hint' : 'no-hint'}&form_payment_submission=return-fixture-submission${hint}`,
    );
    await expect(page.getByTestId('payment-return-title')).toHaveText(
      'Application submitted — monthly payments set up',
    );
    await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].acknowledge_setup).toBe(true);
  }
});

for (const surface of ['/FormView?slug=return-fixture', '/embed/form/return-fixture']) {
  test(`${surface}: completed Direct Debit shows application submission confirmation`, async ({ page }) => {
    const state = await fixtures(page, [{
      success: true,
      provider: 'gocardless',
      status: 'setup_complete',
      paymentSucceeded: true,
      retryable: false,
    }]);
    const join = surface.includes('?') ? '&' : '?';
    await page.goto(
      `${surface}${join}form_payment_submission=return-fixture-submission&form_payment_provider=gocardless`,
    );

    const screen = page.getByTestId('payment-return-screen');
    await expect(screen).toHaveAttribute('data-payment-status', 'setup_complete');
    await expect(screen).toHaveAttribute('data-payment-provider', 'gocardless');
    await expect(page.getByTestId('payment-return-title')).toHaveText('Application submitted');
    await expect(page.getByTestId('payment-return-body')).toHaveText(
      'Your application has been submitted and your Direct Debit is set up. Your first payment will be collected separately. You can now leave this page.',
    );
    // setup_complete is terminal for the form submission but deliberately not
    // a paid one: applicants must not be sent back to a payment control or
    // offered a misleading status recheck.
    await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
    await expect(page.getByTestId('button-return-to-form')).toHaveCount(0);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].action).toBe('confirm');
    expect(state.escapedWrites).toEqual([]);
  });
}

test('/embed/form: completed Direct Debit survives refresh and keeps the embedded destination', async ({ page }) => {
  const state = await fixtures(page, [{
    success: true,
    provider: 'gocardless',
    status: 'setup_complete',
    paymentSucceeded: true,
    retryable: false,
  }]);
  await page.goto(
    '/embed/form/return-fixture?payment_embed_continue=%2Fmembership&form_payment_submission=return-fixture-submission&form_payment_provider=gocardless',
  );

  const screen = page.getByTestId('payment-return-screen');
  await expect(screen).toHaveAttribute('data-payment-status', 'setup_complete');
  await expect(page.getByTestId('payment-return-title')).toHaveText('Application submitted');
  await expect(page.getByTestId('button-payment-return-continue')).toHaveAttribute('href', '/membership');
  await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
  expect(state.calls).toHaveLength(1);

  await page.reload();
  await expect(screen).toHaveAttribute('data-payment-status', 'setup_complete');
  await expect(page.getByTestId('payment-return-title')).toHaveText('Application submitted');
  await expect(page.getByTestId('payment-return-body')).toHaveText(
    'Your application has been submitted and your Direct Debit is set up. Your first payment will be collected separately. You can now leave this page.',
  );
  await expect(page.getByTestId('button-payment-return-continue')).toHaveAttribute('href', '/membership');
  await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
  expect(state.calls).toHaveLength(2);
  expect(state.calls.every(call => call.action === 'confirm')).toBe(true);
  expect(state.escapedWrites).toEqual([]);
});

test('same-origin embedded Direct Debit completion keeps onward navigation in the containing page', async ({ page }, testInfo) => {
  const state = await fixtures(page, [{
    success: true,
    provider: 'gocardless',
    status: 'setup_complete',
    paymentSucceeded: true,
    retryable: false,
  }]);
  const appOrigin = new URL(testInfo.project.use.baseURL).origin;
  await page.goto('/');
  await page.setContent(`
    <main><iframe
      data-testid="same-origin-dd-frame"
      src="${appOrigin}/embed/form/return-fixture?payment_embed_continue=%2Fmembership&form_payment_submission=return-fixture-submission&form_payment_provider=gocardless"
      title="Direct Debit application"
    ></iframe></main>
  `);

  const frame = page.frameLocator('[data-testid="same-origin-dd-frame"]');
  await expect(frame.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'setup_complete');
  await expect(frame.getByTestId('payment-return-title')).toHaveText('Application submitted');
  const onward = frame.getByTestId('button-payment-return-continue');
  await expect(onward).toHaveCount(1);
  await expect(onward).toHaveJSProperty('tagName', 'BUTTON');
  await expect(onward).not.toHaveAttribute('target', '_blank');
  expect(state.calls).toHaveLength(1);
  expect(state.escapedWrites).toEqual([]);
});

test('Stripe finalization crosses the one-minute worker interval, then stops after paid', async ({ page }) => {
  const accounting = {
    success: false,
    provider: 'stripe',
    status: 'accounting_pending',
    paymentSucceeded: false,
    retryable: true,
  };
  const state = await fixtures(page, [
    accounting, accounting, accounting, accounting, accounting, accounting, accounting, accounting,
    { success: true, provider: 'stripe', status: 'paid', paymentSucceeded: true },
  ]);
  // The browser clock keeps this intercepted test deterministic without
  // waiting five minutes in real time. No provider or checkout request is
  // made: fixtures only accept the shared confirm endpoint.
  await page.clock.install();
  await page.goto('/FormView?slug=return-fixture&form_payment_submission=return-fixture-submission&form_payment_provider=stripe&payment_intent_client_secret=must-be-removed');
  const screen = page.getByTestId('payment-return-screen');
  await expect(screen).toHaveAttribute('data-payment-status', 'accounting_pending');

  // Advance one scheduled check at a time: fastForward fires each timer
  // only once, and the next timer is created after its HTTP response.
  for (const [index, delay] of [1500, 3000, 5000, 7500, 10000, 15000, 15000].entries()) {
    await page.clock.fastForward(delay);
    await expect.poll(() => state.calls.length).toBe(index + 2);
    await expect(page.getByTestId('button-payment-return-recheck')).toBeEnabled();
    await page.waitForTimeout(50);
  }
  await page.clock.fastForward(4_000);
  await expect(screen).toHaveAttribute('data-payment-status', 'accounting_pending');
  await page.clock.fastForward(11_000);
  await expect(screen).toHaveAttribute('data-payment-status', 'paid');
  const settledCalls = state.calls.length;
  expect(settledCalls).toBeGreaterThan(8);
  expect(state.escapedWrites).toEqual([]);
  expect(state.calls.every(call => call.action === 'confirm')).toBe(true);

  // A terminal paid receipt cancels the remaining timer and never starts a
  // checkout or another confirm after the status has settled.
  await page.clock.fastForward(300_000);
  expect(state.calls).toHaveLength(settledCalls);
  expect(state.escapedWrites).toEqual([]);
});

test('cross-origin embedded Direct Debit completion opens onward navigation separately without navigating the host', async ({ page }, testInfo) => {
  const state = await fixtures(page, [{
    success: true,
    provider: 'gocardless',
    status: 'setup_complete',
    paymentSucceeded: true,
    retryable: false,
  }]);
  const appOrigin = new URL(testInfo.project.use.baseURL).origin;
  await page.context().route('https://external.example.invalid/membership', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><title>External fixture host</title>
      <header>External fixture header</header>
      <main><iframe
        data-testid="cross-origin-dd-frame"
        src="${appOrigin}/embed/form/return-fixture?payment_embed_continue=%2Fmembership&form_payment_submission=return-fixture-submission&form_payment_provider=gocardless"
        title="Direct Debit application"
      ></iframe></main>
      <footer>External fixture footer</footer>`,
  }));
  await page.goto('https://external.example.invalid/membership');

  const frame = page.frameLocator('[data-testid="cross-origin-dd-frame"]');
  await expect(frame.getByTestId('payment-return-screen')).toHaveAttribute('data-payment-status', 'setup_complete');
  await expect(frame.getByTestId('payment-return-title')).toHaveText('Application submitted');
  const onward = frame.getByTestId('button-payment-return-continue');
  await expect(onward).toHaveAttribute('href', '/membership');
  await expect(onward).toHaveAttribute('target', '_blank');
  await expect(onward).toHaveAttribute('rel', 'noopener noreferrer');
  expect(page.url()).toBe('https://external.example.invalid/membership');
  expect(state.calls).toHaveLength(1);
  expect(state.escapedWrites).toEqual([]);
});

for (const surface of ['/FormView?slug=return-fixture', '/embed/form/return-fixture']) {
  test(`${surface}: verified monthly setup uses dedicated receipt copy without polling`, async ({ page }) => {
    await page.clock.install();
    for (const [paymentProvider, provider, paymentSucceeded, collectionCopy] of [
      ['stripe_monthly_card', 'stripe', false, 'monthly payments are set up'],
      ['stripe_monthly_card', 'stripe', true, 'first payment has been received'],
      ['gocardless_monthly_dd', 'gocardless', false, 'first payment will be collected separately'],
    ]) {
      const state = await fixtures(page, [{
        success: true,
        provider,
        paymentProvider,
        setupVerified: true,
        status: 'setup_complete',
        paymentSucceeded,
        retryable: true,
      }]);
      const join = surface.includes('?') ? '&' : '?';
      await page.goto(
        `${surface}${join}receipt_case=${paymentProvider}-${paymentSucceeded}&form_payment_submission=return-fixture-submission&form_payment_provider=${paymentProvider}`,
      );
      const screen = page.getByTestId('payment-return-screen');
      await expect(screen).toHaveAttribute('data-payment-status', 'setup_complete');
      await expect(page.getByTestId('payment-return-title')).toHaveText(
        'Application submitted — monthly payments set up',
      );
      await expect(page.getByTestId('payment-return-body')).toContainText(collectionCopy);
      await expect(page.getByTestId('button-payment-return-recheck')).toHaveCount(0);
      await expect(page.getByTestId('button-payment-return-continue')).toBeVisible();
      await page.clock.fastForward(300_000);
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].acknowledge_setup).toBe(true);
      await page.reload();
      await expect(page.getByTestId('payment-return-title')).toHaveText(
        'Application submitted — monthly payments set up',
      );
      await expect(page.getByTestId('payment-return-body')).toContainText(collectionCopy);
      expect(state.calls).toHaveLength(1);
      if (surface.startsWith('/embed') && paymentProvider === 'gocardless_monthly_dd') {
        await page.screenshot({ path: '/tmp/monthly-dd-acknowledgement.png' });
      }
    }
  });
}

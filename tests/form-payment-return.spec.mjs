import { test, expect } from '@playwright/test';

// All data/provider endpoints are intercepted: these tests must never confirm
// the reported submission or create payment/member records on any backend.
async function fixtures(page, responses) {
  const calls = [];
  const escapedWrites = [];
  const form = {
    id: 'return-fixture-form', slug: 'return-fixture', name: 'Return fixture',
    fields: [], pages: [], visibility_rules: [], is_active: true,
    entity_pipelines: {}, require_authentication: false, form_type: 'application',
  };
  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });
  await page.context().route(/\/(rest|auth)\/v1\//, route => json(route, []));
  await page.context().route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/public/form-payment') {
      const body = req.postDataJSON();
      calls.push(body);
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
  return { calls, escapedWrites };
}

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
      { success: false, provider: 'stripe', status: 'accounting_pending', paymentSucceeded: true, retryable: false, error: 'Invoice posting will be retried.' },
    ]);
    await openReturn(page);
    const screen = page.getByTestId('payment-return-screen');
    await expect(screen).toHaveAttribute('data-payment-status', 'blocked');
    await expect(screen).toContainText('Membership needs administrator attention.');
    await expect(page.getByTestId('button-return-to-form')).toHaveCount(0);
    await page.getByTestId('button-payment-return-recheck').click();
    await expect(screen).toHaveAttribute('data-payment-status', 'accounting_pending');
    await expect(screen).toContainText('Invoice posting will be retried.');
    await expect(screen).not.toContainText('Direct Debit');
    expect(state.escapedWrites).toEqual([]);
  });
}
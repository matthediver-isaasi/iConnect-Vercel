import { test, expect } from '@playwright/test';

for (const width of [390, 1280]) {
for (const count of [12, null]) {
test(`credit summary and monthly choices agree at ${width}px with count ${count}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors = [], writes = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = await (await page.request.get('/src/components/forms/MembershipPaymentField.jsx')).text();
  const reactPath = source.match(/from "([^"]+\/react\.js[^"]*)"/)?.[1];
  expect(reactPath).toBeTruthy();
  const clientPath = reactPath.replace(/react\.js/, 'react-dom_client.js');
  const origin = new URL(baseURL).origin;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        writes.push(request.postData());
        return route.fulfill({ status: 409, json: { error: 'Fixture forbids payment and reservation writes' } });
      }
      if (url.pathname === '/api/membership/payment-plan') return route.fulfill({ json: { currentPlan: null } });
      if (url.pathname !== '/api/forms/membership-payment') {
        unexpected.push(url.pathname);
        return route.fulfill({ status: 403, json: {} });
      }
      return route.fulfill({ json: url.searchParams.get('action') === 'vouchers'
        ? { currency: 'GBP', checkoutReady: true, vouchers: [
          { id: 'one', code: 'ONE', value: 20 }, { id: 'two', code: 'TWO', value: 12.79 },
          { id: 'excess', code: 'EXCESS', value: 100 },
        ] }
        : { membershipYear: '2027', memberScoped: true, stripeEnabled: true, currency: 'GBP',
          finalCost: 40, vatRatePercent: 17.5, vatAmount: 7, totalWithVat: 47,
          costBreakdown: { annualCost: 40, annualCostBeforeDiscounts: 50, customDiscountTotal: 10 },
          cardMonthly: { monthlyAmount: 3.92, planTotal: 47.04, instalmentCount: count },
          directDebit: { monthlyAmount: 3.92, planTotal: 47.04, instalmentCount: count,
            collectionPolicy: { end_policy: 'continue', pricing_policy: 'dynamic' } },
          renewal: { state: 'eligible_renewal', eligible: true } } });
    }
    if (url.pathname === '/__renewal-credit-test') return route.fulfill({
      contentType: 'text/html',
      body: `<html><head></head><body><main id="root"></main><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const {default: React} = await import(${JSON.stringify(reactPath)});
        const {default: ReactDOM} = await import(${JSON.stringify(clientPath)});
        await import('/src/index.css');
        const {default: Field} = await import('/src/components/forms/MembershipPaymentField.jsx');
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Field, {field:{id:'payment'},resolvedMemberId:'fixture'}));
      </script></body></html>`,
    });
    return route.continue();
  });
  await page.goto('/__renewal-credit-test');
  const boxes = page.getByRole('checkbox');
  const total = page.getByTestId('text-total-amount');
  const upfront = page.getByRole('button', { name: /Pay in full by card/ });
  const monthly = page.getByRole('button', { name: /Pay monthly by card/ });
  const dd = page.getByRole('button', { name: /Pay monthly by Direct Debit/ });
  // Cold Vite transforms include the embedded credit-checkout dependency tree.
  await expect(total).toHaveText('£47.00', { timeout: 15_000 });
  await expect(monthly).toContainText('£47.04 in total');
  await boxes.nth(0).check();
  await expect(total).toHaveText('£27.00');
  await boxes.nth(1).check();
  await expect(page.getByTestId('text-total-before-credit')).toHaveText('£47.00');
  await expect(page.getByTestId('selected-credit-deduction')).toHaveText('Selected voucher credit (estimate)−£32.79');
  await expect(total).toHaveText('£14.21');
  await expect(total.locator('..')).toHaveText('Remaining to pay (estimate)£14.21');
  await expect(upfront).toContainText('£14.21 after credit (estimate)');
  await expect(monthly).toContainText('Payments are estimated after credit and may vary for rounding');
  await expect(monthly).not.toContainText('in total');
  await expect(monthly).not.toContainText('47.04');
  await expect(monthly).toContainText(count ? '12 monthly payments' : 'Monthly payments');
  const monthlyPrice = count ? '£1.18 first month after credit (estimate)' : 'Credit estimate unavailable';
  await expect(monthly).toContainText(monthlyPrice);
  await expect(dd).toHaveText('Pay monthly by Direct Debit' + monthlyPrice);
  await dd.click();
  await expect(dd).toHaveAttribute('aria-pressed', 'true');
  await monthly.click();
  await expect(total).toHaveText('£14.21');
  await expect(page.getByText('VAT (17.5%)', { exact: true }).locator('..')).toHaveText('VAT (17.5%)£7.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `generated-artifacts/renewal-credit-${width}-${count}.png`, fullPage: true });
  await boxes.nth(2).check();
  await expect(total).toHaveText('£0.00');
  await expect(page.getByTestId('selected-credit-deduction')).toContainText('−£47.00');
  await expect(page.getByRole('status').filter({ hasText: 'Any credit above' })).toContainText('remains unused');
  await boxes.nth(0).uncheck();
  await boxes.nth(1).uncheck();
  await boxes.nth(2).uncheck();
  await expect(total).toHaveText('£47.00');
  await expect(page.getByTestId('selected-credit-deduction')).toHaveCount(0);
  await expect(monthly).toContainText('£47.04 in total');
  await expect(dd).toHaveText('Pay monthly by Direct Debit£3.92/month');
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
}
}

for (const width of [390, 1280]) {
for (const pricing_policy of ['fixed', 'dynamic']) {
test(`concise ${pricing_policy} renewal choices at ${width}px support safe continuation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const source = await (await page.request.get('/src/components/forms/MembershipPaymentField.jsx')).text();
  const reactPath = source.match(/from "([^"]+\/react\.js[^"]*)"/)?.[1];
  expect(reactPath).toBeTruthy();
  const clientPath = reactPath.replace(/react\.js/, 'react-dom_client.js');
  const posts = [];
  let selected = true;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      posts.push(request.postDataJSON());
      selected = false;
      return route.fulfill({ json: { released: true } });
    }
    return route.fulfill({ json: request.url().includes('payment-plan') ? { currentPlan: null } : {
      membershipYear: '2027', finalCost: 120, totalWithVat: 120, currency: 'GBP',
      stripeEnabled: true, stripePublishableKey: 'fixture',
      cardMonthly: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120 },
      directDebit: { monthlyAmount: 3.92, instalmentCount: 12, planTotal: 47, scope: 'member',
        firstCollectionRule: 'nominated_day', collectionDay: 21,
        collectionPolicy: { end_policy: 'continue', pricing_policy } },
      renewal: selected
        ? { state: 'renewal_pending', selectedMethod: 'monthly_card', electionId: 'fixture', switchState: 'idle' }
        : { state: 'eligible_renewal', eligible: true, quoteKey: 'fresh' },
    } });
  });
  // Test-only intercepted document mounts the actual component, not a shipped auth bypass.
  await page.route('**/__renewal-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><head></head><body><main id="root"></main>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const {default: React} = await import(${JSON.stringify(reactPath)});
        const {default: ReactDOM} = await import(${JSON.stringify(clientPath)});
        await import('/src/index.css');
        const {default: Field} = await import('/src/components/forms/MembershipPaymentField.jsx');
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Field, {field:{id:'payment'},resolvedMemberId:'fixture'}));
      </script></body></html>`,
  }));
  await page.goto('/__renewal-test');
  const upfront = page.getByRole('button', { name: /Pay in full by card/ });
  const monthly = page.getByRole('button', { name: /Pay monthly by card/ });
  const dd = page.getByRole('button', { name: /Pay monthly by Direct Debit/ });
  await expect(monthly).toHaveAttribute('aria-pressed', 'true');
  await expect(dd).toHaveText('Pay monthly by Direct Debit£3.92/month');
  await expect(dd).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(/in progress/i)).toHaveCount(0);
  const boxes = await Promise.all([upfront, monthly, dd].map(locator => locator.boundingBox()));
  if (width < 768) {
    expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
    expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].y + boxes[1].height);
  } else {
    expect(boxes[1].y).toBe(boxes[0].y);
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await upfront.focus();
  await page.keyboard.press('Tab');
  await expect(monthly).toBeFocused();
  expect(await monthly.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('button-monthly-card-payment')).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await dd.focus();
  await page.keyboard.press('Space');
  await expect(dd).toHaveAttribute('aria-pressed', 'true');
  await expect(dd).toHaveText('Pay monthly by Direct Debit£3.92/month');
  expect(posts).toHaveLength(0);
  await page.screenshot({ path: `generated-artifacts/renewal-choices-${pricing_policy}-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Review the updated amount');
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByTestId('text-dd-first-collection-payment')).toBeVisible();
  await expect(page.getByTestId('text-dd-first-collection-payment')).toContainText('Collections continue');
  expect(posts.map(post => post.action)).toEqual(['change_renewal_payment_method']);
});
}
}

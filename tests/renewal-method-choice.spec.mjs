import { test, expect } from '@playwright/test';

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

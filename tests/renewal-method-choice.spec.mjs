import { test, expect } from '@playwright/test';

test('renewal choices stack on mobile and support keyboard selection and safe continuation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = await (await page.request.get('/src/components/forms/MembershipPaymentField.jsx')).text();
  const reactPath = source.match(/from "([^"]+\/react\.js[^"]*)"/)?.[1];
  expect(reactPath).toBeTruthy();
  const clientPath = reactPath.replace(/react\.js/, 'react-dom_client.js');
  const posts = [];
  let selected = true;
  await page.route('**/api/**', async route => {
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
      directDebit: { monthlyAmount: 10, instalmentCount: 12, planTotal: 120, scope: 'member' },
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
  await expect(page.getByText(/in progress/i)).toHaveCount(0);
  const boxes = await Promise.all([upfront, monthly, dd].map(locator => locator.boundingBox()));
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
  expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].y + boxes[1].height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await upfront.focus();
  await page.keyboard.press('Tab');
  await expect(monthly).toBeFocused();
  expect(await monthly.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('button-monthly-card-payment')).toBeVisible();
  expect(posts).toHaveLength(0);
  await dd.focus();
  await page.keyboard.press('Space');
  await expect(dd).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-dd-first-collection-payment')).toBeVisible();
  expect(posts.map(post => post.action)).toEqual(['change_renewal_payment_method']);
  await page.screenshot({ path: 'generated-artifacts/renewal-choices-mobile.png', fullPage: true });
});

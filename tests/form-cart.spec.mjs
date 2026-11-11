import { test, expect } from '@playwright/test';
import { priceCartLines } from '../shared/formCart.js';

const product = '20000000-0000-4000-8000-000000000001';
const bundle = '20000000-0000-4000-8000-000000000002';
const items = [
  { id: product, kind: 'product', name: 'Handbook', description: 'Annual edition', unitPriceMinor: 1000,
    currency: 'GBP', taxTreatment: 'standard', taxRateBps: 2000, remaining: 3, available: true },
  { id: bundle, kind: 'bundle', name: 'Member package', description: 'Independent package stock', unitPriceMinor: 2500,
    currency: 'GBP', taxTreatment: 'zero_rated', taxRateBps: 0, remaining: 2, available: true },
];
const form = { id: 'cart-fixture', slug: 'cart-fixture', name: 'Cart fixture', blank_layout: true,
  is_active: true, form_type: 'standard', layout_type: 'standard', pages: [], visibility_rules: [], entity_pipelines: {},
  fields: [
    { id: 'name', type: 'text', label: 'Your name', required: true },
    { id: 'cart', type: 'sales_cart', label: 'Your cart', required: true, cart_version: 1,
      allowed_product_ids: [product], allowed_bundle_ids: [bundle], bundle_tax: { [bundle]: { treatment: 'zero_rated', rateBps: 0 } } },
    { id: 'payment', type: 'payment', label: 'Payment', price_field_id: 'cart', payment_currency: 'GBP', payment_providers: ['stripe'] },
  ] };
async function mock(page, info, { display, authenticated = false } = {}) {
  const offered = display ? [...items.map(item => item.kind === 'bundle' ? { ...item, categoryId: 'packs', categoryName: 'Packages' } : item),
    { ...items[1], id: '20000000-0000-4000-8000-000000000003', name: 'Extra pack', categoryId: null, categoryName: null }] : items;
  const configuredForm = display ? { ...form, fields: form.fields.map(field => field.type === 'sales_cart'
    ? { ...field, bundle_display: display, show_bundle_category: true } : field) } : form;
  const state = { creates: 0, confirms: 0, failStock: true, lastAnswers: null };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (!request.url().startsWith(info.project.use.baseURL)) return route.abort();
    // Serve the real app entry without tenant SSR: the workspace's legacy
    // database cannot supply tenant branding. All API responses below are fixtures.
    if (request.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<div id="root"></div>
      <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
      window.__vite_plugin_react_preamble_installed__=true;
      await import('/src/main.jsx');
      </script>` });
    if (!p.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/tenant-info') return json({ id: 'fixture-tenant', slug: 'fixture', name: 'Fixture', branding: {} });
    if (p === '/api/public/tenant-branding') return json({ tenant_id: 'fixture-tenant', name: 'Fixture', header_config: {}, footer_config: {} });
    if (['/api/public/session','/api/me','/api/auth/user'].includes(p)) return json(p === '/api/public/session'
      ? { authenticated, member: authenticated ? { id: 'fixture-member', tenant_id: 'fixture-tenant', email: 'fixture@example.test' } : null } : { error: 'Not authenticated' }, p === '/api/public/session' ? 200 : 401);
    if (p === '/api/public/form/cart-fixture') return json(configuredForm);
    if (p === '/api/public/form-bundles') return json({ items: offered });
    if (p === '/api/public/form-payment-providers') return json({ providers: [{ id: 'stripe', configured: true, name: 'Credit / debit card' }] });
    if (p === '/api/public/form-payment') {
      const body = request.postDataJSON();
      if (body.action === 'quote') {
        const receipt = priceCartLines(body.submission_data.cart, offered, 'GBP');
        return json({ required: receipt.grossMinor > 0, amount: receipt.grossMinor / 100, currency: 'GBP', cart: { ...receipt, fieldId: 'cart' } });
      }
      if (body.action === 'create') {
        state.creates++; state.lastAnswers = body.submission_data;
        if (state.failStock) return json({ error: 'Stock changed', code: 'CART_UNAVAILABLE' }, 409);
        return json({ alreadyPaid: true, submissionId: 'fixture-payment', provider: 'stripe', status: 'paid' });
      }
      state.confirms++;
      return json({ status: 'paid', provider: 'stripe', submissionId: 'fixture-payment', paymentSucceeded: true });
    }
    if (!['GET', 'OPTIONS'].includes(request.method())) return json({ error: 'Blocked fixture write' }, 599);
    return json([]);
  });
  return state;
}
for (const mode of ['public', 'authenticated', 'embedded']) {
  for (const width of [390, 1280]) {
    test(`${mode} dropdown at ${width}px retains multiple bundles across filters`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 950 });
      await mock(page, info, { display: 'dropdown', authenticated: mode === 'authenticated' });
      let scope = page;
      if (mode === 'embedded') {
        await page.goto('/');
        await page.setContent(`<iframe title="cart fixture" src="${info.project.use.baseURL}/embed/form/cart-fixture" style="width:100%;height:900px;border:0"></iframe>`);
        scope = page.frameLocator('iframe[title="cart fixture"]');
      } else await page.goto('/FormView?slug=cart-fixture');
      const picker = scope.getByLabel('Bundle', { exact: true });
      const quantity = scope.getByLabel('Bundle quantity', { exact: true });
      await expect(picker).toBeVisible({ timeout: 45000 });
      await picker.selectOption(bundle);
      await quantity.fill('2');
      await scope.getByRole('button', { name: 'Add bundle', exact: true }).click();
      await scope.getByLabel('Bundle category', { exact: true }).selectOption('_uncategorised');
      await expect(picker).toHaveValue('');
      await expect(scope.locator(`#cart-cart-bundle-${bundle}`)).toHaveValue('2');
      await picker.selectOption('20000000-0000-4000-8000-000000000003');
      await scope.getByRole('button', { name: 'Add bundle', exact: true }).click();
      await expect(scope.getByText(/Amount due:.*75.00/).first()).toBeVisible();
      await scope.getByLabel('Bundle category', { exact: true }).selectOption('');
      await picker.selectOption(bundle);
      await expect(quantity).toHaveValue('2');
      await quantity.fill('1');
      await scope.getByRole('button', { name: 'Update bundle', exact: true }).click();
      await expect(scope.getByText(/Amount due:.*50.00/).first()).toBeVisible();
      await scope.locator(`#cart-cart-bundle-${bundle}`).locator('..').getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(scope.getByText(/Amount due:.*25.00/).first()).toBeVisible();
      const overflow = await picker.evaluate(el => el.ownerDocument.documentElement.scrollWidth > el.ownerDocument.documentElement.clientWidth);
      expect(overflow).toBe(false);
    });
  }
}
for (const mode of ['public', 'embedded']) {
  test(`${mode}: mixed quantities, required answer, conflict recovery and checkout`, async ({ page }, info) => {
    const state = await mock(page, info);
    let scope = page;
    if (mode === 'embedded') {
      await page.goto('/');
      await page.setContent(`<iframe title="cart fixture" src="${info.project.use.baseURL}/embed/form/cart-fixture" style="width:600px;height:950px"></iframe>`);
      scope = page.frameLocator('iframe[title="cart fixture"]');
    } else await page.goto('/FormView?slug=cart-fixture');
    const pq = scope.locator(`#cart-cart-product-${product}`);
    const bq = scope.locator(`#cart-cart-bundle-${bundle}`);
    await expect(pq).toBeVisible({ timeout: 45000 });
    await pq.fill('2'); await bq.fill('1');
    await expect(scope.getByText(/Amount due:.*49.00/).first()).toBeVisible();
    const checkout = scope.getByTestId('form-payment-provider-choices-payment').getByRole('button').first();
    await checkout.click();
    await expect.poll(() => state.creates).toBe(0);
    await scope.getByRole('textbox').first().fill('Retain this answer');
    await checkout.click();
    await expect.poll(() => state.creates).toBe(1);
    await expect(pq).toHaveValue('2'); await expect(bq).toHaveValue('1');
    await expect(scope.getByRole('textbox').first()).toHaveValue('Retain this answer');
    state.failStock = false;
    await checkout.click();
    await expect.poll(() => state.creates).toBe(2);
    expect(state.lastAnswers.cart.lines).toHaveLength(2);
  });
}
test('provider return confirms the original submission without creating another payment', async ({ page }, info) => {
  const state = await mock(page, info);
  await page.goto('/FormView?slug=cart-fixture&form_payment_submission=fixture-payment&form_payment_provider=stripe');
  await expect.poll(() => state.confirms, { timeout: 45000 }).toBeGreaterThan(0);
  expect(state.creates).toBe(0);
});

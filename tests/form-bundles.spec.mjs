import { test, expect } from '@playwright/test';
const bundle = '20000000-0000-4000-8000-000000000001';
const sold = '20000000-0000-4000-8000-000000000002';
for (const mode of ['public','authenticated','embedded']) {
 for (const stockPolicy of [undefined, true, false]) {
  test(`${mode}, stock=${stockPolicy}: sold-out choices, authoritative price and conflict recovery`, async ({ page }, info) => {
    let quotes = 0, creates = 0;
    const form = { id: 'bundle-fixture', slug: 'bundle-fixture', name: 'Bundle fixture', blank_layout: true,
      is_active: true, form_type: 'application', layout_type: 'standard', pages: [], visibility_rules: [],
      entity_pipelines: {}, fields: [
        { id: 'name', type: 'text', label: 'Your name', required: true },
        { id: 'bundle', type: 'sales_bundle', label: 'Choose package', required: true, allowed_bundle_ids: [bundle,sold], reduce_bundle_stock_on_submission: stockPolicy },
        { id: 'payment', type: 'payment', label: 'Payment', payment_currency: 'GBP', price_field_id: 'bundle', payment_providers: ['stripe'] },
      ] };
    const member = { id: 'fixture-member', tenant_id: 'fixture-tenant', role_id: 'fixture-role', first_name: 'Fixture', email: 'fixture@example.invalid', member_excluded_features: [] };
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // Serve only the app shell as a fixture: the legacy workspace database
    // cannot resolve SSR branding. Real source modules and UI still execute.
    await page.context().route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.continue();
      return route.fulfill({ contentType: 'text/html', body: `<div id="root"></div>
        <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
        window.__vite_plugin_react_preamble_installed__=true;
        await import('/src/main.jsx');
        </script>` });
    });
    await page.context().route('**/rest/v1/**', route => json(route, []));
    await page.context().route('**/api/**', route => {
      const req = route.request(), p = new URL(req.url()).pathname;
      if (!p.startsWith('/api/')) return route.continue();
      if (p === '/api/auth/me') return json(route, mode === 'authenticated' ? member : null, mode === 'authenticated' ? 200 : 401);
      if (p === '/api/auth/tenant-user-me') return json(route, { user: null }, 401);
      if (p === '/api/entities/Member/fixture-member') return json(route, member);
      if (p === '/api/entities/Role/fixture-role') return json(route, { id: 'fixture-role', name: 'Member', excluded_features: [] });
      if (p === '/api/public/form/bundle-fixture') return json(route, form);
      if (p === '/api/public/form-bundles') return json(route, { items: [
        { id: bundle, name: 'Available package', amountMinor: 12345, currency: 'GBP', remaining: 1, available: true },
        { id: sold, name: 'Sold package', amountMinor: 5000, currency: 'GBP', remaining: 0, available: false },
      ] });
      if (p === '/api/public/form-payment-providers') return json(route, { providers: [{ id: 'stripe', configured: true, name: 'Credit / debit card' }] });
      if (p === '/api/public/form-payment') {
        if (req.postDataJSON().action === 'quote') { quotes++; return json(route, { required: true, amount: 123.45, currency: 'GBP' }); }
        creates++; return json(route, { code: 'BUNDLE_UNAVAILABLE', error: 'Choose another bundle' }, 409);
      }
      if (!['GET','OPTIONS'].includes(req.method())) return json(route, { error: 'Blocked fixture write' }, 599);
      return json(route, []);
    });
    let scope = page;
    if (mode === 'embedded') {
      await page.goto('/');
      await page.setContent(`<iframe title="fixture" src="${info.project.use.baseURL}/embed/form/bundle-fixture" style="width:600px;height:950px"></iframe>`);
      scope = page.frameLocator('iframe[title="fixture"]');
    } else await page.goto('/FormView?slug=bundle-fixture');
    const select = scope.getByRole('combobox', { name: 'Choose package' });
    // First navigation can include cold Vite transforms of the full form renderer.
    await expect(select).toBeVisible({ timeout: 30000 });
    await expect(select.locator(`option[value="${sold}"]`)).toBeDisabled();
    await scope.getByRole('textbox').first().fill('Keep my answer');
    await select.selectOption(bundle);
    await expect.poll(() => quotes).toBeGreaterThan(0);
    await expect(scope.getByText(/Amount due:.*123.45/).first()).toBeVisible();
    await scope.getByTestId('form-payment-provider-choices-payment').getByRole('button').first().click();
    await expect.poll(() => creates).toBe(1);
    await expect(scope.getByRole('textbox').first()).toHaveValue('Keep my answer');
    await expect(select).toHaveValue('');
  });
 }
}

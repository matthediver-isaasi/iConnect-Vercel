import { test, expect } from '@playwright/test';

// Browser-only fixtures; all network writes intercepted, no real responses.
for (const surface of ['native', 'embed']) {
  test(`${surface}: completion-only success, retry key and no CRM/draft side effects`, async ({ page }) => {
    test.setTimeout(120_000);
    const writes = [];
    const unexpectedWrites = [];
    const form = { id: 'survey-fixture', name: 'Anonymous feedback', slug: 'survey-fixture',
      form_type: 'survey', is_active: true, allow_save_continue_later: false,
      fields: [{ id: 'feedback', type: 'text', label: 'Your feedback', required: true }],
      pages: [], visibility_rules: [], layout_type: 'standard', submit_button_text: 'Submit',
      survey_settings: { status: 'published', current_version: 1, response_identity: 'anonymous',
        anonymous_completion_version: 1, thank_you_message: 'Anonymous response received' } };
    await page.context().routeWebSocket('**/*', socket => socket.onMessage(() => {}));
    await page.context().route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body, status = 200) => route.fulfill({
        status, contentType: 'application/json', body: JSON.stringify(body),
      });
      if (url.origin !== 'http://127.0.0.1:5000') return route.fulfill({ status: 204, body: '' });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() === 'POST' && url.pathname === '/api/public/form-submission') {
        writes.push(request.postDataJSON());
        if (writes.length === 1) return json({ error: 'Temporary test failure' }, 503);
        return json({ success: true, accepted: true, completion_recorded: false, replayed: false });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        unexpectedWrites.push(url.pathname);
        return json({ error: 'Unexpected write' }, 599);
      }
      if (url.pathname.startsWith('/api/auth/')) return json({ error: 'Logged out' }, 401);
      if (url.pathname === '/api/public/survey-assignment/fixture') return json({ form,
        assignment: { window_state: 'open', access_mode: 'public' } });
      if (url.pathname === '/api/public/form/survey-fixture') return json(form);
      return json([]);
    });
    await page.goto(surface === 'native'
      ? '/survey/fixture?organization_id=forged'
      : '/embed/form/survey-fixture?organization_id=forged');
    await expect(page.getByRole('textbox')).toBeVisible();
    const decline = page.getByRole('button', { name: 'Decline', exact: true });
    if (await decline.isVisible()) await decline.click();
    await expect(page.getByRole('button', { name: /Save.*Later/ })).toHaveCount(0);
    await page.locator('input[type="text"]').first().fill('Useful workshop');
    await page.getByRole('button', { name: /^Submit$/ }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByRole('button', { name: /^Submit$/ })).toBeEnabled();
    await page.getByRole('button', { name: /^Submit$/ }).click();
    await expect(page.getByText('Anonymous response received')).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0].idempotency_key).toEqual(writes[1].idempotency_key);
    expect(writes[1].prefill_organization_id).toBeUndefined();
    expect(writes[1].member_id).toBeUndefined();
    expect(unexpectedWrites).toEqual([]);
    await page.screenshot({ path: `/tmp/anonymous-survey-${surface}.jpg`, fullPage: true });
  });
}
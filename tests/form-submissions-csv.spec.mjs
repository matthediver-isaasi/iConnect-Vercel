import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Synthetic responses only; all API requests are intercepted, never live data.
test('FormSubmissions downloads persisted survey scores with filters and CSV quoting', async ({ page }) => {
  const member = { id: 'fixture-admin', tenant_id: 'fixture', role_id: 'fixture-role', email: 'admin@example.invalid', member_excluded_features: [], is_team_member: false };
  const role = { id: member.role_id, name: 'Administrator', excluded_features: [] };
  const form = { id: 'fixture-survey', name: 'Synthetic meeting feedback', status: 'published', is_active: true, form_type: 'survey', fields: [
    { id: 'rating', type: 'score', label: 'Overall rating' },
    { id: 'comments', type: 'textarea', label: 'Comments' },
  ] };
  const submissions = [
    { id: 'one', created_date: '2026-10-06T10:00:00Z', submission_data: { rating: { score: 5 }, comments: 'Good, "useful"\nmeeting' } },
    { id: 'two', created_date: '2026-10-05T10:00:00Z', submission_data: { rating: { score: 0 } } },
    { id: 'three', created_date: '2026-10-04T10:00:00Z', submission_data: { rating: { na: true } } },
    { id: 'four', created_date: '2026-10-03T10:00:00Z', submission_data: {} },
  ].map(s => ({ ...s, form_id: form.id, status: 'new' }));
  submissions.push({ id: 'excluded', form_id: 'other', status: 'new', created_date: '2026-10-07T10:00:00Z', submission_data: { comments: 'must not export' } });
  const mutations = [];
  await page.context().route('**/rest/v1/**', r => r.fulfill({ json: [] }));
  await page.context().route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    // The shell records activity on navigation. Acknowledge only that exact
    // telemetry shape locally; no request reaches the real member endpoint.
    if (path === `/api/entities/Member/${member.id}` && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      if (Object.keys(body).length === 1 && typeof body.last_activity === 'string') return json(member);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      mutations.push(path);
      return route.fulfill({ status: 599, json: { error: 'Fixture forbids mutations' } });
    }
    if (path === '/api/auth/me') return json(member);
    if (path === '/api/auth/tenant-user-me') return json({ user: member, tenant: { id: member.tenant_id } });
    if (path === '/api/entities/Member') return json([member]);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === '/api/entities/Role') return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === '/api/entities/Form') return json([form]);
    if (path === '/api/entities/FormSubmission') return json(submissions);
    return json([]);
  });
  await page.goto(`/FormSubmissions?form=${form.id}`);
  await page.getByTestId('button-export-csv').click();
  await page.getByTestId('checkbox-export-field-__submitter_email').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('button-confirm-export').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  // Parse quoted cells, including embedded newlines and escaped quotes.
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell); cell = '';
      if (ch === '\n') { rows.push(row); row = []; }
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  const rating = rows[0].indexOf('Overall rating');
  const comments = rows[0].indexOf('Comments');
  expect(rating).toBeGreaterThanOrEqual(0);
  expect(rows.slice(1).map(r => r[rating])).toEqual(['5', '0', 'Not applicable', '']);
  expect(rows[1][comments]).toBe('Good, "useful"\nmeeting');
  expect(csv).not.toContain('[object Object]');
  expect(csv).not.toContain('must not export');
  expect(rows[0]).not.toContain('Submitter Email');
  expect(download.suggestedFilename()).toMatch(/form_submissions_.*\.csv/);
  expect(mutations).toEqual([]);
});

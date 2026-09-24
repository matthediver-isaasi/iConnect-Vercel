// Read-only component fixture against an ALREADY running Vite preview.
// Synthetic values below are test fixtures, never persisted or sent to a
// production data endpoint. Usage: node scripts/verify-event-revenue-widgets.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const baseUrl = process.env.WIDGET_PREVIEW_URL || 'http://127.0.0.1:5000';
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: 'Unexpected API access in isolated revenue fixture' }),
  }));
  await page.route('**/api/dashboard/widgets/preview', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { type: 'scalar', value: 450, total: 450, currency: 'GBP' } }),
  }));
  await page.route('**/__event_revenue_fixture__', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import('/src/index.css');
const React = (await import('/@fs' + ${JSON.stringify(`${process.cwd()}/node_modules/.vite/deps/react.js`)})).default;
const { createRoot } = (await import('/@fs' + ${JSON.stringify(`${process.cwd()}/node_modules/.vite/deps/react-dom_client.js`)})).default;
const { WidgetBody, WidgetCacheStatus } = await import('/src/components/dashboard/WidgetCard.jsx');
const { default: WidgetBuilderModal } = await import('/src/components/dashboard/WidgetBuilderModal.jsx');
const builderSource = await (await fetch('/src/components/dashboard/WidgetBuilderModal.jsx')).text();
const queryUrl = builderSource.match(/from ["']([^"']*@tanstack_react-query[^"']*)/)[1];
const { QueryClient, QueryClientProvider } = await import(queryUrl);
const { defaultDashboardWidgetPalette } = await import('/@fs' + ${JSON.stringify(`${process.cwd()}/shared/dashboardWidgetPalette.js`)});
const e = React.createElement;
const config = { source: 'event_revenue', revenueCurrency: 'GBP',
  measure: { aggregator: 'sum', field: 'booked_value', fieldKind: 'system' }, filters: [] };
const payload = { type: 'time', currency: 'GBP', total: 450, categories: ['value'],
  rows: [{ key: '2026-03', value: 140 }, { key: '2026-04', value: 310 }] };
const client = new QueryClient();
client.setQueryData(['/api/dashboard/sources'], { sources: [
  { id: 'organization', label: 'Organisations', systemFields: [], customFields: [] },
  { id: 'event_revenue', label: 'Event Revenue', timestampField: 'event_start_date', isEventRevenue: true,
    systemFields: [
      { name: 'booked_value', label: 'Booking value after discounts', type: 'number', aggregatable: true },
      { name: 'event_id', label: 'Event', type: 'enum', options: [{ value: 'simple:a', label: 'Spring event (simple)' }] },
      { name: 'event_kind', label: 'Event kind', type: 'enum', options: [{ value: 'simple', label: 'Simple event' }] },
      { name: 'event_start_date', label: 'Event start date', type: 'date' },
    ], customFields: [] },
] });
client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
function Fixture() {
  const [open, setOpen] = React.useState(false);
  return e(QueryClientProvider, { client }, e('main', { className: 'p-6 bg-slate-50 min-h-screen' },
    e('h1', { className: 'text-xl font-semibold mb-4' }, 'Event Revenue — isolated synthetic test fixture'),
    e('button', { onClick: () => setOpen(true), className: 'border rounded p-2 mb-4' }, 'Open builder'),
    e('div', { className: 'grid grid-cols-2 gap-4' },
      ...['stat', 'line', 'bar', 'list'].map(type => e('section', {
        key: type, 'data-testid': 'fixture-' + type, className: 'bg-white border rounded-xl p-5 h-80 flex flex-col'
      }, e('header', { className: 'flex justify-between mb-3' },
        e('h2', { className: 'font-semibold' }, type === 'stat' ? 'Total event revenue' : 'Event revenue by month · ' + type),
        e(WidgetCacheStatus, { widgetId: type, cache: { status: 'failed', updatedAt: '2026-09-24T18:00:00Z', error: 'Test refresh error' } })),
      e(WidgetBody, { widget: { id: type, widget_type: type, height: 'medium', config }, palette: defaultDashboardWidgetPalette(),
        payload: type === 'stat' ? { ...payload, type: 'scalar', value: 450 } : payload })))),
    e(WidgetBuilderModal, { open, onClose: () => setOpen(false), onSave: () => {}, canSavePersonal: true })
  ));
}
createRoot(document.getElementById('root')).render(e(Fixture));
</script></body></html>`,
  }));
  await page.goto(`${baseUrl}/__event_revenue_fixture__`);
  await page.getByTestId('fixture-stat').getByText('£450.00', { exact: true }).waitFor()
    .catch(error => { throw new Error(`${error.message}\nFixture failures: ${failures.join('; ')}`); });
  assert.match(await page.getByTestId('fixture-list').innerText(), /£140\.00.*£310\.00.*£450\.00/s);
  assert.doesNotMatch(await page.getByTestId('fixture-stat').innerText(), /records/i);
  // Let Recharts' initial animation settle before the visual artifact.
  await page.waitForTimeout(1600);
  await page.getByTestId('fixture-stat').getByRole('button', { name: /Refresh failed/ }).hover();
  await page.getByRole('tooltip').filter({ hasText: 'Test refresh error' }).waitFor();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: '/tmp/event-revenue-widgets.png', fullPage: true });
  await page.getByRole('button', { name: 'Open builder' }).click();
  await page.getByTestId('input-widget-title').fill('Total event revenue');
  await page.getByTestId('select-widget-source').click();
  await page.getByRole('option', { name: 'Event Revenue', exact: true }).click();
  await page.getByTestId('event-revenue-controls').waitFor();
  assert.equal(await page.locator('#event-revenue-currency').inputValue(), 'GBP');
  assert.match(await page.getByTestId('select-widget-field').innerText(), /Booking value after discounts/);
  assert.equal(await page.getByTestId('button-save-widget').isEnabled(), true);
  await page.getByRole('dialog').getByTestId('event-revenue-report').waitFor();
  await page.getByTestId('event-revenue-controls').scrollIntoViewIfNeeded();
  assert.deepEqual(failures, [], 'isolated fixture must render without runtime or asset failures');
  await page.screenshot({ path: '/tmp/event-revenue-builder.png', fullPage: true });
  console.log('PASS: stat, list, line/bar mounting, currency, compact warning tooltip, fresh builder source selection. Screenshots: /tmp/event-revenue-widgets.png, /tmp/event-revenue-builder.png');
} finally {
  await browser.close();
}
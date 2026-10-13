import { test, expect } from '@playwright/test';

const initial = [
  { setting_key: 'event_display_timezones', setting_value: JSON.stringify([{ timezone: 'Europe/London', label: 'UK' }, { timezone: 'Africa/Nairobi', label: 'EAT' }, { timezone: 'Asia/Kolkata', label: 'IST' }]), id: 'zones' },
  { setting_key: 'event_time_format_24h', setting_value: 'true', id: 'clock' },
];
const event = { id: 'display-test', title: 'International event', status: 'published', start_date: '2027-01-15T23:00:00Z', end_date: '2027-01-16T01:00:00Z', timezone: 'Europe/London', available_seats: null, pricing_config: { ticket_classes: [{ price: 0, is_public: true }] } };

async function fixture(page, request, mode = 'cards', tenant = 'one', store = {}) {
  const response = await request.get('/src/components/events/EventTimeDisplay.jsx');
  const source = await response.text();
  const react = source.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  expect(react).toBeTruthy();
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  await page.route('**/src/hooks/useMemberAccess.js*', route => route.fulfill({ contentType: 'application/javascript', body: `const excluded=()=>false; export function useMemberAccess(){return {isAdmin:true,isFeatureExcluded:excluded,isAccessReady:true}}` }));
  await page.route('**/src/api/base44Client.js*', route => route.fulfill({ contentType: 'application/javascript', body: `
    let active='${tenant}';const listeners=new Set();
    export const getActiveTenantId=()=> active; export const setActiveTenantId=id=>{active=id;listeners.forEach(fn=>fn())}; export const subscribeToActiveTenantId=fn=>{listeners.add(fn);return ()=>listeners.delete(fn)};
    window.switchDisplayTenant=setActiveTenantId;
    const call=(method,data)=>fetch('/fixture-settings',{method,headers:{'Content-Type':'application/json','X-Tenant-Id':active},body:data?JSON.stringify(data):undefined}).then(r=>r.json());
    const empty={list:async()=>[],filter:async()=>[]};
    export const base44={entities:new Proxy({}, {get:(_,key)=>key==='SystemSettings'?{list:()=>call('GET'),create:data=>call('POST',data),update:(id,data)=>call('PATCH',{id,...data})}:empty}),auth:{me:async()=>({})},functions:{invoke:async()=>({})}};
    export const createClient=()=>base44;
  ` }));
  store[tenant] ??= structuredClone(initial);
  await page.route('**/fixture-settings', async route => {
    const req = route.request();
    const selectedTenant = req.headers()['x-tenant-id'] || tenant;
    if (req.method() !== 'GET') {
      const data = req.postDataJSON();
      if (req.method() === 'PATCH') Object.assign(store[selectedTenant].find(x => x.id === data.id), data);
      else store[selectedTenant].push({ ...data, id: `s-${store[selectedTenant].length}` });
    }
    await route.fulfill({ json: store[selectedTenant] });
  });
  await page.route('**/api/**', route => {
    const url = route.request().url();
    if (new URL(url).pathname.startsWith('/src/')) return route.fallback();
    let data = [];
    if (url.includes('system-settings')) data = store[tenant];
    else if (url.includes('complex-events')) data = [{ ...event, id: 'complex', is_complex: true }];
    else if (url.includes('/events')) data = [{ ...event, is_featured: true }];
    return route.fulfill({ json: data });
  });
  await page.route('**/__timezone-fixture*', route => route.fulfill({ contentType: 'text/html', body: `
    <html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div>
    <script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('${react}')).default;
    const {createRoot}=(await import('${dependency('react-dom_client')}')).default;
    const {QueryClient,QueryClientProvider}=await import('${dependency('@tanstack_react-query')}');
    const {BrowserRouter}=await import('${dependency('react-router-dom')}');
    const Page=(await import('/src/pages/${mode === 'settings' ? 'EventSettings' : 'PublicEvents'}.jsx')).default;
    const Display=(await import('/src/components/events/EventTimeDisplay.jsx')).default;
    const PortalCard=(await import('/src/components/events/EventCard.jsx')).default;
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(BrowserRouter,null,
      React.createElement(Page),
      ${mode === 'settings' ? 'null' : `React.createElement('section',{'data-testid':'portal-card'},React.createElement(PortalCard,{event:${JSON.stringify(event)},isAdmin:false,isFeatureExcluded:()=>true,systemSettings:${JSON.stringify(initial)}}))`},
      ${mode === 'settings' ? 'null' : `React.createElement('section',{'data-testid':'header-range'},React.createElement(Display,{event:${JSON.stringify(event)},end:'2027-01-16T01:00:00Z',systemSettings:${JSON.stringify(initial)}}))`}
    )));
    </script></body></html>` }));
  await page.goto('/__timezone-fixture');
}

test('real settings save/reload, reorder/remove and tenant isolation', async ({ page, request }) => {
  const store = {};
  await fixture(page, request, 'settings', 'one', store);
  await expect(page.getByLabel('Move Asia/Kolkata up')).toBeVisible();
  await page.getByLabel('Move Asia/Kolkata up').click();
  await page.getByLabel('Remove Africa/Nairobi').click();
  await page.getByRole('button', { name: 'Save Settings', exact: true }).first().click();
  await expect.poll(() => JSON.parse(store.one.find(s => s.id === 'zones').setting_value).map(z => z.timezone)).toEqual(['Europe/London', 'Asia/Kolkata']);
  await page.reload();
  await expect(page.getByLabel('Remove Asia/Kolkata')).toBeVisible();
  await expect(page.getByLabel('Remove Africa/Nairobi')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  await fixture(page, request, 'settings', 'two', store);
  await expect(page.getByLabel('Remove Africa/Nairobi')).toBeVisible();
});

for (const enumeration of ['Kolkata', 'Calcutta', 'fallback']) {
  test(`EAT/IST discovery and settings round trip with ${enumeration} enumeration`, async ({ page, request }) => {
    await page.addInitScript(mode => {
      const original = Intl.supportedValuesOf?.bind(Intl);
      Intl.supportedValuesOf = key => {
        if (key !== 'timeZone') return original(key);
        if (mode === 'fallback') throw new RangeError('Enumeration unavailable');
        return ['Africa/Nairobi', `Asia/${mode}`, 'Europe/London'];
      };
    }, enumeration);
    const store = { one: [{ id: 'zones', setting_key: 'event_display_timezones', setting_value: '[]' }] };
    await fixture(page, request, 'settings', 'one', store);
    const editor = page.getByRole('group', { name: 'Event display timezones' });
    const choose = async (query, name) => {
      await editor.getByRole('combobox').click();
      await editor.getByTestId('input-timezone-search').fill(query);
      const option = editor.getByRole('button', { name });
      await expect(option).toHaveCount(1);
      await option.click();
    };
    for (const query of ['EAT', 'East Africa Time', 'Nairobi', 'Africa/Nairobi', 'GMT+3']) {
      await choose(query, /Nairobi — East Africa Time \(EAT\)/);
    }
    await editor.getByRole('button', { name: 'Add timezone', exact: true }).click();
    await editor.getByLabel('Label (optional)').fill('EAT');
    for (const query of ['IST', 'India Standard Time', 'Kolkata', 'Calcutta', 'Asia/Kolkata', 'Asia/Calcutta', 'GMT+5:30']) {
      await choose(query, /Kolkata \/ Calcutta — India Standard Time \(IST\)/);
    }
    await editor.getByRole('button', { name: 'Add timezone', exact: true }).click();
    await editor.getByLabel('Label (optional)').nth(1).fill('IST');
    const india = enumeration === 'Kolkata' ? 'Asia/Kolkata' : 'Asia/Calcutta';
    await editor.getByLabel(`Move ${india} up`).click();
    await page.getByRole('button', { name: 'Save Settings', exact: true }).first().click();
    const saved = [{ timezone: india, label: 'IST' }, { timezone: 'Africa/Nairobi', label: 'EAT' }];
    await expect.poll(() => JSON.parse(store.one.find(s => s.id === 'zones').setting_value)).toEqual(saved);
    await page.reload();
    await expect(editor.getByLabel('Label (optional)').nth(0)).toHaveValue('IST');
    await expect(editor.getByLabel('Label (optional)').nth(1)).toHaveValue('EAT');
    await choose('IST', /India Standard Time/);
    await expect(editor.getByRole('button', { name: 'Add timezone', exact: true })).toBeDisabled();
    // A previously saved opposite alias must also block duplicate additions,
    // without silently rewriting its persisted spelling.
    const opposite = india === 'Asia/Kolkata' ? 'Asia/Calcutta' : 'Asia/Kolkata';
    saved[0].timezone = opposite;
    store.one.find(s => s.id === 'zones').setting_value = JSON.stringify(saved);
    await page.reload();
    await choose('Calcutta', /India Standard Time/);
    await expect(editor.getByRole('button', { name: 'Add timezone', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Save Settings', exact: true }).first().click();
    await expect.poll(() => JSON.parse(store.one.find(s => s.id === 'zones').setting_value)).toEqual(saved);
  });
}

test('public simple, complex and featured cards plus range display wrap on mobile', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, request);
  for (const id of ['card-event-display-test', 'card-event-complex', 'card-featured-event-display-test']) {
    const card = page.getByTestId(id);
    await expect(card.getByRole('definition').filter({ hasText: '04:30' })).toBeVisible();
    await expect(card.getByRole('definition').filter({ hasText: '02:00' })).toBeVisible();
    await expect(card.getByText('EAT', { exact: true })).toBeVisible();
    await expect(card.getByText('IST', { exact: true })).toBeVisible();
    await expect(card.getByText('16 Jan 2027', { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByTestId('header-range')).toContainText('23:00 – 01:00');
  await expect(page.getByTestId('portal-card').getByRole('definition').filter({ hasText: '04:30' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('shared admin host uses selected workspace, not public slug, and switches reactively', async ({ page, request }) => {
  const store = { two: [{ setting_key: 'event_display_timezones', setting_value: JSON.stringify([{ timezone: 'America/New_York', label: 'New York' }]) }] };
  await fixture(page, request, 'cards', 'one', store);
  const card = page.getByTestId('portal-card');
  await expect(card.getByText('IST', { exact: true })).toBeVisible();
  await page.evaluate(() => window.switchDisplayTenant('two'));
  await expect(card.getByText('New York', { exact: true })).toBeVisible();
  await expect(card.getByText('IST', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.switchDisplayTenant('one'));
  await expect(card.getByText('IST', { exact: true })).toBeVisible();
  await expect(card.getByText('New York', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.switchDisplayTenant(null));
  await expect(card.getByText('IST', { exact: true })).toBeVisible();
});

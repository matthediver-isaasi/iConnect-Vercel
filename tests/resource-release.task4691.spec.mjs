// Isolated browser fixture: real UI modules, mocked transport/auth only.
// No application server, database, or live API requests are used.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';

let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': 'export const base44 = window.fixture.api;',
    '@/api/publicClient': 'export const publicClient = window.fixture.publicApi;',
    '../api/publicClient': 'export const publicClient = window.fixture.publicApi;',
    '@/api/supabaseClient': 'export const supabase = null; export const isSupabaseConfigured = false;',
    '@/hooks/useMemberAccess': `export const useMemberAccess = () => ({
      memberInfo:window.fixture.member, memberRole:{id:'role'}, isAdmin:false,
      isAccessReady:true, isFeatureExcluded:()=>false
    });`,
    '@/contexts/LayoutContext': `export const useLayoutContext = () => ({
      authResolved:true, sessionValidated:!!window.fixture.member, hasBanner:false
    });`,
    '@/contexts/TenantBrandingContext': 'export const useTenantBranding = () => ({});',
    '@/hooks/useResourceRealtime': 'export const useResourceRealtime = () => {};',
    '../bookmarks/BookmarkButton': 'export default () => null;',
    '../TypographyStyleSelector': `export default () => null;
      export const applyTypographyStyle = () => ({});
      export const useTypographyStyles = () => ({getStyleById:()=>null});`,
  };
  const result = await build({
    stdin: {
      contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
        import {BrowserRouter,Routes,Route} from 'react-router-dom';
        import Resources from './client/src/pages/Resources.jsx';
        import Management from './client/src/pages/ResourceManagement.jsx';
        import MemberGroupDetail from './client/src/pages/MemberGroupDetail.jsx';
        import Embed from './client/src/pages/EmbedResource.jsx';
        import {IEditResourcesShowcaseElementRenderer as Showcase} from './client/src/components/iedit/elements/IEditResourcesShowcaseElement.jsx';
        import {resourceQueryOptions} from './client/src/lib/resourceQueryOptions.mjs';
        import * as releaseTime from './client/src/lib/resourceReleaseTime.mjs';
        window.releaseTime = releaseTime;
        function Group(){
          const {data=[]}=useQuery({queryKey:['member-group-resources','group',window.fixture.admin?'management':'read'],
            queryFn:()=>window.fixture.api.entities.Resource.list(resourceQueryOptions({groupId:'group',management:window.fixture.admin}))});
          return <section><h1>Group resources query fixture</h1>{data.map(r=><p key={r.id}>{r.title}</p>)}</section>;
        }
        const mode=window.fixture.mode;
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter>
          {mode==='group-detail'?<MemberGroupDetail/>:mode==='embed'?<Routes><Route path="/embed/:identifier" element={<Embed/>}/></Routes>:mode==='management'?<Management/>:mode==='group'?<Group/>:mode==='showcase'?<Showcase element={{content:{resourceSourceMode:window.fixture.specific?'specific':'latest',resourceIds:['released','future']}}} settings={{}}/>:<Resources/>}
        </BrowserRouter></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-boundaries',
      setup(b) {
        b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fixture' } : null);
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx', resolveDir: process.cwd() }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, options = {}) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/public/resource/future') {
      return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Resource not found'})});
    }
    return route.fulfill(url.pathname.startsWith('/api/')
      ? { contentType: 'application/json', body: '[]' }
      : { contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
  });
  await page.goto(`https://task4691.fixture.invalid/${options.mode==='group-detail'?'MemberGroupDetail?id=group':options.mode==='embed'?'embed/future':'resources'}`);
  await page.evaluate(options => {
    const f = window.fixture = { ...options, calls: [], writes: [], member: options.guest ? null : { id:'member', tenant_id:'tenant',email:'member@fixture.invalid',first_name:'Fixture',last_name:'Member' } };
    const released = { id:'released', title:'Released fixture resource', subcategories:['Fixture'], status:'active', is_public:true, resource_type:'url', target_url:'https://example.invalid/released', release_date:'2026-01-01T12:34:56.789Z' };
    const future = { ...released, id:'future', title:'Scheduled fixture resource', release_date:'2099-07-15T12:34:56.789Z' };
    if(options.mode==='group-detail') {
      released.member_group_id='group';
      future.member_group_id='group';
    }
    f.api = {
      auth: { me:async()=>f.member },
      entities: new Proxy({}, { get:(_,name)=>({
        list:async(options={})=>{
          f.calls.push({name,options});
          if(name==='Resource') return options.queryParams?.resource_context==='management'?[released,future]:[released];
          return [];
        },
        listAll:async(options={})=>f.api.entities[name].list(options),
        get:async(id)=>name==='MemberGroup'
          ? {id:'group',name:'Release policy fixture group',is_active:true,allow_self_join:true,resource_subcategories:[]}
          : name==='Member' ? f.member : {},
        filter:async(filter)=>{
          if(name==='MemberGroupAssignment')return [{id:'assignment',group_id:'group',member_id:'member',is_group_admin:!!f.admin,group_role:'Member'}];
          return [];
        },
        create:async(data)=>{f.writes.push(data);return data;},
        update:async(id,data)=>{f.writes.push({id,...data});return data;},
      }) }),
    };
    f.publicApi = {
      getTenantSlug:()=> 'fixture',
      listResources:async()=>{f.calls.push({name:'public-list'});return [released];},
      getResource:async(id)=>{f.calls.push({name:'public-single',id});if(id==='future')throw new Error('Resource not found');return released;},
      listResourceCategories:async()=>[],
      listSystemSettings:async()=>[],
      listForms:async()=>[],
      getResourceAuthorSettings:async()=>({}),
    };
  }, options);
  await page.addScriptTag({ content: script });
}

for (const guest of [true, false]) {
  test(`${guest ? 'guest' : 'member'} library does not request management scope`, async ({ page }) => {
    await mount(page, { guest });
    await expect(page.getByText('Released fixture resource', { exact:true })).toBeVisible();
    await expect(page.getByText('Scheduled fixture resource', { exact:true })).toHaveCount(0);
    expect(await page.evaluate(() => window.fixture.calls.some(c=>c.options?.queryParams?.resource_context))).toBe(false);
  });
}

for (const admin of [false, true]) {
  test(`group query ${admin ? 'management' : 'ordinary read'} isolates context`, async ({ page }) => {
    await mount(page, { mode:'group', admin });
    await expect(page.getByText('Released fixture resource')).toBeVisible();
    await expect(page.getByText('Scheduled fixture resource')).toHaveCount(admin ? 1 : 0);
    const calls = await page.evaluate(()=>window.fixture.calls);
    expect(calls[0].options.filter).toEqual({member_group_id:'group'});
    expect(calls[0].options.queryParams?.resource_context).toBe(admin?'management':undefined);
  });
}

for (const admin of [false,true]) {
  test(`actual MemberGroupDetail ${admin?'admin can manage scheduled own-group resource':'member only sees released resources'}`,async({page})=>{
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await mount(page,{mode:'group-detail',admin});
    expect(errors).toEqual([]);
    await expect(page.getByTestId('grid-group-resources').getByText('Released fixture resource',{exact:true})).toBeVisible();
    await expect(page.getByTestId('grid-group-resources').getByText('Scheduled fixture resource',{exact:true})).toHaveCount(admin?1:0);
    const calls=await page.evaluate(()=>window.fixture.calls.filter(c=>c.name==='Resource'));
    expect(calls.length).toBeGreaterThan(0);
    for(const call of calls) expect(call.options.filter).toEqual({member_group_id:'group'});
    if(admin) {
      expect(calls.some(c=>c.options.queryParams?.resource_context==='management')).toBe(true);
      await expect(page.getByTestId('button-new-group-resource')).toBeVisible();
      await expect(page.getByTestId('button-edit-resource-future')).toBeVisible();
      await page.getByTestId('button-edit-resource-future').click();
      await expect(page.getByTestId('input-resource-title')).toHaveValue('Scheduled fixture resource');
      await page.getByTestId('input-resource-description').fill('Updated in isolated group admin fixture');
      await page.getByTestId('button-save-resource').click();
      await expect.poll(()=>page.evaluate(()=>window.fixture.writes.length)).toBe(1);
      expect(await page.evaluate(()=>window.fixture.writes[0])).toMatchObject({
        id:'future',description:'Updated in isolated group admin fixture',
      });
      await expect(page.getByTestId('dialog-create-resource')).toHaveCount(0);
    } else {
      expect(calls.some(c=>c.options.queryParams?.resource_context)).toBe(false);
      await expect(page.getByTestId('button-new-group-resource')).toHaveCount(0);
      await expect(page.getByTestId('button-edit-resource-released')).toHaveCount(0);
      expect(await page.evaluate(()=>window.fixture.writes)).toEqual([]);
    }
    expect(errors).toEqual([]);
    await fs.mkdir('screenshots',{recursive:true});
    await page.getByTestId('grid-group-resources').screenshot({path:`screenshots/task4691-group-${admin?'admin':'member'}-resources.png`});
  });
}

for (const specific of [false,true]) {
  test(`showcase ${specific?'specific':'latest'} uses only public reads`, async ({ page }) => {
    await mount(page, { mode:'showcase', specific });
    await expect(page.getByText('Released fixture resource', { exact:true })).toBeVisible();
    await expect(page.getByText('Scheduled fixture resource', { exact:true })).toHaveCount(0);
    expect(await page.evaluate(()=>window.fixture.calls.some(c=>c.name==='Resource'))).toBe(false);
  });
}

test('management requests explicit scope and displays scheduled resource', async ({ page }) => {
  await mount(page, { mode:'management' });
  await expect(page.getByText('Scheduled fixture resource', { exact:true })).toBeVisible();
  expect(await page.evaluate(()=>window.fixture.calls.find(c=>c.name==='Resource').options.queryParams)).toEqual({resource_context:'management'});
  await fs.mkdir('screenshots', { recursive:true });
  await page.screenshot({path:'screenshots/task4691-resource-release-management.png', fullPage:true});
});

test('scheduled embed denied by API shows no target link or management request', async ({page}) => {
  const requests=[];
  page.on('request',request=>requests.push(request.url()));
  await mount(page,{mode:'embed',guest:true});
  await expect(page.getByText('Resource not found',{exact:true})).toBeVisible();
  expect(requests.filter(url=>url.includes('/api/public/resource/'))).toEqual(['https://task4691.fixture.invalid/api/public/resource/future']);
  expect(requests.some(url=>url.includes('resource_context'))).toBe(false);
  await expect(page.locator('a[href*="example.invalid"]')).toHaveCount(0);
});

for (const timezoneId of ['Europe/London','America/New_York','Asia/Kolkata']) {
  test(`${timezoneId} datetime-local roundtrip preserves instant on reopen`, async ({ browser }) => {
    const context = await browser.newContext({timezoneId});
    const page = await context.newPage();
    try {
      await mount(page, {mode:'group'});
      const result = await page.evaluate(()=>{
        const instant='2026-07-15T12:34:56.789Z';
        const local=window.releaseTime.resourceReleaseLocalValue(instant);
        const input=document.createElement('input');input.type='datetime-local';input.value=local;document.body.appendChild(input);
        const saved=window.releaseTime.resourceReleaseInstant(input.value,instant);
        return {local,saved,reopened:window.releaseTime.resourceReleaseLocalValue(saved)};
      });
      expect(result.saved).toBe('2026-07-15T12:34:56.789Z');
      expect(result.reopened).toBe(result.local);
      expect(result.local).toBe({'Europe/London':'2026-07-15T13:34','America/New_York':'2026-07-15T08:34','Asia/Kolkata':'2026-07-15T18:04'}[timezoneId]);
    } finally { await context.close(); }
  });
}

test('actual editor unchanged save/reopen preserves scheduled instant in London', async ({ browser }) => {
  const context = await browser.newContext({timezoneId:'Europe/London'});
  const page = await context.newPage();
  try {
    await mount(page, {mode:'management'});
    await page.getByRole('button', {name:'Edit',exact:true}).last().click();
    await expect(page.locator('#release-date')).toHaveValue('2099-07-15T13:34');
    await page.getByRole('button', {name:'Update Resource',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.fixture.writes.length)).toBe(1);
    expect(await page.evaluate(()=>window.fixture.writes[0].release_date)).toBe('2099-07-15T12:34:56.789Z');
    await expect(page.locator('#release-date')).toHaveCount(0);
    await page.getByRole('button', {name:'Edit',exact:true}).last().click();
    await expect(page.locator('#release-date')).toHaveValue('2099-07-15T13:34');
    await fs.mkdir('screenshots', {recursive:true});
    await page.locator('#release-date').scrollIntoViewIfNeeded();
    await page.screenshot({path:'screenshots/task4691-resource-release-local-editor.png'});
  } finally { await context.close(); }
});
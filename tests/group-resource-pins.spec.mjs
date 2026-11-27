// Real group/library routes; all auth and transport are isolated fixtures.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': `export const base44=window.fixture.api;
      export const getActiveTenantId=()=> 'tenant';
      export const subscribeToActiveTenantId=()=>()=>{};`,
    '@/api/publicClient': `export const publicClient=window.fixture.publicApi;
      export const getTenantSlugFromLocation=()=> 'fixture';`,
    '../api/publicClient': 'export const publicClient=window.fixture.publicApi;',
    '@/api/supabaseClient': 'export const supabase=null; export const isSupabaseConfigured=false;',
    '@/hooks/useMemberAccess': `export const useMemberAccess=()=>({
      memberInfo:window.fixture.member,memberRole:{id:'role'},isAdmin:!!window.fixture.tenantAdmin,
      isAccessReady:true,isFeatureExcluded:()=>false});`,
    '@/contexts/LayoutContext': `export const useLayoutContext=()=>({
      authResolved:true,sessionValidated:true,memberInfo:window.fixture.member,hasBanner:false});
      export const usePageLayoutDecision=()=>{};`,
    '@/hooks/useMemberGroupSettings': `export const useMemberGroupSettings=()=>({
      eventsPerPage:6,resourcesPerPage:6,featureName:'Groups'});`,
    '@/contexts/TenantBrandingContext': 'export const useTenantBranding=()=>({});',
    '@/hooks/useResourceRealtime': 'export const useResourceRealtime=()=>{};',
    '../bookmarks/BookmarkButton': 'export default ()=>null;',
    '../TypographyStyleSelector': `export default ()=>null;
      export const applyTypographyStyle=()=>({});
      export const useTypographyStyles=()=>({getStyleById:()=>null});`,
  };
  const result = await build({
    stdin:{contents:`
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {BrowserRouter} from 'react-router-dom'; import {Toaster} from 'sonner';
      import Group from './client/src/pages/MemberGroupDetail.jsx';
      import Resources from './client/src/pages/Resources.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter>
        {window.fixture.library?<Resources/>:<Group/>}<Toaster/>
      </BrowserRouter></QueryClientProvider>);`,resolveDir:process.cwd(),loader:'jsx'},
    bundle:true,write:false,jsx:'automatic',alias:{'@':path.resolve('client/src'),'@shared':path.resolve('shared')},
    define:{'process.env.NODE_ENV':'"test"','import.meta.env':'{}'},
    plugins:[{name:'isolation',setup(b){
      b.onResolve({filter:/.*/},args=>args.path in mocks?{path:args.path,namespace:'fixture'}:null);
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:process.cwd()}));
    }}],
  });
  script=result.outputFiles[0].text;
});
async function mount(page, options={}) {
  let rows=options.rows || Array.from({length:20},(_,i)=>({
    id:`r${i}`,title:`Guide ${String(i).padStart(2,'0')}`,status:'active',
    created_date:new Date(Date.UTC(2026,0,20-i)).toISOString(),
    release_date:new Date(Date.UTC(2026,0,20-i)).toISOString(),
    member_group_id:'group',subcategories:['Linked'],is_public:true,
    resource_type:'external_link',target_url:'https://target.fixture.invalid',
    is_pinned:[0,2,19].includes(i),is_group_pinned:[18,19].includes(i),
  }));
  if (!options.rows) rows.push({...rows[0],id:'linked',title:'Tenant guide',member_group_id:null,is_pinned:true,is_group_pinned:true});
  let fail=false, count=0;
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    const json=(body,status=200)=>route.fulfill({status,json:body});
    if(url.pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:script});
    if(url.pathname==='/fixture-state')return json(rows);
    if(url.pathname==='/fixture-fail'){fail=true;return json({});}
    if(url.pathname==='/api/resources/group-pin'){
      count++;
      await new Promise(resolve=>setTimeout(resolve,150));
      if(fail)return json({error:'Fixture pin save failed'},503);
      const body=req.postDataJSON();
      expect(Object.keys(body).sort()).toEqual(['id','is_group_pinned']);
      rows=rows.map(r=>r.id===body.id?{...r,is_group_pinned:body.is_group_pinned}:r);
      return json(body);
    }
    if(url.pathname==='/api/resources/visible-categories')return json({categories:[],hiddenSubcategories:[]});
    if(url.pathname==='/api/resources/view-counts')return json({counts:{}});
    if(url.pathname.startsWith('/api/')){
      expect(req.method()).toBe('GET');
      return json([]);
    }
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/fixture.js"></script>'});
  });
  await page.addInitScript(options=>{
    const f=window.fixture={...options,member:{id:'member',email:'member@fixture.invalid',tenant_id:'tenant',first_name:'Fixture'}};
    const all=()=>fetch('/fixture-state').then(r=>r.json());
    f.api={auth:{me:async()=>f.member},entities:new Proxy({}, {get:(_,name)=>({
      list:async()=>[],
      listAll:async(opts={})=>name==='Resource'?(await all()).filter(r=>!opts.filter?.member_group_id || r.member_group_id===opts.filter.member_group_id):[],
      get:async()=>name==='MemberGroup'?{id:'group',name:'Fixture group',is_active:true,allow_self_join:true,resource_subcategories:['Linked']}:
        name==='Member'?f.member:{},
      filter:async()=>name==='MemberGroupAssignment'?[{id:'assignment',member_id:'member',group_id:'group',group_role:'Member',
        is_group_admin:!f.ordinary,expires_at:f.expired?'2000-01-01':null}]:[],
    })})};
    // Main library discovers the same group subcategory association.
    // Proxy returns fresh entity objects, so dispatch lists inside an override.
    const entities=f.api.entities;
    f.api.entities=new Proxy({}, {get:(_,name)=>{
      const entity=entities[name];
      if(name==='MemberGroup')entity.list=async()=>[{id:'group',resource_subcategories:['Linked']}];
      return entity;
    }});
    f.publicApi={getTenantSlug:()=> 'fixture',listSystemSettings:async()=>[],listForms:async()=>[]};
  },options);
  await page.goto(`https://group-pins.fixture.invalid/${options.library?'Resources':'MemberGroupDetail?id=group'}`);
  return {errors,count:()=>count,rows:()=>rows};
}
const titles=page=>page.getByTestId('grid-group-resources').getByText(/^(Guide \d{2}|Tenant guide)$/);
test('group pins survive reload and other viewers; pending/error states and later-page pinning stay honest',async({page,browser})=>{
  const f=await mount(page);
  await expect(titles(page).first()).toHaveText('Guide 18');
  expect((await titles(page).allTextContents()).slice(0,3)).toEqual(['Guide 18','Guide 19','Guide 00']);
  await page.getByTestId('button-group-pin-r18').click();
  await expect(page.getByTestId('button-group-pin-r19')).toBeDisabled();
  await expect(titles(page).first()).toHaveText('Guide 19');
  expect(f.count()).toBe(1);
  await page.reload();
  await expect(titles(page).first()).toHaveText('Guide 19');
  // Resource 04 starts on the next page after the remaining pin.
  await page.getByTestId('pagination-resources').getByRole('button').last().click();
  const target=page.getByTestId('grid-group-resources').getByRole('button',{name:/^Pin Guide .* in group$/}).first();
  const label=await target.getAttribute('aria-label');
  await target.click();
  await expect(page.getByTestId('pagination-resources')).toContainText('1');
  const pinnedTitle=label.replace('Pin ','').replace(' in group','');
  await expect(titles(page)).toContainText([pinnedTitle]);
  await page.evaluate(()=>fetch('/fixture-fail'));
  const pin=page.getByTestId('button-group-pin-r19');
  await pin.click();
  await expect(page.getByText('Fixture pin save failed')).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed','true');
  await expect(pin).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('button-group-pin-r19')).toHaveAttribute('aria-pressed','true');
  const observer = await browser.newPage();
  try {
    await mount(observer,{ordinary:true,rows:f.rows()});
    await expect(titles(observer)).toContainText([pinnedTitle]);
    await expect(observer.getByTestId('group-pinned-r19')).toBeVisible();
    await expect(observer.getByRole('button',{name:/^(Pin|Unpin) .* in group$/})).toHaveCount(0);
  } finally { await observer.close(); }
  expect(f.errors).toEqual([]);
});
for(const options of [{ordinary:true},{expired:true},{tenantAdmin:true,ordinary:true}]){
  test(`controls respect admin eligibility ${JSON.stringify(options)}`,async({page})=>{
    const f=await mount(page,options);
    await expect(titles(page).first()).toHaveText('Guide 18');
    const canPin=!!options.tenantAdmin;
    await expect(page.getByTestId('grid-group-resources').getByRole('button',{name:/^(Pin|Unpin) .* in group$/})).toHaveCount(canPin?5:0);
    expect(f.errors).toEqual([]);
  });
}
test('linked tenant cards stay read-only and search/sort never promote excluded records',async({page})=>{
  await mount(page);
  for (const [label,first] of [['Date (oldest first)','Guide 19'],['Name (A–Z)','Guide 18'],['Name (Z–A)','Guide 19'],['Date (newest first)','Guide 18']]) {
    await page.getByTestId('select-resource-sort').click();
    await page.getByRole('option',{name:label,exact:true}).click();
    await expect(titles(page).first()).toHaveText(first);
  }
  await page.getByTestId('input-search-resources').fill('Tenant guide');
  await expect(titles(page)).toHaveText(['Tenant guide']);
  await expect(page.getByTestId('button-group-pin-linked')).toHaveCount(0);
  await expect(page.getByTestId('button-edit-resource-linked')).toHaveCount(0);
  await expect(page.getByTestId('group-pinned-linked')).toHaveCount(0);
});
test('main library ignores group records with either or both flags while tenant pins retain priority',async({page})=>{
  const f=await mount(page,{library:true});
  const guideTitles=page.getByText(/^(Guide \d{2}|Tenant guide)$/);
  await expect(guideTitles.first()).toHaveText('Tenant guide');
  expect((await guideTitles.allTextContents()).slice(0,5)).toEqual(['Tenant guide','Guide 00','Guide 01','Guide 02','Guide 03']);
  await expect(page.getByRole('button',{name:/^(Pin|Unpin) .* in group$/})).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

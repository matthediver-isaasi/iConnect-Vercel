// Actual route components with isolated auth/transport. No live tenant requests.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': 'export const base44=window.fixture.api;',
    '@/api/publicClient': 'export const publicClient=window.fixture.publicApi;',
    '../api/publicClient': 'export const publicClient=window.fixture.publicApi;',
    '@/api/supabaseClient': 'export const supabase=null; export const isSupabaseConfigured=false;',
    '@/hooks/useMemberAccess': `export const useMemberAccess=()=>({
      memberInfo:window.fixture.member,memberRole:{id:'role'},isAdmin:false,
      isAccessReady:true,isFeatureExcluded:()=>false});`,
    '@/contexts/LayoutContext': `export const useLayoutContext=()=>({
      authResolved:true,sessionValidated:!!window.fixture.member,hasBanner:false});`,
    '@/contexts/TenantBrandingContext': 'export const useTenantBranding=()=>({});',
    '@/hooks/useResourceRealtime': 'export const useResourceRealtime=()=>{};',
    '../bookmarks/BookmarkButton': 'export default ()=>null;',
    '../TypographyStyleSelector': `export default ()=>null;
      export const applyTypographyStyle=()=>({});
      export const useTypographyStyles=()=>({getStyleById:()=>null});`,
  };
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {BrowserRouter} from 'react-router-dom'; import {Toaster} from 'sonner';
      import Resources from './client/src/pages/Resources.jsx';
      import Management from './client/src/pages/ResourceManagement.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
        <BrowserRouter>{window.fixture.management?<Management/>:<Resources/>}</BrowserRouter><Toaster/>
      </QueryClientProvider>);`, resolveDir:process.cwd(), loader:'jsx' },
    bundle:true,write:false,jsx:'automatic',alias:{'@':path.resolve('client/src')},
    define:{'process.env.NODE_ENV':'"test"'},
    plugins:[{name:'isolation',setup(b) {
      b.onResolve({filter:/.*/},args=>args.path in mocks?{path:args.path,namespace:'fixture'}:null);
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'jsx',resolveDir:process.cwd()}));
    }}],
  });
  script=result.outputFiles[0].text;
});

async function mount(page, options={}) {
  const rows=Array.from({length:26},(_,i)=>({
    id:`r${i}`,title:`Resource ${String(i).padStart(2,'0')}`,status:'active',
    release_date:new Date(Date.UTC(2026,0,26-i)).toISOString(),resource_type:'external_link',
    target_url:'https://example.invalid',is_public:true,subcategories:['Visible'],
    is_pinned:[20,24].includes(i),
  }));
  rows.push(
    {...rows[0],id:'folder',title:'Folder-only pin',folder_id:'other',is_pinned:true},
    {...rows[0],id:'private',title:'Group-private pin',member_group_id:'group',is_pinned:true},
    {...rows[0],id:'draft',title:'Draft pin',status:'draft',is_pinned:true},
    {...rows[0],id:'future',title:'Scheduled pin',release_date:'2099-01-01',is_pinned:true},
    {...rows[0],id:'role',title:'Role-hidden pin',is_public:false,allowed_role_ids:['other'],is_pinned:true},
  );
  let saved=rows;
  let fail=false;
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:script});
    if(url.pathname==='/fixture-state')return json(saved);
    if(url.pathname==='/api/resources/pin') {
      if(fail)return json({error:'Fixture save failed'},503);
      const body=req.postDataJSON();
      saved=saved.map(r=>r.id===body.id?{...r,is_pinned:body.is_pinned}:r);
      return json(body);
    }
    if(url.pathname==='/fixture-fail'){fail=true;return json({});}
    if(url.pathname==='/fixture-edit') {
      const {id,...body}=req.postDataJSON();
      // Match the generic write boundary: pin snapshots are never applied.
      delete body.is_pinned;
      saved=saved.map(r=>r.id===id?{...r,...body}:r); return json(body);
    }
    if(url.pathname==='/api/resources/visible-categories')return json({categories:[],hiddenSubcategories:[]});
    if(url.pathname==='/api/resources/view-counts')return json({counts:{}});
    if(url.pathname.startsWith('/api/')) {
      expect(req.method()).toBe('GET');
      return json([]);
    }
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/fixture.js"></script>'});
  });
  await page.addInitScript(options=>{
    const f=window.fixture={...options,member:options.guest?null:{id:'member',tenant_id:'tenant',email:'member@fixture.invalid'}};
    const all=async()=>fetch('/fixture-state').then(r=>r.json());
    const eligible=rows=>rows.filter(r=>r.status!=='draft' && !r.member_group_id && Date.parse(r.release_date)<Date.now());
    f.api={
      auth:{me:async()=>f.member},
      entities:new Proxy({}, {get:(_,name)=>({
        list:async()=>name==='Resource'?eligible(await all()):[],
        listAll:async(options)=>name==='Resource'?
          (options.queryParams?.resource_context==='management'?await all():eligible(await all())):[],
        filter:async()=>[], get:async()=>({}),
        update:async(id,body)=>fetch('/fixture-edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,...body})}).then(r=>r.json()),
      })}),
    };
    f.publicApi={getTenantSlug:()=> 'fixture', listResources:async()=>eligible(await all()).filter(r=>r.id!=='role'),
      listResourceCategories:async()=>[],getResourceAuthorSettings:async()=>({})};
  },options);
  await page.goto(`https://resource-pins.fixture.invalid/${options.management?'ResourceManagement':'Resources'}${options.query||''}`);
}
const titles=page=>page.getByText(/^Resource \d{2}$/);

for(const guest of [true,false]) {
  test(`${guest?'guest':'member'} route pins matching results across pages and preserves sort modes`,async({page})=>{
    await mount(page,{guest});
    await expect(titles(page).first()).toHaveText('Resource 20');
    expect((await titles(page).allTextContents()).slice(0,3)).toEqual(['Resource 20','Resource 24','Resource 00']);
    await expect(page.getByRole('button',{name:/^(Unpin|Pin) /})).toHaveCount(0);
    for(const label of ['Scheduled pin','Draft pin','Group-private pin','Role-hidden pin'])await expect(page.getByText(label,{exact:true})).toHaveCount(0);
    for(const [label,first] of [['Oldest First','Resource 24'],['Title A-Z','Resource 20'],['Title Z-A','Resource 24'],['Newest First','Resource 20']]) {
      await page.getByRole('combobox').filter({hasText:/Newest First|Oldest First|Title A-Z|Title Z-A/}).click();
      await page.getByRole('option',{name:label,exact:true}).click();
      await expect(titles(page).first()).toHaveText(first);
    }
  });
  test(`${guest?'guest':'member'} deep-linked search excludes nonmatching pins`,async({page})=>{
    await mount(page,{guest,query:'?search=Resource%2003'});
    await expect(titles(page)).toHaveText(['Resource 03']);
  });
}
test('management pin action returns to first page, persists reload, unpins and retains pin through edit',async({page})=>{
  await mount(page,{management:true});
  await expect(titles(page).first()).toHaveText('Resource 20');
  await expect(page.getByText('Folder-only pin',{exact:true})).toHaveCount(0);
  // Pin a resource beyond page one, then verify reordering before pagination.
  await page.getByRole('button',{name:'2',exact:true}).click();
  const button=page.getByRole('button',{name:/^Pin Resource /}).first();
  const name=(await button.getAttribute('aria-label')).replace('Pin ','');
  await button.click();
  await expect(page.getByRole('button',{name:`Unpin ${name}`,exact:true})).toBeVisible();
  await expect(page.getByText(/Showing 1-9 of/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{name:`Unpin ${name}`,exact:true})).toBeVisible();
  const card=page.getByRole('button',{name:`Unpin ${name}`,exact:true}).locator('xpath=ancestor::div[contains(@class,"shadow-sm")][1]');
  await card.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('button',{name:'Update Resource',exact:true}).click();
  await expect(page.getByRole('button',{name:`Unpin ${name}`,exact:true})).toBeVisible();
  await page.getByRole('button',{name:`Unpin ${name}`,exact:true}).click();
  await expect(page.getByText('Resource unpinned',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{name:`Unpin ${name}`,exact:true})).toHaveCount(0);
});
test('failed management save reports error without a false pin',async({page})=>{
  await mount(page,{management:true});
  await page.evaluate(()=>fetch('/fixture-fail'));
  await page.getByRole('button',{name:'Pin Resource 00',exact:true}).click();
  await expect(page.getByText('Fixture save failed',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Pin Resource 00',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.reload();
  await expect(page.getByRole('button',{name:'Pin Resource 00',exact:true})).toHaveAttribute('aria-pressed','false');
});

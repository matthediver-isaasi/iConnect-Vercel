import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const font = readFileSync(new URL('./fixtures/layout-fonts/jakarta.ttf', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = (id, type, x, y, w, h, content) => ({ id, type,
  bp: { desktop: { x,y,w,h }, tablet: { x,y,w: Math.min(w,700),h }, mobile: { x:0,y,w:350,h } },
  content, style: {} });
// Representative V1 hero: exact published desktop headline/description/label/
// icon/CTA coordinates. Typography is controlled (including size-adjust) to
// reliably cross a wrap boundary on Linux; this is not a live-page snapshot.
function record(slug) {
  return { id:slug, slug, title:slug, status:'published', builder_type:'canvas',
    layout_type:'public', public_chrome:'none', hide_chrome:true,
    canvas_design: { version:1, root:{ sections:[{ id:'root', children:[
      block('heading','text',21,29,560,91,{html:'<p style="font:48px/1.2 \'Plus Jakarta Sans\',sans-serif">Book</p>'}),
      block('description','text',21,120,480,149,{typographyStyleId:'description-style',html:'<p>Join the largest gathering of higher education careers and employability leaders from across the UK and Ireland.</p>'}),
      block('date','text',56,269,192,58,{html:'<p style="font:20px/1.4 \'Plus Jakarta Sans\',sans-serif">11–13 January 2027</p>'}),
      block('location','text',312,269,192,58,{html:'<p style="font:20px/1.4 \'Plus Jakarta Sans\',sans-serif">Dublin, Ireland</p>'}),
      block('date-icon','image',8,264,48,40,{iconClass:'calendar-days',iconSize:25}),
      block('location-icon','image',264,264,48,40,{iconClass:'map-pin',iconSize:25}),
      block('cta','button',16,334,240,51,{label:'Browse next page',href:slug==='book'?'/other':'/book'}),
      block('accordion','accordion',0,500,600,160,{items:[{q:'Question',a:'<p style="height:240px">An expanded answer</p>'}]}),
      block('below','image',0,690,48,40,{iconClass:'map-pin',iconSize:25}),
      block('card-a','card',0,1000,400,180,{title:'Card A',body:'<p>Initial card body</p>'}),
      block('card-b','card',440,1000,400,180,{title:'Card B',body:'<p>Initial card body</p>'}),
      block('after-cards','image',0,1220,48,40,{iconClass:'map-pin',iconSize:25}),
    ]}] } } };
}
async function fixture(page, { delay = 0, fail = false, failCss = false, failDiscovery = false, seeded = false } = {}) {
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5002';
  const typography = [{id:'description-style',style_type:'h4',font_family:"'Plus Jakarta Sans', sans-serif",font_size:23,font_weight:seeded ? 400 : 600,line_height:1.35,margin_bottom:24,is_active:true}];
  if (seeded) await page.addInitScript(styles => { window.__TENANT_TYPOGRAPHY_STYLES__=styles; }, typography);
  const state = { discovery:false, css:false, download:false, writes:[] };
  await page.route('**/*', async route => {
    const req=route.request(), u=new URL(req.url());
    const json = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(u.hostname==='fonts.googleapis.com') {
      if (!u.search.includes('family=Plus')) return route.fulfill({contentType:'text/css',body:''});
      state.css=true; await sleep(delay);
      if (failCss) return route.abort();
      return route.fulfill({contentType:'text/css',body:`@font-face{font-family:'Plus Jakarta Sans';font-weight:100 900;src:url('${origin}/fixture-font.ttf');font-display:swap;size-adjust:140%}`});
    }
    if(u.pathname==='/fixture-font.ttf') {
      state.download=true; await sleep(delay);
      return fail ? route.abort() : route.fulfill({contentType:'font/ttf',body:font});
    }
    if (!u.pathname.startsWith('/api/')) {
      if(u.origin!==new URL(origin).origin) return route.fulfill({status:204,body:''});
      return route.continue();
    }
    if(req.method()!=='GET') state.writes.push(req.method()+' '+u.pathname);
    if(u.pathname==='/api/public/installed-fonts') {
      state.discovery=true; await sleep(delay);
      if (failDiscovery) return route.fulfill({status:503,body:'{}',contentType:'application/json'});
      return json([{label:'Plus Jakarta Sans',font_stack:"'Plus Jakarta Sans',sans-serif",google_family:'Plus+Jakarta+Sans'}]);
    }
    if(u.pathname==='/api/auth/me'||u.pathname==='/api/auth/tenant-user-me') return route.fulfill({status:401,body:'{}',contentType:'application/json'});
    if(u.pathname==='/api/public/tenant-branding') return json({success:true,branding:{id:'fixture',headerConfig:{},footerConfig:{},platformBranding:{enabled:false}}});
    if(u.pathname==='/api/public/portal-branding') return json({homePageSlug:'book'});
    if(u.pathname==='/api/public/typography-styles'||u.pathname==='/api/entities/TypographyStyle') return json(typography);
    if(u.pathname==='/api/public/microsites') return json({microsites:[]});
    if(u.pathname.startsWith('/api/public/page/')) return json({success:true,page:record(u.pathname.split('/').pop()),elements:[],symbols:[]});
    if(u.pathname==='/api/tenant-canvas-theme') return json({theme:null});
    if(u.pathname==='/api/public/canvas-symbols') return json({symbols:[]});
    if(u.pathname.startsWith('/api/redirects/resolve')) return json({found:false});
    return json([]);
  });
  return state;
}
async function geometry(page) {
  return page.locator('[data-block-id]').evaluateAll(nodes => Object.fromEntries(nodes.map(n=>[n.dataset.blockId,Math.round(n.getBoundingClientRect().top)])));
}
test('late discovery, stylesheet and download recover identical hero geometry without refresh', async ({page}) => {
  const state=await fixture(page,{delay:1700});
  await page.goto('/book');
  await expect(page.locator('[data-block-id="heading"]')).toBeVisible();
  // Font readiness initially resolves before tenant CSS registration.
  await page.evaluate(()=>document.fonts.ready);
  await expect.poll(()=>state.download).toBe(true);
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await page.waitForTimeout(200);
  const cold=await geometry(page);
  await page.reload();
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await page.waitForTimeout(200);
  const reload=await geometry(page);
  await page.getByRole('link',{name:'Browse next page'}).click();
  await expect(page).toHaveURL(/\/other$/);
  const warm=await geometry(page);
  console.log('LAYOUT_GEOMETRY',JSON.stringify({cold,reload,warm}));
  expect(cold).toEqual(warm);
  expect(reload).toEqual(warm);
  expect(cold.date-cold['date-icon']).toBe(5);
  expect(cold.location-cold['location-icon']).toBe(5);
  expect(cold.cta).toBe(334);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await page.reload();
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await expect.poll(()=>geometry(page)).toEqual(warm);
  await cdp.detach();
  const before=warm.below;
  await page.getByRole('button',{name:'Question'}).click();
  await expect.poll(async()=> (await geometry(page)).below).toBeGreaterThan(before);
  await page.getByRole('button',{name:'Question'}).click();
  await expect.poll(async()=> (await geometry(page)).below).toBe(before);
  await page.setViewportSize({width:390,height:844});
  await page.setViewportSize({width:1440,height:900});
  await expect.poll(()=>geometry(page)).toEqual(warm);
  expect(state.writes).toEqual([]);
});
for (const failure of ['failCss','failDiscovery']) {
  test(`${failure} never gates content or leaves phantom offsets`,async({page})=>{
    await fixture(page,{delay:1700,[failure]:true});
    await page.goto('/book');
    await expect(page.locator('[data-block-id="heading"]')).toBeVisible();
    await page.waitForTimeout(5500);
    const g=await geometry(page);
    expect(g.cta).toBe(334);
    expect(g.date-g['date-icon']).toBe(5);
  });
}
test('successful late fonts do not capture a user-expanded accordion as baseline',async({page})=>{
  await fixture(page,{delay:1700});
  await page.goto('/book');
  await page.getByRole('button',{name:'Question'}).click();
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  const expanded=await geometry(page);
  expect(expanded.below).toBeGreaterThan(690);
  await page.getByRole('button',{name:'Question'}).click();
  await expect.poll(async()=> (await geometry(page)).below).toBe(690);
});
test('card growth and row equality survive unrelated font completion',async({page})=>{
  await fixture(page);
  await page.goto('/book');
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  const initial=(await geometry(page))['after-cards'];
  await page.locator('[data-block-id="card-a"] p').evaluate(node=>{node.textContent='Longer dynamic card content. '.repeat(100);});
  await expect.poll(async()=> (await geometry(page))['after-cards']).toBeGreaterThan(initial);
  const grown=(await geometry(page))['after-cards'];
  const heights=await page.locator('[data-block-type="card"]').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
  expect(Math.abs(heights[0]-heights[1])).toBeLessThan(2);
  await page.evaluate(()=>document.fonts.dispatchEvent(new Event('loadingdone')));
  await page.waitForTimeout(200);
  expect((await geometry(page))['after-cards']).toBe(grown);
});
test('font arrival alone repairs the baseline with typography already present',async({page})=>{
  await fixture(page,{delay:1700,seeded:true});
  await page.goto('/book');
  await expect(page.locator('[data-block-id="description"]')).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  const fallback=await page.locator('[data-block-id="description"]').evaluate(n=>n.getBoundingClientRect().height);
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await page.waitForTimeout(200);
  const final=await page.locator('[data-block-id="description"]').evaluate(n=>n.getBoundingClientRect().height);
  console.log('FONT_ONLY',JSON.stringify({fallback,final,geometry:await geometry(page)}));
  expect(final).toBeGreaterThan(fallback);
  const g=await geometry(page);
  expect(g.date-g['date-icon']).toBe(5);
  expect(g.cta).toBe(334);
});
test('a relevant late font preserves growth from earlier card content changes',async({page})=>{
  await fixture(page,{delay:1700});
  await page.goto('/book');
  const card=page.locator('[data-block-id="card-a"]');
  await expect(card).toBeVisible();
  await card.locator('p').evaluate(node=>{node.style.fontFamily="'Plus Jakarta Sans', sans-serif";});
  await page.waitForTimeout(200);
  const before=(await geometry(page))['after-cards'];
  await card.locator('p').evaluate(node=>{node.textContent='Dynamic content before the font arrives. '.repeat(90);});
  await expect.poll(async()=> (await geometry(page))['after-cards']).toBeGreaterThan(before);
  const grown=(await geometry(page))['after-cards'];
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await page.waitForTimeout(200);
  console.log('GROWN_CARD',await card.evaluate(n=>({height:n.getBoundingClientRect().height,textLength:n.querySelector('p')?.textContent.length})), {grown, final:(await geometry(page))['after-cards']});
  expect((await geometry(page))['after-cards']).toBeGreaterThanOrEqual(grown);
  const [cardBottom, nextTop]=await page.evaluate(()=>[
    document.querySelector('[data-block-id="card-a"]').getBoundingClientRect().bottom,
    document.querySelector('[data-block-id="after-cards"]').getBoundingClientRect().top,
  ]);
  expect(nextTop).toBeGreaterThanOrEqual(cardBottom);
});
test('margin-only typography arrival remeasures even without border-box resize',async({page})=>{
  await fixture(page,{seeded:true});
  await page.goto('/book');
  await page.waitForFunction(()=>[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded'));
  await page.waitForTimeout(200);
  const root=page.locator('[data-block-id="description"] [data-tg-r="text-root"]');
  const h=await root.evaluate(n=>n.getBoundingClientRect().height);
  const before=(await geometry(page)).cta;
  await root.evaluate(n=>{n.style.marginBottom='120px';});
  expect(await root.evaluate(n=>n.getBoundingClientRect().height)).toBe(h);
  await expect.poll(async()=> (await geometry(page)).cta).toBeGreaterThan(before);
  await root.evaluate(n=>{n.style.marginBottom='24px';});
  await expect.poll(async()=> (await geometry(page)).cta).toBe(before);
});
test('failed late download leaves content usable and expansion reversible',async({page})=>{
  await fixture(page,{delay:1500,fail:true});
  await page.goto('/book');
  await expect(page.locator('[data-block-id="heading"]')).toBeVisible();
  await page.getByRole('button',{name:'Question'}).click();
  await page.waitForTimeout(5200);
  const expanded=await geometry(page);
  await page.getByRole('button',{name:'Question'}).click();
  await expect.poll(async()=> (await geometry(page)).below).toBeLessThan(expanded.below);
  await expect(page.locator('[data-block-id="cta"]')).toBeVisible();
});

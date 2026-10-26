import { test, expect } from '@playwright/test';

async function mount(page, request, surface = 'public', version = 1) {
  const response = await request.get('/src/components/canvas/CanvasBuilder.jsx');
  const source = await response.text();
  const react = source.match(/from\s+"([^"]*\/\.vite\/deps\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('Running Vite app required');
  const dep = name => react.replace(/react\.js\?/, `${name}.js?`);
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  await page.route('**/*', route => new URL(route.request().url()).pathname.startsWith('/api/')
    ? route.fulfill({ contentType: 'application/json', body: '[]' })
    : route.continue());
  await page.route('**/__testimonials-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/index.css');
      const React = (await import(${JSON.stringify(react)})).default;
      const {createRoot} = (await import(${JSON.stringify(dep('react-dom_client'))})).default;
      const {QueryClient, QueryClientProvider} = await import(${JSON.stringify(dep('@tanstack_react-query'))});
      const {MemoryRouter} = await import(${JSON.stringify(dep('react-router-dom'))});
      const {getBlockDefinition} = await import('/src/components/canvas/blocks/registry.jsx');
      const {createBlock, normalizeCanvasDesign} = await import('/src/lib/canvasDesign.js');
      const {default: CanvasStage} = await import('/src/components/canvas/CanvasStage.jsx');
      const {default: CanvasFlowEditorStage} = await import('/src/components/canvas/CanvasFlowEditorStage.jsx');
      const {default: CanvasPageRenderer} = await import('/src/components/canvas/CanvasPageRenderer.jsx');
      const h = React.createElement;
      const initial = createBlock('testimonials', {id:'quotes'});
      initial.bp.desktop = {x:0,y:0,w:1200,h:280};
      initial.content = {...initial.content, layout:'carousel', carousel:{perPage:{desktop:3,tablet:2,mobile:1},loop:false},
        items:Array.from({length:7},(_,i)=>({quote:'Quote '+(i+1)+' — '+ 'A longer testimonial. '.repeat(i===2?35:3),author:'Author '+(i+1)}))};
      const saved = localStorage.getItem('testimonials-fixture');
      function App() {
        const [block,setBlock] = React.useState(saved ? JSON.parse(saved) : initial);
        const [width,setWidth] = React.useState(1200);
        window.resizeFixture = setWidth;
        window.changeFixture = patch => setBlock(b=>({...b,content:{...b.content,...patch}}));
        window.saveFixture = () => localStorage.setItem('testimonials-fixture',JSON.stringify(block));
        const def = getBlockDefinition('testimonials');
        const positioned = {...block,bp:{...block.bp,desktop:{...block.bp.desktop,w:width}}};
        const design = normalizeCanvasDesign(${version}===1
          ? {version:1,root:{sections:[{id:'root',children:[positioned]}]}}
          : {version:2,root:{sections:[{id:'root',type:'section',flow:{padTop:0,padBottom:0,padLeft:0,padRight:0},children:[{...positioned,flow:{heightMode:'fixed',height:280}}]}]}});
        return h('div',null,
          h('div',{style:{width,transform:'scale(0.8)',transformOrigin:'top left'},'data-testid':'fixture-stage'},
            ${JSON.stringify(surface)}==='editor'
              ? (${version}===1
                ? h(CanvasStage,{blocks:[positioned],selectedIds:[],breakpoint:'desktop',canvasWidth:width,canvasHeight:300,onSelect:()=>window.selected=true,onApplyGeometry:()=>{},showGrid:false})
                : h(CanvasFlowEditorStage,{design,canvasWidth:width,canvasHeight:300,onSelect:()=>window.selected=true,showGrid:false}))
              : h(CanvasPageRenderer,{page:{id:'fixture',canvas_design:design},symbols:[],embedded:true})),
          ${JSON.stringify(surface)}==='editor' && h('div',{style:{width:300,marginTop:40}},h(def.Inspector,{block,update:fn=>setBlock(fn)})));
      }
      window.__TENANT_TYPOGRAPHY_STYLES__=[];
      createRoot(document.getElementById('root')).render(h(MemoryRouter,null,h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},h(App))));
    </script></body></html>`,
  }));
  await page.goto('/__testimonials-fixture');
  await expect(page.getByTestId('testimonials-carousel')).toBeVisible({ timeout: 20000 });
  return errors;
}

for (const version of [1, 2]) {
  test(`v${version} public sizing, partial page, keyboard, touch, long quotes and reduced motion`, async ({ page, request }) => {
    const errors = await mount(page, request, 'public', version);
    const carousel = page.getByTestId('testimonials-carousel');
    await expect(carousel).toHaveAttribute('data-per-page', '3');
    await page.getByRole('button', { name: 'Next testimonials' }).click();
    await page.getByRole('button', { name: 'Next testimonials' }).click();
    await expect(carousel).toHaveAttribute('data-page', '3');
    await expect(page.getByRole('group', { name: 'Page 3 of 3' })).toContainText('Quote 7');
    await expect(page.getByRole('button', { name: 'Next testimonials' })).toBeDisabled();
    await carousel.focus();
    await page.keyboard.press('Home');
    await expect(carousel).toHaveAttribute('data-page', '1');
    await page.evaluate(() => window.resizeFixture(700));
    await expect(carousel).toHaveAttribute('data-per-page', '2');
    await page.evaluate(() => window.resizeFixture(375));
    await expect(carousel).toHaveAttribute('data-per-page', '1');
    await carousel.evaluate(el => {
      const touch = x => new Touch({ identifier: 1, target: el, clientX: x, clientY: 100 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(200)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(50)] }));
    });
    await expect(carousel).toHaveAttribute('data-page', '2');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.changeFixture({ carousel: { autoplaySeconds: 1 } }));
    await page.mouse.click(1400, 900);
    await page.waitForTimeout(1200);
    await expect(carousel).toHaveAttribute('data-page', '2');
    const sizes = await carousel.evaluate(el => ({
      outer: el.getBoundingClientRect().height,
      nav: el.querySelector('[aria-label="Testimonial navigation"]').getBoundingClientRect().bottom - el.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(sizes.nav).toBeLessThanOrEqual(sizes.outer + 1);
    expect(sizes.overflow).toBe(false);
    await page.screenshot({ path: `test-results/testimonials-carousel/public-v${version}.png` });
    expect(errors).toEqual([]);
  });
  test(`v${version} editor controls persist, selection remains safe and legacy layouts remain unchanged`, async ({ page, request }) => {
    const errors = await mount(page, request, 'editor', version);
    const carousel = page.getByTestId('testimonials-carousel');
    await page.getByTestId('testimonials-per-page-mobile').fill('2');
    await page.getByTestId('testimonials-autoplay').fill('1');
    await page.evaluate(() => { window.saveFixture(); window.resizeFixture(375); });
    await expect(carousel).toHaveAttribute('data-per-page', '2');
    await page.waitForTimeout(1200);
    await expect(carousel).toHaveAttribute('data-page', '1');
    await page.getByTestId('fixture-stage').click({ position: { x: 30, y: 30 } });
    expect(await page.evaluate(() => window.selected)).toBe(true);
    await page.reload();
    await expect(page.getByTestId('testimonials-per-page-mobile')).toHaveValue('2');
    await expect(page.getByTestId('testimonials-autoplay')).toHaveValue('1');
    await page.evaluate(() => window.changeFixture({ layout: 'grid' }));
    await expect(carousel).toHaveCount(0);
    await expect(page.locator('figure')).toHaveCount(7);
    await page.evaluate(() => window.changeFixture({ layout: 'single' }));
    await expect(page.locator('figure')).toHaveCount(7);
    await page.evaluate(() => window.changeFixture({ layout: 'carousel', carousel: undefined }));
    await expect(carousel).toHaveCount(0);
    await expect(page.locator('figure').first()).toHaveCSS('min-width', '240px');
    expect(errors).toEqual([]);
  });
}

test('public autoplay pauses on hover and focus, resumes, loops, and stops at the non-looping end', async ({ page, request }) => {
  await mount(page, request);
  const carousel = page.getByTestId('testimonials-carousel');
  await page.clock.install();
  await page.evaluate(() => window.changeFixture({ carousel: { autoplaySeconds: 1, loop: true } }));
  await page.mouse.move(1400, 900);
  await page.clock.runFor(1100);
  await expect(carousel).toHaveAttribute('data-page', '2');
  await carousel.hover();
  await page.clock.runFor(2100);
  await expect(carousel).toHaveAttribute('data-page', '2');
  await page.mouse.move(1400, 900);
  await page.clock.runFor(1100);
  await expect(carousel).toHaveAttribute('data-page', '3');
  await carousel.focus();
  await page.clock.runFor(2100);
  await expect(carousel).toHaveAttribute('data-page', '3');
  await carousel.evaluate(el => el.blur());
  await page.clock.runFor(1100);
  await expect(carousel).toHaveAttribute('data-page', '1');
  await page.evaluate(() => window.changeFixture({ carousel: { autoplaySeconds: 1, loop: false }, fullBleed: true }));
  await page.clock.runFor(4500);
  await expect(carousel).toHaveAttribute('data-page', '3');
  await expect(page.getByRole('button', { name: 'Next testimonials' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('long quote scrolling resets on navigation and many mobile dots stay within the frame', async ({ page, request }) => {
  await mount(page, request);
  await page.evaluate(() => {
    window.resizeFixture(375);
    window.changeFixture({
      carousel: { perPage: { mobile: 1 } },
      items: Array.from({ length: 80 }, (_, i) => ({ quote: i === 0 ? 'Long quote. '.repeat(500) : 'Short quote', author: `Author ${i}` })),
    });
  });
  const carousel = page.getByTestId('testimonials-carousel');
  await expect(carousel).toHaveAttribute('data-per-page', '1');
  const viewport = page.getByTestId('testimonials-quote-viewport');
  await viewport.evaluate(el => { el.scrollTop = 500; });
  expect(await viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Go to testimonials page 2', exact: true }).click();
  await expect(carousel).toHaveAttribute('data-page', '2');
  expect(await viewport.evaluate(el => el.scrollTop)).toBe(0);
  const geometry = await carousel.evaluate(el => {
    const nav = el.querySelector('[aria-label="Testimonial navigation"]');
    const quotes = el.querySelector('[data-testid="testimonials-quote-viewport"]');
    return { height: el.clientHeight, footer: nav.clientHeight, quotes: quotes.clientHeight,
      bottom: nav.getBoundingClientRect().bottom, frameBottom: el.getBoundingClientRect().bottom };
  });
  expect(geometry.footer).toBeLessThanOrEqual(geometry.height * .4 + 1);
  expect(geometry.quotes).toBeGreaterThan(geometry.height * .5);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.frameBottom + 1);
  await page.getByRole('button', { name: 'Go to testimonials page 80', exact: true }).click();
  await expect(carousel).toHaveAttribute('data-page', '80');
});

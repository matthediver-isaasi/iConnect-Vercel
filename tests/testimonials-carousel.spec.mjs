import { test, expect } from '@playwright/test';
import axe from 'axe-core';

for (const version of [1, 2]) {
  test(`v${version} main landmark ownership preserves Canvas geometry and skip target`, async ({ page, request }) => {
    await mount(page, request, 'public', version, false, true);
    const stage = page.locator('#canvas-main-content');
    await expect(stage).toHaveJSProperty('tagName', 'MAIN');
    const before = await stage.boundingBox();
    await page.evaluate(() => window.toggleShell(true));
    await expect(stage).toHaveJSProperty('tagName', 'DIV');
    await expect(page.locator('main')).toHaveCount(1);
    expect(await stage.boundingBox()).toEqual(before);
    await expect(stage).toHaveAttribute('tabindex', '-1');
    await page.getByTestId('link-skip-to-content').focus();
    await page.keyboard.press('Enter');
    await expect(stage).toBeFocused();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => (await window.axe.run(document, {
      runOnly: ['landmark-main-is-top-level', 'landmark-no-duplicate-main'],
    })).violations.map(v => v.id));
    expect(violations).toEqual([]);
  });
}

test('testimonial scroll regions are keyboard accessible across layouts', async ({ page, request }) => {
  await mount(page, request);
  for (const layout of ['single', 'grid', 'legacy', 'paged']) {
    await page.evaluate(layout => window.changeFixture({
      layout: ['legacy', 'paged'].includes(layout) ? 'carousel' : layout,
      carousel: layout === 'paged' ? { perPage: { desktop: 1 } } : undefined,
    }), layout);
    const region = layout === 'paged'
      ? page.getByTestId('testimonials-quote-viewport')
      : page.getByRole('region', { name: 'Testimonials', exact: true });
    await expect(region).toHaveAttribute('tabindex', '0');
    await region.focus();
    await expect(region).toBeFocused();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: ['scrollable-region-focusable'] });
      return result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
    });
    expect(violations).toEqual([]);
  }
});

const typography = [
  { id: 'styled', name: 'Styled attribution', color: '#b91c1c', font_weight: 300, font_family: 'Georgia', font_size: 18, line_height: 1.5, letter_spacing: 2, text_transform: 'uppercase', margin_bottom: 7 },
  { id: 'partial', name: 'Size only', font_size: 20 },
  { id: 'color-only', name: 'Colour only', color: '#b91c1c' },
  { id: 'weight-only', name: 'Weight only', font_weight: 300 },
];

async function mount(page, request, surface = 'public', version = 1, loading = false, landmarkTest = false) {
  const response = await request.get('/src/components/canvas/CanvasBuilder.jsx');
  const source = await response.text();
  const react = source.match(/from\s+"([^"]*\/\.vite\/deps\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('Running Vite app required');
  const dep = name => react.replace(/react\.js\?/, `${name}.js?`);
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  let releaseStyles;
  const stylesReady = new Promise(resolve => { releaseStyles = resolve; });
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.includes('typography-styles') && loading) await stylesReady;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path.includes('typography-styles') ? typography : []) });
  });
  await page.exposeFunction('releaseFixtureStyles', () => releaseStyles());
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
      const {MainLandmarkContext} = await import('/src/contexts/MainLandmarkContext.jsx');
      const h = React.createElement;
      const initial = createBlock('testimonials', {id:'quotes'});
      initial.bp.desktop = {x:0,y:0,w:1200,h:280};
      initial.content = {...initial.content, layout:'carousel', carousel:{perPage:{desktop:3,tablet:2,mobile:1},loop:false},
        items:Array.from({length:7},(_,i)=>({quote:'Quote '+(i+1)+' — '+ 'A longer testimonial. '.repeat(i===2?35:3),author:'Author '+(i+1),role:'Member'}))};
      const saved = localStorage.getItem('testimonials-fixture');
      function App() {
        const [shell,setShell] = React.useState(false);
        window.toggleShell = setShell;
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
        return h(shell ? 'main' : 'div',shell ? {id:'main-content'} : null,
          h(MainLandmarkContext.Provider,{value:shell},
          h('div',{style:{width,transform:'scale(0.8)',transformOrigin:'top left'},'data-testid':'fixture-stage'},
            ${JSON.stringify(surface)}==='editor'
              ? (${version}===1
                ? h(CanvasStage,{blocks:[positioned],selectedIds:[],breakpoint:'desktop',canvasWidth:width,canvasHeight:300,onSelect:()=>window.selected=true,onApplyGeometry:()=>{},showGrid:false})
                : h(CanvasFlowEditorStage,{design,canvasWidth:width,canvasHeight:300,onSelect:()=>window.selected=true,showGrid:false}))
              : h(CanvasPageRenderer,{page:{id:'fixture',canvas_design:design},symbols:[],embedded:${!landmarkTest}}))),
          ${JSON.stringify(surface)}==='editor' && h('div',{style:{width:300,marginTop:40}},h(def.Inspector,{block,update:fn=>setBlock(fn)})));
      }
      window.__TENANT_TYPOGRAPHY_STYLES__=${loading ? 'undefined' : JSON.stringify(typography)};
      createRoot(document.getElementById('root')).render(h(MemoryRouter,null,h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},h(App))));
    </script></body></html>`,
  }));
  await page.goto('/__testimonials-fixture');
  await expect(page.getByTestId('testimonials-carousel')).toBeVisible({ timeout: 20000 });
  return errors;
}

for (const surface of ['editor', 'public']) {
  for (const version of [1, 2]) {
    test(`v${version} ${surface} attribution inheritance and quote visibility across layouts and widths`, async ({ page, request }) => {
      const errors = await mount(page, request, surface, version);
      await page.evaluate(() => window.changeFixture({ showQuoteMark: undefined }));
      await expect(page.locator('figure').first().locator('svg')).toHaveCount(1);
      for (const width of [1200, 375]) {
        await page.setViewportSize({ width: width === 375 ? 400 : 1600, height: 1000 });
        await page.evaluate(w => window.resizeFixture(w), width);
        for (const layout of ['single', 'grid', 'legacy', 'paged']) {
          await page.evaluate(layout => window.changeFixture({
            layout: ['legacy', 'paged'].includes(layout) ? 'carousel' : layout,
            carousel: layout === 'paged' ? { perPage: { desktop: 3, mobile: 1 } } : undefined,
            attributionTypographyStyleId: 'styled', showQuoteMark: true,
          }), layout);
          const figure = page.locator('figure').first();
          const caption = figure.locator('figcaption');
          const author = caption.getByText('Author 1', { exact: true });
          const role = caption.getByText('Member', { exact: true });
          for (const text of [author, role]) {
            await expect(text).toHaveCSS('color', 'rgb(185, 28, 28)');
            await expect(text).toHaveCSS('font-weight', '300');
            await expect(text).toHaveCSS('font-family', 'Georgia');
            await expect(text).toHaveCSS('font-size', '18px');
            await expect(text).toHaveCSS('line-height', '27px');
            await expect(text).toHaveCSS('letter-spacing', '2px');
            await expect(text).toHaveCSS('text-transform', 'uppercase');
          }
          await expect(caption).toHaveCSS('margin-bottom', '7px');
          if (layout === 'single') await page.screenshot({ path: `test-results/testimonials-carousel/styles-${surface}-v${version}-${width}.png` });
          await expect(figure.locator('svg')).toHaveCount(1);
          const quoteTop = await figure.locator('blockquote').evaluate(el => el.offsetTop);
          const frameLocator = page.locator(surface === 'editor' && version === 2 ? '[data-block-id="quotes"]' : '[data-cb="quotes"]').first();
          const frame = await frameLocator.boundingBox();
          if (surface === 'editor') await page.getByTestId('toggle-testimonials-quote-mark').click();
          else await page.evaluate(() => window.changeFixture({ showQuoteMark: false }));
          await expect(figure.locator('svg')).toHaveCount(0);
          expect(await figure.locator('blockquote').evaluate(el => el.offsetTop)).toBeLessThan(quoteTop);
          await expect(figure.locator('blockquote')).toContainText('Quote 1');
          await expect(author).toBeVisible();
          expect((await frameLocator.boundingBox()).height).toBe(frame.height);
          await expect(page.getByTestId('testimonials-carousel')).toHaveCount(layout === 'paged' ? 1 : 0);
          if (layout === 'legacy') await expect(figure).toHaveCSS('min-width', '240px');

          for (const id of ['partial', 'deleted', '']) {
            await page.evaluate(id => window.changeFixture({ attributionTypographyStyleId: id }), id);
            await expect(author).toHaveCSS('color', 'rgb(15, 23, 42)');
            await expect(author).toHaveCSS('font-weight', '500');
            await expect(role).toHaveCSS('color', 'rgb(100, 116, 139)');
          }
          await page.evaluate(() => window.changeFixture({ attributionTypographyStyleId: 'color-only' }));
          await expect(author).toHaveCSS('font-weight', '500');
          await expect(author).toHaveCSS('color', 'rgb(185, 28, 28)');
          await expect(role).toHaveCSS('color', 'rgb(185, 28, 28)');
          await page.evaluate(() => window.changeFixture({ attributionTypographyStyleId: 'weight-only' }));
          await expect(author).toHaveCSS('font-weight', '300');
          await expect(author).toHaveCSS('color', 'rgb(15, 23, 42)');
          await expect(role).toHaveCSS('color', 'rgb(100, 116, 139)');
        }
      }
      await page.evaluate(() => window.saveFixture());
      await page.reload();
      await expect(page.locator('figure').first().locator('svg')).toHaveCount(0);
      await expect(page.locator('figure').first().locator('figcaption')).toContainText('Author 1');
      if (surface === 'editor') await expect(page.getByTestId('toggle-testimonials-quote-mark')).toHaveAttribute('data-state', 'unchecked');
      expect(errors).toEqual([]);
    });
  }
}

test('pending attribution stays hidden until styles resolve, then inherits the selected style', async ({ page, request }) => {
  await mount(page, request, 'public', 1, true);
  await page.evaluate(() => window.changeFixture({ attributionTypographyStyleId: 'styled' }));
  const caption = page.locator('figcaption').first();
  await expect(caption).toHaveCSS('visibility', 'hidden');
  await page.evaluate(() => window.releaseFixtureStyles());
  await expect(caption).toHaveCSS('visibility', 'visible');
  await expect(caption.getByText('Author 1', { exact: true })).toHaveCSS('color', 'rgb(185, 28, 28)');
});

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

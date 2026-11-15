import { test, expect } from '@playwright/test';

async function mount(page, request, mode) {
  const source = await (await request.get('/src/components/canvas/CanvasBuilder.jsx')).text();
  const react = source.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  expect(react).toBeTruthy();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => new URL(route.request().url()).pathname.startsWith('/api/')
    ? route.fulfill({ contentType: 'application/json', body: '[]' })
    : route.continue());
  await page.route('**/__panel-images', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/index.css');
      const React = (await import(${JSON.stringify(react)})).default;
      const {createRoot} = (await import(${JSON.stringify(react.replace(/react\.js\?/, 'react-dom_client.js?'))})).default;
      const {QueryClient,QueryClientProvider} = await import(${JSON.stringify(react.replace(/react\.js\?/, '@tanstack_react-query.js?'))});
      const {AdvancedAccordionRender,AdvancedAccordionInspector} = await import('/src/components/canvas/blocks/AdvancedAccordionBlock.jsx');
      const {getBlockDefinition} = await import('/src/components/canvas/blocks/registry.jsx');
      const {createBlock,BLOCK_TYPES,normalizeCanvasDesign} = await import('/src/lib/canvasDesign.js');
      const h = React.createElement;
      const image = createBlock(BLOCK_TYPES.IMAGE, {
        id:'image', name:'Panel photo', desktop:{x:0,y:0,w:480,h:240},
        tablet:{w:400,h:180}, mobile:{h:120},
        content:{src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="300" height="300" fill="red"/><rect x="300" width="300" height="300" fill="green"/><rect x="600" width="300" height="300" fill="blue"/></svg>'),alt:'Colour panels',objectFit:'cover',focalPoint:{x:80,y:25},fullBleed:true,heightMode:'vh',heightValue:90}
      });
      image.accordionLayout={desktop:{mode:'custom',align:'center'},mobile:{align:'right'}};
      const legacy = createBlock(BLOCK_TYPES.IMAGE,{id:'legacy',content:{...image.content}});
      const initial = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
      initial.content.initialState='first';
      initial.content.items=[{id:'panel',title:'Image panel',children:[image,legacy]}];
      function App(){
        const [block,setBlock]=React.useState(initial);
        const [bp,setBp]=React.useState('desktop');
        window.setPanelBreakpoint=setBp;
        window.setPanelFit=fit=>setBlock(b=>({...b,content:{...b.content,items:b.content.items.map(i=>({...i,children:i.children.map(c=>({...c,content:{...c.content,objectFit:fit}}))}))}}));
        const saveReload=()=>setBlock(b=>normalizeCanvasDesign(JSON.parse(JSON.stringify({root:{sections:[{children:[b]}]}}))).root.sections[0].children[0]);
        const mode=${JSON.stringify(mode)};
        return h(React.Fragment,null,
          h('button',{onClick:saveReload,'data-testid':'reload'},'Save and reload'),
          h('main',{style:{width:'100%',maxWidth:700}},
            h(AdvancedAccordionRender,{block,getBlockDefinition,asEditor:mode==='editor',breakpoint:mode==='public'?undefined:bp}),
            h('div',{'data-testid':'following'},'Following content')),
          mode==='editor' && h(AdvancedAccordionInspector,{block,update:setBlock,breakpoint:bp,getBlockDefinition,listPaletteBlocks:()=>[]}));
      }
      createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},h(App)));
    </script></body></html>`,
  }));
  await page.goto('/__panel-images');
  await expect(page.locator('[data-advanced-accordion-child="image"] img')).toBeVisible();
  return errors;
}

for (const mode of ['editor', 'preview', 'public']) {
  test(`${mode}: image frames clamp, crop, persist and expand without overlap`, async ({ page, request }) => {
    const errors = await mount(page, request, mode);
    const frame = page.locator('[data-advanced-accordion-child="image"]');
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(bp => window.setPanelBreakpoint(bp), width < 640 ? 'mobile' : 'desktop');
      await expect(frame).toHaveCSS('height', width < 640 ? '120px' : '240px');
      for (const fit of ['cover', 'contain', 'fill', 'none', 'scale-down', 'fixed-crop']) {
        await page.evaluate(fit => window.setPanelFit(fit), fit);
        if (fit === 'fixed-crop') {
          await expect(frame.locator('img')).toHaveCSS('position', 'absolute');
          await expect(frame.locator('img')).toHaveCSS('height', width < 640 ? '120px' : '240px');
        } else {
          await expect(frame.locator('img')).toHaveCSS('object-fit', fit);
          if (fit === 'cover') await expect(frame.locator('img')).toHaveCSS('object-position', '80% 25%');
        }
        const box = await frame.boundingBox();
        expect(box.width).toBeLessThanOrEqual(width);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
      await page.getByTestId('reload').click();
      await expect(frame).toHaveCSS('height', width < 640 ? '120px' : '240px');
      const legacy = page.locator('[data-advanced-accordion-child="legacy"]');
      await expect(legacy).toHaveAttribute('data-advanced-accordion-layout-mode', 'legacy-fill');
      const picture = await frame.boundingBox();
      const old = await legacy.boundingBox();
      expect(old.y).toBeGreaterThanOrEqual(picture.y + picture.height);
      const following = await page.getByTestId('following').boundingBox();
      expect(following.y).toBeGreaterThanOrEqual(old.y + old.height);
      const toggle = page.locator('button[aria-expanded]').first();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(async () => (await page.getByTestId('following').boundingBox()).y).toBeLessThan(following.y - 100);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(async () => (await page.getByTestId('following').boundingBox()).y).toBeGreaterThanOrEqual(following.y - 1);
    }
    if (mode === 'editor') {
      await page.getByRole('button', { name: 'Panel photo', exact: true }).click();
      await expect(page.getByTestId('advanced-accordion-child-layout')).toBeVisible();
      await expect(page.getByTestId('toggle-image-full-bleed')).toHaveCount(0);
      await expect(page.getByTestId('select-image-height-mode')).toHaveCount(0);
      await page.getByTestId('advanced-accordion-layout-height').fill('200');
      await expect(frame).toHaveCSS('height', '200px');
      await page.getByTestId('reload').click();
      await expect(frame).toHaveCSS('height', '200px');
      await page.getByTestId('advanced-accordion-layout-reset').click();
      await expect(frame).toHaveCSS('height', '180px');
    }
    expect(errors).toEqual([]);
  });
}

import { test, expect } from '@playwright/test';
import {
  BLOCK_TYPES, createBlock, normalizeCanvasDesign, createFlowDesign,
  createFlowNode, insertFlowNode,
} from '../client/src/lib/canvasDesign.js';

const job = {
  id: 'fixture-job', status: 'active', featured: true, created_date: '2026-01-01',
  title: 'Senior specialist leading collaborative research and professional development',
  company_name: 'A long organisation name supporting research and professional development',
  location: 'United Kingdom', job_type: 'Permanent', salary_range: 'Competitive salary',
};
const content = (layout, second = false) => ({
  layout_style: layout, anchor: 'authored-jobs', main_heading: 'Featured\nOpportunity',
  subheading: 'Explore opportunities to support research, collaboration and professional development. '.repeat(3),
  right_header_text: 'LATEST OPPORTUNITY', button_url: '/JobBoard?source=featured',
  heading_font_family: 'Arial', job_title_font_family: 'Arial',
  mobile_heading_font_size: second ? 29 : 36, heading_font_size: second ? 49 : 55,
  mobile_job_title_font_size: second ? 21 : 24,
  mobile_card_margin: second ? 9 : 16, mobile_card_inner_padding: second ? 13 : 20,
  card_background: second ? '#eefaff' : '#ffffff',
});

function designFor(version, layout) {
  if (version === 2) {
    let design = createFlowDesign();
    const section = createFlowNode(BLOCK_TYPES.SECTION, { id: 'owner' });
    section.style = { ...section.style, paddingTop: 0, paddingBottom: 0 };
    section.flow.gap = 24;
    section.children = [false, true].map((second, i) => {
      const node = createFlowNode(BLOCK_TYPES.FEATURED_JOB, { id: `job-${i}` });
      node.content = content(layout, second);
      return node;
    });
    const next = createFlowNode(BLOCK_TYPES.BUTTON, { id: 'following' });
    next.content.label = 'Following block';
    section.children.push(next);
    return insertFlowNode(design, section);
  }
  const children = [false, true].map((second, i) => {
    const block = createBlock(BLOCK_TYPES.FEATURED_JOB, { id: `job-${i}` });
    block.content = content(layout, second);
    block.bp = Object.fromEntries(['desktop', 'tablet', 'mobile'].map(bp => [
      bp, { x: 0, y: i * 574, w: bp === 'mobile' ? 375 : bp === 'tablet' ? 768 : 1200, h: 550 },
    ]));
    return block;
  });
  const following = createBlock(BLOCK_TYPES.BUTTON, { id: 'following' });
  following.content.label = 'Following block';
  following.bp = Object.fromEntries(['desktop', 'tablet', 'mobile'].map(bp => [
    bp, { x: 0, y: 1148, w: 220, h: 44 },
  ]));
  children.push(following);
  return normalizeCanvasDesign({ version: 1, root: { sections: [{ id: 'root-section', children }] } });
}

async function mount(page, request, { layout = 'side-gradient', version = 1, surface = 'editor', delayed = false, empty = false } = {}) {
  const response = await request.get('/src/components/canvas/CanvasBuilder.jsx');
  const source = await response.text();
  const react = source.match(/from\s+"([^"]*\/\.vite\/deps\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('A running Vite application is required');
  const dep = name => react.replace(/react\.js\?/, `${name}.js?`);
  const initial = designFor(version, layout);
  const errors = [], denied = [];
  page.on('pageerror', e => errors.push(e.message));
  let release;
  const jobsReady = new Promise(resolve => { release = resolve; });
  if (!delayed) release();
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== new URL(response.url()).origin) {
      denied.push(`${req.method()} ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.method() !== 'GET') {
      denied.push(`${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, body: 'Fixture forbids writes' });
    }
    let data = [];
    if (url.pathname === '/api/public/job-postings') {
      await jobsReady;
      data = empty ? [] : [job];
    } else if (url.pathname.includes('symbols')) data = { symbols: [] };
    else if (url.pathname.includes('theme')) data = { theme: null };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('**/__featured-job-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      localStorage.setItem('canvas.layersPanel.open', 'false');
      await import('/src/index.css');
      const React = (await import(${JSON.stringify(react)})).default;
      const { createRoot } = (await import(${JSON.stringify(dep('react-dom_client'))})).default;
      const { QueryClient, QueryClientProvider } = await import(${JSON.stringify(dep('@tanstack_react-query'))});
      const { MemoryRouter } = await import(${JSON.stringify(dep('react-router-dom'))});
      const { default: CanvasBuilder } = await import('/src/components/canvas/CanvasBuilder.jsx');
      const { default: CanvasPageRenderer } = await import('/src/components/canvas/CanvasPageRenderer.jsx');
      const { default: IEdit } = await import('/src/components/iedit/elements/IEditFeaturedJobElement.jsx');
      const { DYNAMIC_BLOCK_DEFINITIONS } = await import('/src/components/canvas/blocks/dynamicBlocks.jsx');
      const h = React.createElement, initial = ${JSON.stringify(initial)};
      window.fixtureDesign = structuredClone(initial);
      window.fixtureDirty = false;
      const queryClient = new QueryClient({defaultOptions:{queries:{retry:false}}});
      window.replaceFixtureJob = job => queryClient.setQueriesData(
        {queryKey:['public-featured-jobs-element']}, [job],
      );
      function App() {
        const [bp, setBp] = React.useState('mobile');
        window.setFixtureBreakpoint = setBp;
        return ${JSON.stringify(surface)} === 'editor'
          ? h('div', {style:{height:950}}, h(CanvasBuilder, {
              initialDesign:initial, breakpoint:bp, onBreakpointChange:setBp,
              onDesignChange:next => window.fixtureDesign = structuredClone(next),
              onDirtyChange:dirty => window.fixtureDirty = dirty,
            }))
          : ${JSON.stringify(surface)} === 'public-page'
            ? h(CanvasPageRenderer, {
                page:{id:'fixture-public-page',canvas_design:initial}, symbols:[], embedded:true,
              })
          : h('div', {'data-testid':'reference', style:{width:'100%'}},
              ${JSON.stringify(surface)} === 'standalone'
                ? h(IEdit, {content:${JSON.stringify(content(layout))}})
                : h(DYNAMIC_BLOCK_DEFINITIONS['featured-job'].Renderer, {
                    block:{id:'public-job',content:${JSON.stringify(content(layout))}},
                  }));
      }
      createRoot(document.getElementById('root')).render(h(MemoryRouter,null,
        h(QueryClientProvider,{client:queryClient},h(App))));
    </script></body></html>`,
  }));
  await page.goto('/__featured-job-fixture');
  await expect(page.locator('h2').first()).toBeAttached();
  return { initial, errors, denied, release };
}

const block = (page, id) => page.locator(`[data-block-id="${id}"]`).first();
const preview = (page, i = 0) => block(page, `job-${i}`).getByTestId('featured-job-editor-preview');

async function metrics(locator) {
  return locator.evaluate(root => {
    const visible = selector => [...root.querySelectorAll(selector)].find(n => n.getBoundingClientRect().height > 0);
    const css = (n, props) => Object.fromEntries(props.map(p => [p, getComputedStyle(n)[p]]));
    const heading = visible('h2'), title = visible('h3'), row = visible('.job-detail-row');
    const top = visible('[id$="-section-top"]'), bottom = visible('[id$="-section-bottom"]');
    const card = visible('[id$="-card"]'), fw = visible('[id$="-fw-wrapper"]');
    const h = heading.getBoundingClientRect(), t = title?.getBoundingClientRect();
    return {
      heading: css(heading, ['fontSize', 'marginBottom', 'lineHeight']),
      title: title && css(title, ['fontSize', 'marginBottom']),
      row: row && css(row, ['fontSize', 'gap', 'paddingTop', 'paddingBottom']),
      button: css(visible('button'), ['fontSize', 'paddingLeft', 'paddingTop', 'gap']),
      icon: css(visible('button svg'), ['width', 'height']),
      top: top && css(top, ['padding', 'backgroundImage']),
      bottom: bottom && css(bottom, ['padding', 'backgroundColor']),
      card: card && css(card, ['padding', 'backgroundColor']),
      fw: fw && css(fw, ['padding', 'backgroundImage']),
      stacked: t ? t.top >= h.bottom : null,
      widthOverflow: root.scrollWidth - root.clientWidth,
    };
  });
}

async function bounds(page) {
  await expect.poll(async () => {
    const a = await block(page, 'job-0').boundingBox();
    const b = await block(page, 'job-1').boundingBox();
    const c = await block(page, 'following').boundingBox();
    return Math.min(b.y - a.y - a.height, c.y - b.y - b.height);
  }).toBeGreaterThanOrEqual(0);
  for (const i of [0, 1]) {
    expect((await metrics(preview(page, i))).widthOverflow).toBeLessThanOrEqual(1);
    expect(await block(page, `job-${i}`).evaluate(root => {
      const frame = root.getBoundingClientRect();
      return [...root.querySelectorAll('h2,h3,button,.job-detail-row')]
        .filter(n => n.getBoundingClientRect().height > 0)
        .every(n => {
          const r = n.getBoundingClientRect();
          return r.bottom <= frame.bottom + 1 && r.right <= frame.right + 1 && r.left >= frame.left - 1;
        });
    })).toBe(true);
  }
}

for (const layout of ['side-gradient', 'full-width']) {
  test(`${layout}: published v1 adjacent frames stay fixed through loading and job changes`, async ({ page, request }) => {
    const state = await mount(page, request, { layout, surface: 'public-page', delayed: true });
    // Capture the actual published frame geometry, not just an isolated renderer.
    const frames = () => page.evaluate(() => ['job-0', 'job-1', 'following'].map(id => {
      const root = document.querySelector('[data-block-id="' + id + '"]');
      const rect = root.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    for (const width of [1200, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await frames())[0].height).toBe(550);
      const baseline = await frames();
      state.release();
      await expect(block(page, 'job-0').locator('h3').filter({ visible: true })).toBeVisible();
      for (const title of ['Short title', job.title.repeat(12)]) {
        await page.evaluate(job => window.replaceFixtureJob(job), { ...job, title });
        await expect(block(page, 'job-0').locator('h3').filter({ visible: true })).toHaveText(title);
        await expect.poll(frames).toEqual(baseline);
      }
      const positions = await frames();
      expect(positions[1].y).toBeGreaterThanOrEqual(positions[0].y + positions[0].height);
      expect(positions[2].y).toBeGreaterThanOrEqual(positions[1].y + positions[1].height);
      await expect(page.getByTestId('featured-job-editor-preview')).toHaveCount(0);
    }
    expect([...state.errors, ...state.denied]).toEqual([]);
  });

  for (const version of [1, 2]) {
    test(`${layout} v${version}: mobile editor parity, independent styles, width switches, zoom, sizing and links`, async ({ page, request, context }) => {
      const state = await mount(page, request, { layout, version });
      await expect(preview(page).locator('h3').filter({ visible: true })).toBeVisible();
      const mobile = await metrics(preview(page));
      expect(mobile.stacked).toBe(true);
      expect(mobile.heading.fontSize).toBe('36px');
      expect((await metrics(preview(page, 1))).heading.fontSize).toBe('29px');
      await bounds(page);

      const referencePage = await context.newPage();
      await referencePage.setViewportSize({ width: 375, height: 900 });
      const referenceState = await mount(referencePage, request, { layout, surface: 'public' });
      await expect(referencePage.locator('h3').filter({ visible: true })).toBeVisible();
      const reference = await metrics(referencePage.getByTestId('reference'));
      expect({ ...mobile, widthOverflow: 0 }).toEqual({ ...reference, widthOverflow: 0 });
      await page.screenshot({ path: `test-results/featured-job-preview/${layout}-v${version}-mobile.png` });

      await page.evaluate(() => window.setFixtureBreakpoint('desktop'));
      await expect.poll(async () => (await metrics(preview(page))).heading.fontSize).toBe('55px');
      expect((await metrics(preview(page))).stacked).toBe(false);
      await bounds(page);
      await referencePage.setViewportSize({ width: 1200, height: 900 });
      const desktop = await metrics(preview(page));
      // The public button has transition-all; wait for the viewport switch to settle.
      await expect.poll(async () => ({
        ...await metrics(referencePage.getByTestId('reference')), widthOverflow: 0,
      })).toEqual({ ...desktop, widthOverflow: 0 });
      await referencePage.close();
      await page.evaluate(() => window.setFixtureBreakpoint('tablet'));
      await expect.poll(async () => (await metrics(preview(page))).heading.fontSize).toBe('55px');
      expect((await metrics(preview(page))).row.gap).toBe('8px');
      await page.evaluate(() => window.setFixtureBreakpoint('mobile'));
      await expect.poll(async () => (await metrics(preview(page))).heading.fontSize).toBe('36px');
      // Real toolbar zoom updates both the transform and reflow measurement context.
      for (const direction of ['out', 'in']) {
        for (let i = 0; i < 2; i++) await page.getByTestId(`button-zoom-${direction}`).click();
        expect((await metrics(preview(page))).heading.fontSize).toBe('36px');
        expect((await metrics(preview(page))).stacked).toBe(true);
        await bounds(page);
        await page.getByTestId('button-zoom-reset').click();
      }
      await preview(page).locator('a').filter({ visible: true }).first().evaluate(el => el.click());
      expect(page.url()).toContain('/__featured-job-fixture');
      await bounds(page);
      expect(await page.evaluate(() => window.fixtureDesign)).toEqual(state.initial);
      expect(await page.evaluate(() => window.fixtureDirty)).toBe(false);
      expect([...state.errors, ...referenceState.errors, ...state.denied, ...referenceState.denied]).toEqual([]);
    });
  }

  test(`${layout}: loading/empty and late long job content reflow without persisted changes`, async ({ page, request }) => {
    const state = await mount(page, request, { layout, delayed: true });
    await expect(preview(page).locator('h2').filter({ visible: true })).toBeVisible();
    await expect(preview(page).locator('h3')).toHaveCount(0);
    const before = await block(page, 'following').boundingBox();
    await page.getByTestId('button-zoom-out').click();
    state.release();
    await expect(preview(page).locator('h3').filter({ visible: true })).toBeVisible();
    await bounds(page);
    await page.getByTestId('button-zoom-reset').click();
    await expect.poll(async () => (await block(page, 'following').boundingBox()).y).toBeGreaterThan(before.y);
    await page.evaluate(job => window.replaceFixtureJob({
      ...job, title: job.title.repeat(5), company_name: 'UnbrokenOrganisationName'.repeat(16),
    }), job);
    await expect(preview(page).locator('h3').filter({ visible: true })).toHaveText(job.title.repeat(5));
    await bounds(page);
    expect(await page.evaluate(() => window.fixtureDesign)).toEqual(state.initial);
    expect([...state.errors, ...state.denied]).toEqual([]);
  });

  test(`${layout}: empty state and public/standalone viewport behavior remain intact`, async ({ page, request }) => {
    await mount(page, request, { layout, empty: true });
    if (layout === 'side-gradient') await expect(preview(page).getByText('No featured job available').filter({ visible: true })).toBeVisible();
    await expect(preview(page).locator('h3')).toHaveCount(0);
    for (const surface of ['public', 'standalone']) {
      await page.unrouteAll({ behavior: 'wait' });
      const state = await mount(page, request, { layout, surface });
      await expect(page.locator('h3').filter({ visible: true })).toBeVisible();
      // Reproduce the former Canvas mismatch without opting into preview mode:
      // a narrow element in a desktop viewport still follows viewport rules.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.getByTestId('reference').evaluate(el => { el.style.width = '375px'; });
      await expect.poll(async () => (await metrics(page.getByTestId('reference'))).heading.fontSize).toBe('55px');
      expect((await metrics(page.getByTestId('reference'))).stacked).toBe(false);
      await page.getByTestId('reference').evaluate(el => { el.style.width = '100%'; });
      for (const width of [1600, 375, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const m = await metrics(page.getByTestId('reference'));
        expect(m.heading.fontSize).toBe(width < 768 ? '36px' : '55px');
        expect(m.stacked).toBe(width < 768);
        expect(m.row.gap).toBe(width < 1024 ? '8px' : '12px');
      }
      expect(await page.locator('a').filter({ visible: true }).first().getAttribute('href')).toBe('/JobBoard?source=featured');
      expect([...state.errors, ...state.denied]).toEqual([]);
    }
  });
}

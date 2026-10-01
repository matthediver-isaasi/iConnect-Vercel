import { expect } from '@playwright/test';
import {
  BLOCK_TYPES, createBlock, createFlowDesign, createFlowNode, insertFlowNode,
  normalizeCanvasDesign,
} from '../../client/src/lib/canvasDesign.js';

export const prose = 'Ordinary multiword table content should wrap inside its column rather than stretching the table beyond the authored frame. '.repeat(2);
export const token = 'https://example.invalid/' + 'VeryLongUnbrokenValue'.repeat(12);
export const plain = '<img src=x onerror="window.tableInjected=true">\nSecond explicit line\nThird line & plain text';
export const styles = [
  { id: 'table-heading-4910', name: 'Table heading', style_type: 'paragraph', font_family: 'Arial', font_size: 20, font_size_tablet: 18, font_size_mobile: 16, font_weight: '600', line_height: 1.4, line_height_mobile: 1.5, margin_bottom: 0 },
  { id: 'table-body-4910', name: 'Table body', style_type: 'paragraph', font_family: 'Arial', font_size: 16, font_size_tablet: 15, font_size_mobile: 14, font_weight: '400', line_height: 1.5, line_height_mobile: 1.6, margin_bottom: 0 },
];

export const scheduleContent = {
  columns: [{ id: 'time', heading: 'Time' }, { id: 'session', heading: 'Session' }],
  rows: [
    { id: 'opening', cells: { time: '09:00–09:30', session: 'Opening address and conference welcome' } },
    { id: 'parallel', cells: { time: '10:45–11:30', session: 'Parallel Sessions (Rotating workshops and discussion)' } },
    { id: 'panel', cells: { time: '16:30–17:15', session: 'Labour market panel' } },
  ],
  headerTypographyStyleId: styles[0].id,
  bodyTypographyStyleId: styles[1].id,
};

export function tableDesign(version = 1, width = 900, contentOverride = null) {
  const tableStyle = { paddingTop: 12, paddingBottom: 14, paddingLeft: 10, paddingRight: 10, borderWidth: 3 };
  const content = contentOverride || {
    columns: [
      { id: 'prose', heading: 'An unusually long multiword heading that must wrap to the authored column width' },
      { id: 'token', heading: 'UnbrokenHeading'.repeat(8) },
      { id: 'plain', heading: 'Explicit\nheading lines' },
    ],
    rows: [
      { id: 'long', cells: { prose, token, plain } },
      { id: 'short', cells: { prose: 'Short value', token: '123', plain: 'Single line' } },
    ],
    headerTypographyStyleId: styles[0].id,
    bodyTypographyStyleId: styles[1].id,
  };
  if (version === 2) {
    let design = createFlowDesign();
    const first = design.root.sections[0];
    first.id = 'table-section';
    first.flow = { ...first.flow, maxWidth: width, gap: 24, padTop: 20, padBottom: 20, padLeft: 0, padRight: 0 };
    design = insertFlowNode(design, createFlowNode(BLOCK_TYPES.DATA_TABLE, { id: 'wrapping-table', content, style: tableStyle }));
    design = insertFlowNode(design, createFlowNode(BLOCK_TYPES.BUTTON, { id: 'after-table', content: { label: 'Following block' }, flow: { heightMode: 'fixed', height: 44 } }));
    const second = createFlowNode(BLOCK_TYPES.SECTION, { id: 'following-section', flow: { heightMode: 'fixed', height: 80, marginTop: 24 } });
    design.root.sections.push(second);
    return normalizeCanvasDesign(design);
  }
  const positioned = (type, id, geom, content = {}) => {
    const block = createBlock(type, { id });
    block.id = id;
    block.name = id;
    block.content = { ...block.content, ...content };
    if (type === BLOCK_TYPES.DATA_TABLE) block.style = { ...block.style, ...tableStyle };
    block.bp = Object.fromEntries(['desktop', 'tablet', 'mobile'].map(bp => [
      bp, { ...geom, w: bp === 'desktop' ? geom.w : Math.min(geom.w, bp === 'tablet' ? 768 : 375) },
    ]));
    return block;
  };
  return normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [
      positioned(BLOCK_TYPES.SECTION, 'table-section', { x: 0, y: 0, w: width, h: 260 }),
      positioned(BLOCK_TYPES.DATA_TABLE, 'wrapping-table', { x: 0, y: 20, w: width, h: 100 }, content),
      positioned(BLOCK_TYPES.BUTTON, 'after-table', { x: 0, y: 160, w: 220, h: 44 }, { label: 'Following block' }),
      positioned(BLOCK_TYPES.SECTION, 'following-section', { x: 0, y: 300, w: width, h: 80 }),
    ] }] },
  });
}

function html(modules, options, initialDesign) {
  const { react, dependency } = modules;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Canvas table wrapping fixture</title></head><body>
  <div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    localStorage.setItem('canvas.layersPanel.open', 'false');
    window.__TENANT_TYPOGRAPHY_STYLES__ = ${JSON.stringify(styles)};
    await import('/src/index.css');
    const React = (await import(${JSON.stringify(react)})).default;
    const { createRoot } = (await import(${JSON.stringify(dependency('react-dom_client'))})).default;
    const { QueryClient, QueryClientProvider } = await import(${JSON.stringify(dependency('@tanstack_react-query'))});
    const { MemoryRouter } = await import(${JSON.stringify(dependency('react-router-dom'))});
    const { default: CanvasBuilder } = await import('/src/components/canvas/CanvasBuilder.jsx');
    const { default: CanvasPageRenderer } = await import('/src/components/canvas/CanvasPageRenderer.jsx');
    const h = React.createElement;
    const initial = ${JSON.stringify(initialDesign)};
    const initialPublicMode = ${JSON.stringify(options.surface === 'public')};
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    window.fixtureSaves = [];
    window.fixtureDesign = structuredClone(initial);
    window.fixtureDirty = false;
    function App() {
      const [design, setDesign] = React.useState(initial);
      const [bp, setBp] = React.useState('desktop');
      const [epoch, setEpoch] = React.useState(0);
      const [dirty, setDirty] = React.useState(false);
      const [publicMode, setPublicMode] = React.useState(initialPublicMode);
      const builder = React.useRef(null);
      window.fixtureSetBreakpoint = setBp;
      window.fixtureReplaceDesign = setDesign;
      const reload = () => {
        setDesign(JSON.parse(localStorage.getItem('table4910.saved') || JSON.stringify(initial)));
        setEpoch(n => n + 1);
      };
      return h(React.Fragment, null,
        !publicMode && h('button', {
          'data-testid': 'fixture-save', disabled: !dirty,
          onClick: () => builder.current.saveNow(),
        }, 'Save local fixture'),
        h('button', { 'data-testid': 'fixture-reload', onClick: reload }, 'Reload local saved design'),
        !publicMode && h('button', {
          'data-testid': 'fixture-open-public',
          onClick: () => {
            reload();
            setPublicMode(true);
          },
        }, 'Render local saved design publicly'),
        h('div', { 'data-testid': 'fixture-surface', style: { height: publicMode ? 'auto' : '950px' } },
          publicMode ? h(CanvasPageRenderer, {
            key: epoch, page: { id: 'table4910', canvas_design: design }, symbols: [], embedded: true,
          }) : h(CanvasBuilder, {
            key: epoch, ref: builder, initialDesign: design, breakpoint: bp, onBreakpointChange: setBp,
            onDesignChange: next => { window.fixtureDesign = structuredClone(next); },
            onDirtyChange: dirty => { window.fixtureDirty = dirty; setDirty(dirty); },
            onSave: next => {
              const copy = structuredClone(next);
              window.fixtureSaves.push(copy);
              localStorage.setItem('table4910.saved', JSON.stringify(copy));
              return Promise.resolve(true);
            },
          })),
      );
    }
    createRoot(document.getElementById('root')).render(
      h(QueryClientProvider, { client }, h(MemoryRouter, null, h(App)))
    );
  </script></body></html>`;
}

export async function mountTable(page, request, options = {}) {
  const opts = { version: 1, surface: 'editor', width: 900, ...options };
  const response = await request.get('/src/components/canvas/CanvasBuilder.jsx');
  expect(response.ok(), 'An already-running Vite preview is required').toBeTruthy();
  const source = await response.text();
  const react = source.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('Preview is not serving Vite-transformed React modules');
  const modules = { react, dependency: name => react.replace(/react\.js\?/, `${name}.js?`) };
  const state = { errors: [], denied: [], reads: [] };
  const initialDesign = tableDesign(opts.version, opts.width, opts.content);
  page.on('pageerror', error => state.errors.push(error.message));
  // Fail closed: this component fixture permits no backend writes, reads only
  // synthetic styles/settings, and blocks direct external/Supabase traffic.
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const origin = new URL(page.url().startsWith('http') ? page.url() : response.url()).origin;
    if (url.origin !== origin) {
      state.denied.push(`${req.method()} ${url.origin}`);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.method() !== 'GET') {
      state.denied.push(`${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, contentType: 'application/json', body: '{"error":"Fixture forbids backend writes"}' });
    }
    state.reads.push(url.pathname);
    const data = url.pathname.includes('TypographyStyle') || url.pathname === '/api/public/typography-styles'
      ? styles : url.pathname.includes('theme') ? { theme: null } : url.pathname.includes('symbols') ? { symbols: [] } : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('**/__canvas-table-4910', route => route.fulfill({
    contentType: 'text/html', body: html(modules, opts, initialDesign),
  }));
  await page.goto('/__canvas-table-4910');
  await expect(page.getByTestId('canvas-data-table')).toBeVisible();
  return { state, initialDesign };
}

export const table = page => page.getByTestId('canvas-data-table');
export const block = (page, id) => page.locator(`[data-block-id="${id}"]`).first();
export async function geometry(page) {
  return table(page).evaluate(el => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    return {
      table: rect(el), scroller: rect(el.parentElement),
      scrollWidth: el.parentElement.scrollWidth, clientWidth: el.parentElement.clientWidth,
      headings: [...el.querySelectorAll('th')].map(rect),
      rows: [...el.querySelectorAll('tbody tr')].map(rect),
      cells: [...el.querySelectorAll('td')].map(node => ({
        ...rect(node), text: node.textContent, whiteSpace: getComputedStyle(node).whiteSpace,
        overflowWrap: getComputedStyle(node).overflowWrap,
      })),
      headerFont: getComputedStyle(el.querySelector('th')).fontSize,
      bodyFont: getComputedStyle(el.querySelector('td')).fontSize,
      textFragments: [...el.querySelectorAll('th, td')].map(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const bounds = node.getBoundingClientRect();
        return [...range.getClientRects()].map(r => ({
          leftOverflow: bounds.left - r.left, rightOverflow: r.right - bounds.right,
        }));
      }),
    };
  });
}
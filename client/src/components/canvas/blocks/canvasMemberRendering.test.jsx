import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://canvas.test/member-page',
  pretendToBeVisual: true,
});
for (const name of [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
  'DocumentFragment', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
]) globalThis[name] = name === 'window' ? dom.window : dom.window[name];
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.ResizeObserver = globalThis.ResizeObserver;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.__TENANT_TYPOGRAPHY_STYLES__ = [];
globalThis.fetch = async (url) => {
  if (String(url).includes('tenant-canvas-theme')) return { ok: true, json: async () => ({ theme: null }) };
  throw new Error(`Unexpected request in isolated Canvas renderer test: ${url}`);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: LayoutContext, LayoutProvider, useLayoutContext } = await import('@/contexts/LayoutContext.jsx');
const { default: CanvasPageRenderer } = await import('../CanvasPageRenderer.jsx');
const { CanvasSymbolsProvider } = await import('../CanvasSymbolsContext.jsx');
const { getBlockDefinition } = await import('./registry.jsx');

const TOKENS = '{{member.first_name}} / {{member.last_name}} / {{member.job_title}} / {{member.organization.name}}';
const HTML = `<p><strong>${TOKENS}</strong></p>`;
const valuesA = {
  'member.first_name': 'Ada',
  'member.last_name': 'Lovelace',
  'member.job_title': 'Engineer',
  'member.organization.name': 'Analytical Society',
};
const valuesB = {
  'member.first_name': 'Grace',
  'member.last_name': 'Hopper',
  'member.job_title': 'Admiral',
  'member.organization.name': 'Computing Society',
};
const rendered = (values) => Object.values(values).join(' / ');
const viewer = (values = valuesA, gates = {}) => ({
  canvasMemberValues: values,
  sessionValidated: true,
  authResolved: true,
  memberInfo: { id: values === valuesB ? 'b' : 'a', tenant_id: 'tenant' },
  ...gates,
});

function block(type, content, id = `token-${type}`) {
  return {
    id, type, content,
    geom: { x: 0, y: 0, w: 600, h: 300 },
    style: {},
    flow: { heightMode: 'auto' },
  };
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  return {
    container,
    client,
    async render(child, layout = viewer()) {
      await act(async () => root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <LayoutContext.Provider value={layout}>{child}</LayoutContext.Provider>
          </QueryClientProvider>
        </MemoryRouter>,
      ));
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const surfaces = [
  ['text', { html: HTML }],
  ['columns', { items: [{ html: HTML }], gap: 0 }],
  ['accordion', { items: [{ q: 'Member answer', a: HTML }] }],
  ['card', { body: HTML }],
  ['card-flip-grid', { cards: [{ title: 'Member card', summary: HTML, content: HTML }], columns: 1 }],
  ['hero-carousel', { slides: [{ headerText: HTML, subheadingText: HTML, contentText: HTML }], autoplayInterval: 0 }],
  ['hero-carousel-mobile', { slides: [{ headerText: HTML, subheadingText: HTML, contentText: HTML }], autoplayInterval: 0 }],
];

for (const [type, content] of surfaces) {
  test(`${type}: mounted renderer preserves templates, resolves current viewer, and blanks both untrusted auth states`, async () => {
    const mounted = await mount();
    const source = block(type, content);
    const before = JSON.stringify(source);
    const Renderer = getBlockDefinition(type).Renderer;
    try {
      await mounted.render(<Renderer block={source} asEditor breakpoint="desktop" />);
      assert.ok(mounted.container.textContent.includes(TOKENS), 'authoring stage displays the original token template');
      assert.ok(!mounted.container.textContent.includes(rendered(valuesA)));

      await mounted.render(<Renderer block={source} breakpoint="desktop" />);
      assert.ok(mounted.container.textContent.includes(rendered(valuesA)), 'public rich text uses validated viewer');
      assert.ok(!mounted.container.textContent.includes('{{member.'));
      assert.ok(mounted.container.querySelector('strong')?.textContent.includes(rendered(valuesA)), 'formatting survives resolution');
      if (type.startsWith('hero-carousel')) {
        assert.equal(mounted.container.querySelectorAll('strong').length, 3);
        for (const field of mounted.container.querySelectorAll('strong')) {
          assert.equal(field.textContent, rendered(valuesA), 'header, subheading and body all resolve');
        }
      }

      await mounted.render(<Renderer block={source} breakpoint="desktop" />, viewer(valuesB));
      assert.ok(mounted.container.textContent.includes(rendered(valuesB)), 'same mounted renderer updates on identity change');
      assert.ok(!mounted.container.textContent.includes('Lovelace'));

      for (const gates of [{ authResolved: false }, { sessionValidated: false }]) {
        await mounted.render(<Renderer block={source} breakpoint="desktop" />, viewer(valuesA, gates));
        assert.ok(!mounted.container.textContent.includes('{{member.'));
        assert.ok(!mounted.container.textContent.includes('Lovelace'), 'retained values cannot bypass either auth gate');
      }
      assert.equal(JSON.stringify(source), before, 'rendering never mutates the persisted template');
    } finally {
      await mounted.close();
    }
  });
}

test('Advanced Accordion single-required panels preserve nested Text templates and update both panels across viewer and guest transitions', async () => {
  // The offered schema has multiple/single/single-required accordion modes,
  // not a separate tabs mode. single-required is its one-active-panel mode.
  const mounted = await mount();
  const source = block('advanced-accordion', {
    mode: 'single-required',
    initialState: 'first',
    items: [
      { id: 'first', title: 'First panel', children: [block('text', { html: `<p><strong>First ${TOKENS}</strong></p>` }, 'first-text')] },
      { id: 'second', title: 'Second panel', children: [block('text', { html: `<p><strong>Second ${TOKENS}</strong></p>` }, 'second-text')] },
    ],
  });
  const before = JSON.stringify(source);
  const Renderer = getBlockDefinition('advanced-accordion').Renderer;
  const item = (id) => mounted.container.querySelector(`[data-accordion-item="${id}"]`);
  const panel = (id) => item(id).querySelector('[role="region"]');
  const open = async (id) => {
    await act(async () => item(id).querySelector('button[aria-controls]').click());
    assert.equal(panel(id).getAttribute('aria-hidden'), 'false');
    const other = id === 'first' ? 'second' : 'first';
    assert.equal(panel(other).getAttribute('aria-hidden'), 'true', 'switching closes the previous panel');
  };
  const assertBoth = (text) => {
    assert.equal(panel('first').querySelector('strong').textContent, `First ${text}`);
    assert.equal(panel('second').querySelector('strong').textContent, `Second ${text}`);
  };
  try {
    await mounted.render(<Renderer block={source} asEditor breakpoint="desktop" />);
    assert.equal(panel('first').getAttribute('aria-hidden'), 'false');
    assertBoth(TOKENS);
    await open('second');
    assertBoth(TOKENS);
    await open('second');
    assert.equal(panel('second').getAttribute('aria-hidden'), 'false', 'single-required keeps the active panel open');

    await mounted.render(<Renderer block={source} breakpoint="desktop" />);
    assertBoth(rendered(valuesA));
    await open('first');
    await mounted.render(<Renderer block={source} breakpoint="desktop" />, viewer(valuesB));
    assertBoth(rendered(valuesB));
    await open('second');
    assertBoth(rendered(valuesB));

    await mounted.render(<Renderer block={source} breakpoint="desktop" />, viewer(valuesB, { sessionValidated: false }));
    assertBoth(' /  /  / ');
    await open('first');
    assertBoth(' /  /  / ');
    assert.ok(!mounted.container.textContent.includes('{{member.'));

    await mounted.render(<Renderer block={source} asEditor breakpoint="desktop" />);
    assertBoth(TOKENS);
    assert.equal(JSON.stringify(source), before, 'panel changes and viewer transitions never rewrite nested templates');
  } finally {
    await mounted.close();
  }
});

test('rich-text substitutions are escaped, single-pass, and cannot resolve attributes or plain headings', async () => {
  const mounted = await mount();
  const source = block('card', {
    heading: '{{member.first_name}}',
    body: `<p><a href="/{{member.first_name}}"><strong>${TOKENS}</strong></a></p>`,
  });
  const Renderer = getBlockDefinition('card').Renderer;
  const hostileValues = {
    ...valuesA,
    'member.first_name': '<img src=x onerror=alert(1)>',
    'member.last_name': '{{member.job_title}}',
    'member.job_title': '<script>alert(2)</script>',
    'member.organization.name': 'A & B "Partners"',
  };
  try {
    await mounted.render(<Renderer block={source} />, viewer(hostileValues));
    assert.equal(mounted.container.querySelector('strong').textContent, rendered(hostileValues));
    assert.equal(mounted.container.querySelector('a').getAttribute('href'), '/{{member.first_name}}');
    assert.ok(mounted.container.textContent.includes('{{member.first_name}}'), 'plain title is not a token surface');
    assert.equal(mounted.container.querySelectorAll('img, script, [onerror]').length, 0);
  } finally {
    await mounted.close();
  }
});

test('flip-card full-content portal resolves the current viewer, including changes while the modal stays open', async () => {
  const mounted = await mount();
  const source = block('card-flip-grid', {
    cards: [{ title: 'Member card', summary: HTML, content: `<p><em>Full ${TOKENS}</em></p>` }],
    columns: 1,
  });
  const Renderer = getBlockDefinition('card-flip-grid').Renderer;
  try {
    await mounted.render(<Renderer block={source} />);
    await act(async () => mounted.container.querySelector('[data-testid$="-view-more"]').click());
    const modal = () => document.querySelector('[role="dialog"]');
    assert.equal(modal().querySelector('em').textContent, `Full ${rendered(valuesA)}`);
    await mounted.render(<Renderer block={source} />, viewer(valuesB));
    assert.equal(modal().querySelector('em').textContent, `Full ${rendered(valuesB)}`);
    await mounted.render(<Renderer block={source} />, viewer({}, { sessionValidated: false }));
    assert.equal(modal().querySelector('em').textContent, 'Full  /  /  / ');
    await mounted.render(<Renderer block={source} asEditor />);
    assert.equal(modal().querySelector('em').textContent, `Full ${TOKENS}`, 'template mode also applies inside the portal');
  } finally {
    await mounted.close();
  }
});

function design(version, children) {
  return {
    version,
    root: {
      sections: [{
        id: 'section', type: 'section', style: {},
        flow: { gap: 16, padTop: 0, padBottom: 0 },
        children,
      }],
    },
  };
}

for (const version of [1, 2]) {
  test(`CanvasPageRenderer v${version}: embedded footer/preview reuses viewer context and leaves source designs untouched`, async () => {
    const mounted = await mount();
    const page = { id: `footer-${version}`, canvas_design: design(version, [block('text', { html: HTML })]) };
    const before = JSON.stringify(page);
    try {
      const child = <CanvasPageRenderer page={page} embedded forceBreakpoint="desktop" />;
      await mounted.render(child);
      const stage = () => mounted.container.querySelector('[data-testid="canvas-page-stage"]');
      assert.equal(stage().tagName, 'DIV', 'embedded/footer mode avoids a nested main landmark');
      assert.ok(stage().textContent.includes(rendered(valuesA)));
      await mounted.render(child, viewer(valuesB));
      assert.ok(stage().textContent.includes(rendered(valuesB)));
      assert.ok(!stage().textContent.includes('Lovelace'));
      await mounted.render(child, viewer({}, { sessionValidated: false }));
      assert.ok(!stage().textContent.includes('{{member.'));
      assert.ok(!stage().textContent.includes('Hopper'));
      assert.equal(JSON.stringify(page), before);
    } finally {
      await mounted.close();
    }
  });
}

test('public symbol expansion resolves rich text without personalizing page or shared symbol definitions', async () => {
  const mounted = await mount();
  const symbols = [{ id: 'member-symbol', design: design(1, [block('text', { html: HTML }, 'symbol-text')]) }];
  const page = {
    id: 'symbol-page',
    canvas_design: design(1, [block('symbol', { symbolId: 'member-symbol' }, 'symbol-instance')]),
  };
  const before = JSON.stringify({ page, symbols });
  try {
    const child = <CanvasPageRenderer page={page} symbols={symbols} embedded forceBreakpoint="desktop" />;
    await mounted.render(child);
    assert.ok(mounted.container.textContent.includes(rendered(valuesA)));
    await mounted.render(child, viewer(valuesB));
    assert.ok(mounted.container.textContent.includes(rendered(valuesB)));
    assert.ok(!mounted.container.textContent.includes('Lovelace'));
    assert.equal(JSON.stringify({ page, symbols }), before);
  } finally {
    await mounted.close();
  }
});

test('editor symbol previews retain tokens in child rich text rather than saving an administrator identity', async () => {
  const mounted = await mount();
  const symbols = [{ id: 'member-symbol', design: design(1, [block('text', { html: HTML }, 'symbol-text')]) }];
  mounted.client.setQueryData(['canvas-symbols', 'full'], { symbols });
  const before = JSON.stringify(symbols);
  const Renderer = getBlockDefinition('symbol').Editor;
  try {
    await mounted.render(
      <CanvasSymbolsProvider>
        <Renderer block={block('symbol', { symbolId: 'member-symbol' })} asEditor breakpoint="desktop" />
      </CanvasSymbolsProvider>,
    );
    assert.ok(mounted.container.textContent.includes(TOKENS));
    assert.ok(!mounted.container.textContent.includes('Lovelace'));
    assert.equal(JSON.stringify(symbols), before);
  } finally {
    await mounted.close();
  }
});

test('nested public symbol keeps the existing nonrecursive placeholder boundary while outer rich text follows the viewer', async () => {
  const mounted = await mount();
  const symbols = [
    {
      id: 'outer-symbol',
      design: design(1, [
        block('text', { html: HTML }, 'outer-text'),
        block('symbol', { symbolId: 'inner-symbol', symbolName: 'Nested symbol' }, 'nested-instance'),
      ]),
    },
    {
      id: 'inner-symbol',
      design: design(1, [block('text', { html: `<p>Inner ${TOKENS}</p>` }, 'inner-text')]),
    },
  ];
  const page = {
    id: 'nested-symbol-page',
    canvas_design: design(1, [block('symbol', { symbolId: 'outer-symbol' }, 'outer-instance')]),
  };
  const before = JSON.stringify({ page, symbols });
  try {
    const child = <CanvasPageRenderer page={page} symbols={symbols} embedded forceBreakpoint="desktop" />;
    for (const values of [valuesA, valuesB, {}]) {
      await mounted.render(child, viewer(values));
      const stage = mounted.container.querySelector('[data-testid="canvas-page-stage"]');
      const expected = values === valuesA ? rendered(valuesA) : values === valuesB ? rendered(valuesB) : ' /  /  / ';
      assert.equal(stage.querySelector('strong').textContent, expected);
      assert.ok(stage.querySelector('[data-symbol-id="inner-symbol"]'), 'nested symbols retain their neutral placeholder');
      assert.ok(!stage.textContent.includes('Inner '), 'token feature must not enable recursive symbol expansion');
      assert.ok(!stage.textContent.includes('{{member.'), 'placeholder cannot leak inner raw template tokens');
    }
    assert.equal(JSON.stringify({ page, symbols }), before);
  } finally {
    await mounted.close();
  }
});

test('real LayoutProvider clears a mounted text renderer on identity invalidation and requires a new trusted snapshot', async () => {
  const mounted = await mount();
  const Renderer = getBlockDefinition('text').Renderer;
  let layout;
  function Probe() {
    layout = useLayoutContext();
    return <Renderer block={block('text', { html: HTML })} />;
  }
  const member = { id: 'a', tenant_id: 'tenant', organization_id: 'org-a' };
  try {
    await mounted.render(<LayoutProvider><Probe /></LayoutProvider>);
    await act(async () => {
      layout.setMemberInfo(member);
      layout.setCanvasMemberSnapshot({ memberId: 'a', tenantId: 'tenant', organizationId: 'org-a', values: valuesA });
      layout.setSessionValidated(true);
      layout.setAuthResolved(true);
    });
    assert.equal(mounted.container.querySelector('strong').textContent, rendered(valuesA));
    await act(async () => layout.setMemberInfo({ ...member, tenant_id: 'other-tenant' }));
    assert.equal(mounted.container.querySelector('strong').textContent, ' /  /  / ');
    await act(async () => layout.setMemberInfo(member));
    assert.equal(mounted.container.querySelector('strong').textContent, ' /  /  / ', 'old identity cannot revive cleared values');
    await act(async () => {
      layout.setMemberInfo({ id: 'b', tenant_id: 'tenant', organization_id: 'org-b' });
      layout.setCanvasMemberSnapshot({ memberId: 'b', tenantId: 'tenant', organizationId: 'org-b', values: valuesB });
    });
    assert.equal(mounted.container.querySelector('strong').textContent, rendered(valuesB));
  } finally {
    await mounted.close();
  }
});
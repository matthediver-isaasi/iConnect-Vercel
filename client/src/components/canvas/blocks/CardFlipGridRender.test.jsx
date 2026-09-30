import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/page',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
const resizeObservers = new Set();
globalThis.ResizeObserver = class ResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.elements = new Set();
    resizeObservers.add(this);
  }
  observe(element) {
    this.elements.add(element);
  }
  unobserve(element) {
    this.elements.delete(element);
  }
  disconnect() {
    this.elements.clear();
    resizeObservers.delete(this);
  }
  static flush() {
    for (const observer of resizeObservers) {
      observer.callback(Array.from(observer.elements, (target) => ({ target })));
    }
  }
};
window.ResizeObserver = globalThis.ResizeObserver;
window.__TENANT_TYPOGRAPHY_STYLES__ = [];
globalThis.fetch = async () => ({ ok: true, json: async () => [] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: CanvasFlowStage } = await import('../CanvasFlowStage.jsx');
const { default: CanvasPageRenderer } = await import('../CanvasPageRenderer.jsx');
const {
  cardFlipColumnsForBreakpoint,
  getBlockDefinition,
  resolveCardFlipGridBreakpoint,
} = await import('./registry.jsx');

function cards(count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Card ${index + 1}`,
    summary: `Summary ${index + 1}`,
  }));
}

function block(overrides = {}) {
  return {
    id: 'flip-grid',
    type: 'card-flip-grid',
    style: {},
    content: {
      cards: cards(10),
      columns: { desktop: 4, tablet: 2, mobile: 1 },
      rowsPerPage: 2,
      gap: 16,
      shape: 'square',
      titlePosition: 'on',
      ...overrides,
    },
  };
}

const staticQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
});

function providers(child, queryClient = staticQueryClient) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        {child}
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function render(props = {}, content = {}) {
  const Renderer = getBlockDefinition('card-flip-grid').Renderer;
  return renderToStaticMarkup(providers(
    <Renderer block={block(content)} {...props} />,
  ));
}

test('resolves responsive and legacy numeric columns from the effective breakpoint', () => {
  assert.equal(resolveCardFlipGridBreakpoint('tablet', 'mobile'), 'tablet');
  assert.equal(resolveCardFlipGridBreakpoint(undefined, 'mobile'), 'mobile');
  assert.equal(resolveCardFlipGridBreakpoint(undefined, undefined), 'desktop');
  assert.equal(cardFlipColumnsForBreakpoint({ desktop: 4, tablet: 2, mobile: 1 }, 'mobile'), 1);
  assert.equal(cardFlipColumnsForBreakpoint(3, 'mobile'), 3);
});

test('unforced public mobile rendering uses mobile columns for both grid and pagination', () => {
  const html = render({ viewportBreakpoint: 'mobile' });
  assert.match(html, /data-breakpoint="mobile"/);
  assert.match(html, /data-columns="1"/);
  assert.match(html, /data-per-page="2"/);
  assert.match(html, /grid-template-columns:repeat\(1, minmax\(0, 1fr\)\)/);
  assert.match(html, />1 \/ 5</);
  assert.equal((html.match(/data-testid="card-flip-flip-grid-/g) || []).length, 2);
});

test('an explicit editor breakpoint overrides the public viewport and keeps capacity aligned', () => {
  const html = render({ asEditor: true, breakpoint: 'tablet', viewportBreakpoint: 'mobile' });
  assert.match(html, /data-breakpoint="tablet"/);
  assert.match(html, /data-columns="2"/);
  assert.match(html, /data-per-page="4"/);
  assert.match(html, /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, />1 \/ 3</);
  assert.equal((html.match(/data-testid="card-flip-flip-grid-/g) || []).length, 4);
});

test('the grid wrapper stays natural-height for every card shape and title band', () => {
  for (const shape of ['square', 'circular', 'rectangular']) {
    for (const titlePosition of ['on', 'above', 'below']) {
      const html = render(
        { viewportBreakpoint: 'desktop' },
        { cards: cards(4), shape, titlePosition, cardHeight: 240 },
      );
      assert.match(html, /class="w-full" data-testid="card-flip-grid-flip-grid"/);
      assert.doesNotMatch(html, /absolute inset-0 flex flex-col/);
      assert.match(html, /grid-template-columns:repeat\(4, minmax\(0, 1fr\)\)/);
      if (shape === 'rectangular') assert.match(html, /height:240px/);
    }
  }
});

test('viewport capacity changes clamp the current page and visible cards together', async () => {
  const Renderer = getBlockDefinition('card-flip-grid').Renderer;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const renderAt = async (viewportBreakpoint) => {
    await act(async () => {
      root.render(providers(
        <Renderer
          block={block({ rowsPerPage: 1 })}
          viewportBreakpoint={viewportBreakpoint}
        />,
        queryClient,
      ));
    });
  };

  try {
    await renderAt('mobile');
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        container.querySelector('[data-testid="card-flip-grid-flip-grid-next"]').click();
      });
    }
    assert.equal(container.querySelector('[data-testid="card-flip-grid-flip-grid-page"]').textContent.trim(), '6 / 10');
    assert.ok(container.querySelector('[data-testid="card-flip-flip-grid-5"]'));

    await renderAt('desktop');
    assert.equal(container.querySelector('[data-testid="card-flip-grid-flip-grid"]').dataset.columns, '4');
    assert.equal(container.querySelector('[data-testid="card-flip-grid-flip-grid"]').dataset.perPage, '4');
    assert.equal(container.querySelector('[data-testid="card-flip-grid-flip-grid-page"]').textContent.trim(), '3 / 3');
    assert.ok(container.querySelector('[data-testid="card-flip-flip-grid-8"]'));
    assert.ok(container.querySelector('[data-testid="card-flip-flip-grid-9"]'));
    assert.equal(container.querySelectorAll('[data-testid^="card-flip-flip-grid-"]').length, 2);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('flow layout clears a prior Card Flip Grid height when its content becomes empty', async () => {
  let measuredCardHeight = 300;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if (this.dataset?.cb === 'flow-flip-grid') return measuredCardHeight;
      return 0;
    },
  });
  const design = {
    version: 2,
    root: {
      sections: [{
        id: 'flow-section',
        type: 'section',
        flow: { padTop: 10, padBottom: 10, gap: 12 },
        children: [
          {
            ...block({ cards: cards(4) }),
            id: 'flow-flip-grid',
            flow: { heightMode: 'auto' },
          },
          {
            id: 'after-flow-grid',
            type: 'image',
            flow: { heightMode: 'fixed', height: 100 },
            style: {},
            content: {},
          },
        ],
      }],
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });

  try {
    await act(async () => {
      root.render(providers(
        <CanvasFlowStage design={design} forceBreakpoint="desktop" />,
        queryClient,
      ));
    });
    assert.equal(container.querySelector('[data-cb="after-flow-grid"]').style.top, '322px');

    measuredCardHeight = 0;
    await act(async () => {
      globalThis.ResizeObserver.flush();
    });
    assert.equal(container.querySelector('[data-cb="after-flow-grid"]').style.top, '22px');
    assert.equal(container.querySelector('[data-testid="canvas-page-stage"]').style.minHeight, '132px');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    } else {
      delete HTMLElement.prototype.offsetHeight;
    }
  }
});

test('legacy public Canvas renderer forwards the real viewport breakpoint to Card Flip Grid', async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
  const page = {
    id: 'page-card-grid',
    slug: 'card-grid',
    canvas_design: {
      version: 1,
      root: {
        sections: [{
          id: 'root',
          type: 'section',
          children: [{
            ...block({ rowsPerPage: 1 }),
            geom: { x: 0, y: 0, w: 800, h: 520 },
            bp: {
              desktop: { x: 0, y: 0, w: 800, h: 520 },
              tablet: { x: 0, y: 0, w: 768, h: 520 },
              mobile: { x: 0, y: 0, w: 375, h: 520 },
            },
          }],
        }],
      },
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });

  try {
    await act(async () => {
      root.render(providers(<CanvasPageRenderer page={page} />, queryClient));
    });
    const grid = () => container.querySelector('[data-testid="card-flip-grid-flip-grid"]');
    assert.equal(grid().dataset.breakpoint, 'mobile');
    assert.equal(grid().dataset.columns, '1');
    assert.equal(grid().dataset.perPage, '1');

    await act(async () => {
      window.innerWidth = 1200;
      window.dispatchEvent(new window.Event('resize'));
    });
    assert.equal(grid().dataset.breakpoint, 'desktop');
    assert.equal(grid().dataset.columns, '4');
    assert.equal(grid().dataset.perPage, '4');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    window.innerWidth = originalWidth;
  }
});
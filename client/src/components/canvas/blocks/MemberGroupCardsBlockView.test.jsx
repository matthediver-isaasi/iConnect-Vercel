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
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.ResizeObserver = globalThis.ResizeObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Simulate } = await import('react-dom/test-utils');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  buildMemberGroupCardsResponsiveCss,
  default: MemberGroupCardsBlockView,
} = await import('./MemberGroupCardsBlockView.jsx');
const { resolveMemberGroupCardLimit } = await import('../../../lib/memberGroupCards.js');
const { getBlockDefinition } = await import('./registry.jsx');

const groups = [
  { id: 'a', name: 'Alpha', allow_self_join: true },
  { id: 'b', name: 'Beta', allow_self_join: true, self_join_closed: true },
];

function render(overrides = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MemberGroupCardsBlockView
        block={{ id: 'block-1' }}
        groups={groups}
        isAuthenticated={false}
        assignmentByGroup={{}}
        openVacancyCountByGroup={{}}
        groupAdminIds={new Set()}
        isLoading={false}
        isError={false}
        accessRestricted={false}
        {...overrides}
      />
    </MemoryRouter>,
  );
}

test('legacy group cards retain the established responsive column treatment', () => {
  const html = render();
  assert.match(html, /data-member-group-cards-grid=""/);
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /max-width:1023\.98px[^]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /max-width:639\.98px[^]*repeat\(1,minmax\(0,1fr\)\)/);
  assert.match(html, /card-group-a/);
  assert.match(html, /card-group-b/);
  assert.match(html, /class="w-full"[^>]*data-testid="member-group-cards-block"/);
  assert.ok(!html.includes('w-full h-full overflow-auto'));
});

test('editor previews use the active breakpoint column count', () => {
  const block = {
    id: 'block-1',
    content: { columns: { desktop: 5, tablet: 3, mobile: 2 } },
  };
  assert.match(
    render({ block, breakpoint: 'desktop' }),
    /grid-template-columns:repeat\(5, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    render({ block, breakpoint: 'tablet' }),
    /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    render({ block, breakpoint: 'mobile' }),
    /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/,
  );
});

test('published cards emit scoped desktop, tablet, and mobile columns', () => {
  const css = buildMemberGroupCardsResponsiveCss(
    'cards-1',
    { desktop: 6, tablet: 4, mobile: 2 },
  );
  assert.match(css, /\[data-cb="cards-1"\] \[data-member-group-cards-grid\]/);
  assert.match(css, /repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /max-width:1023\.98px[^]*repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /max-width:639\.98px[^]*repeat\(2,minmax\(0,1fr\)\)/);
});

test('published grid scoping preserves valid persisted block IDs containing punctuation', () => {
  const blockId = 'cards.1 with space';
  const css = buildMemberGroupCardsResponsiveCss(
    blockId,
    { desktop: 4, tablet: 2, mobile: 1 },
  );
  const selector = css.slice(0, css.indexOf('{'));
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-cb', blockId);
  const grid = document.createElement('div');
  grid.setAttribute('data-member-group-cards-grid', '');
  wrapper.appendChild(grid);
  document.body.appendChild(wrapper);
  try {
    assert.equal(selector, '[data-cb="cards.1 with space"] [data-member-group-cards-grid]');
    assert.equal(document.querySelector(selector), grid);
  } finally {
    wrapper.remove();
  }
});

test('published grid scoping cannot break out of the responsive style tag', () => {
  const blockId = 'cards</style><img src=x onerror=alert(1)>';
  const css = buildMemberGroupCardsResponsiveCss(
    blockId,
    { desktop: 4, tablet: 2, mobile: 1 },
  );
  const selector = css.slice(0, css.indexOf('{'));
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-cb', blockId);
  const grid = document.createElement('div');
  grid.setAttribute('data-member-group-cards-grid', '');
  wrapper.appendChild(grid);
  document.body.appendChild(wrapper);
  try {
    assert.ok(!css.includes('</style>'));
    assert.equal(document.querySelector(selector), grid);
    const html = render({
      block: {
        id: blockId,
        content: { columns: { desktop: 4, tablet: 2, mobile: 1 } },
      },
    });
    assert.equal((html.match(/<\/style>/g) || []).length, 1);
    assert.ok(!html.includes('<img src=x'));
  } finally {
    wrapper.remove();
  }
});

test('loading placeholders and loaded cards share the same responsive grid contract', () => {
  const block = {
    id: 'block-1',
    content: { columns: { desktop: 4, tablet: 3, mobile: 2 } },
  };
  const loaded = render({ block });
  const loading = render({ block, groups: [], isLoading: true });
  assert.match(loaded, /data-member-group-cards-grid=""[^>]*data-testid="member-group-cards-grid"/);
  assert.match(loading, /data-member-group-cards-grid=""[^>]*data-testid="member-group-cards-loading"/);
  assert.match(loaded, /repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(loading, /repeat\(4,minmax\(0,1fr\)\)/);
});

test('the inspector persists a complete responsive columns object without dropping block metadata', async () => {
  const Inspector = getBlockDefinition('member-group-cards').Inspector;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const block = {
    id: 'block-1',
    type: 'member-group-cards',
    name: 'Member Group Cards',
    locked: true,
    content: {
      limit: 6,
      source: 'self_join',
      selectedGroupIds: [],
      selectedGroupRoles: {},
    },
  };
  const updates = [];

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inspector block={block} update={(updater) => updates.push(updater)} />
        </QueryClientProvider>,
      );
    });

    const desktop = container.querySelector('[data-testid="input-columns-desktop"]');
    const tablet = container.querySelector('[data-testid="input-columns-tablet"]');
    const mobile = container.querySelector('[data-testid="input-columns-mobile"]');
    assert.equal(desktop.value, '3');
    assert.equal(tablet.value, '2');
    assert.equal(mobile.value, '1');

    await act(async () => {
      Simulate.change(desktop, { target: { value: '5' } });
    });

    assert.equal(updates.length, 1);
    assert.equal(typeof updates[0], 'function');
    const next = updates[0](block);
    assert.equal(next.id, block.id);
    assert.equal(next.name, block.name);
    assert.equal(next.locked, true);
    assert.equal(next.content.limit, 6);
    assert.deepEqual(next.content.columns, { desktop: 5, tablet: 2, mobile: 1 });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('role-holder data is optional and one unavailable role does not block other cards', () => {
  const html = render({
    roleHolderByGroup: {
      a: {
        role: 'Chair',
        holders: [{
          id: 'member-1',
          name: 'Ada Lovelace',
          job_title: 'Director',
          organization_name: 'Analytical Society',
        }],
      },
      b: {
        role: 'Treasurer',
        holders: [],
        isError: true,
      },
    },
  });
  assert.match(html, /card-group-a/);
  assert.match(html, /card-group-b/);
  assert.match(html, /group-role-holder-a-member-1/);
  assert.match(html, /Ada Lovelace/);
  assert.ok(!html.includes('Treasurer'));
});

test('loading, empty, failed and access restricted states are explicit', () => {
  assert.match(render({ groups: [], isLoading: true }), /member-group-cards-loading/);
  assert.match(render({ groups: [] }), /member-group-cards-empty/);
  assert.match(render({ groups: [], isError: true, errorMessage: 'Unavailable' }), /role="alert"[^]*Unavailable/);
  assert.match(render({ accessRestricted: true }), /member-group-cards-restricted/);
  assert.match(render({ groups: [], manualMode: true, selectedGroupCount: 0 }), /Choose active member groups/);
  assert.match(render({ groups: [], manualMode: true, selectedGroupCount: 2 }), /selected member groups are currently available/);
});

test('the block clamps count values to the safe publishing bounds', () => {
  assert.equal(resolveMemberGroupCardLimit(undefined), 6);
  assert.equal(resolveMemberGroupCardLimit(0), 1);
  assert.equal(resolveMemberGroupCardLimit(25), 24);
  assert.equal(resolveMemberGroupCardLimit(12), 12);
});
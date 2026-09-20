import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/page',
  pretendToBeVisual: true,
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
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { publicClient } = await import('@/api/publicClient');
const { getBlockDefinition } = await import('./registry.jsx');
const {
  default: MemberGroupBlockView,
  guardEditorCardClick,
  resolveMemberGroupGrid,
} = await import('./MemberGroupBlockView.jsx');

const content = {
  showMembers: true,
  showGroupName: true,
  showGroupDescription: true,
  headingLevel: 2,
  rows: 2,
  columns: { desktop: 3, tablet: 2, mobile: 1 },
  gap: 16,
  emptyText: 'Nobody is serving right now.',
};

const members = [
  {
    id: 'm1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    group_role: 'Chair',
    organization_name: 'Analytical Society',
  },
  {
    id: 'm2',
    first_name: 'Grace',
    last_name: 'Hopper',
    group_role: 'Member',
  },
];

function render(overrides = {}) {
  return renderToStaticMarkup(
    <MemberGroupBlockView
      block={{ id: 'block-1' }}
      content={content}
      group={{ id: 'group-1', name: 'Leadership team', description: '<p>Current leaders</p>' }}
      records={members}
      displaySettings={{}}
      columns={3}
      pageSize={6}
      currentPage={1}
      total={2}
      isLoading={false}
      isError={false}
      isFetching={false}
      onPrevious={() => {}}
      onNext={() => {}}
      {...overrides}
    />,
  );
}

test('responsive capacity is rows multiplied by the active breakpoint columns', () => {
  assert.deepEqual(resolveMemberGroupGrid(content, 'desktop'), { columns: 3, rows: 2, pageSize: 6 });
  assert.deepEqual(resolveMemberGroupGrid(content, 'tablet'), { columns: 2, rows: 2, pageSize: 4 });
  assert.deepEqual(resolveMemberGroupGrid(content, 'mobile'), { columns: 1, rows: 2, pageSize: 2 });
});

test('group cards reuse directory treatment and show each group role', () => {
  const html = render();
  assert.match(html, /Leadership team/);
  assert.match(html, /Current leaders/);
  assert.match(html, /Ada/);
  assert.match(html, /Chair/);
  assert.match(html, /Grace/);
  assert.match(html, /Member/);
  assert.match(html, /Analytical Society/);
  assert.ok(!html.includes('button-member-group-prev'), 'one page has no pagination controls');
  assert.match(html, /class="w-full"[^>]*data-testid="member-group-block"/);
  assert.ok(!html.includes('w-full h-full overflow-auto'));
});

test('pagination controls and accessible page indicator appear only for multiple pages', () => {
  const html = render({ total: 13 });
  assert.match(html, /button-member-group-prev/);
  assert.match(html, /button-member-group-next/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /aria-live="polite"/);
});

test('loading, empty, and failure states are explicit', () => {
  assert.match(render({ records: [], isLoading: true }), /member-group-loading/);
  assert.match(render({ records: [], total: 0 }), /Nobody is serving right now/);
  assert.match(render({ records: [], isError: true, errorMessage: 'Unavailable' }), /role="alert"[^]*Unavailable/);
});

test('visibility toggles independently hide cards, group name, and description', () => {
  const html = render({
    content: {
      ...content,
      showMembers: false,
      showGroupName: false,
      showGroupDescription: false,
    },
  });
  assert.ok(!/<h2[^>]*>Leadership team<\/h2>/.test(html));
  assert.ok(!html.includes('Current leaders'));
  assert.ok(!html.includes('Ada'));
});

test('editor card guard prevents link navigation and Canvas selection', () => {
  let prevented = false;
  let stopped = false;
  guardEditorCardClick({
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

for (const mode of ['Editor', 'Renderer']) test(`${mode}: delayed Next, cached Previous, refresh and resets scroll only on public navigation`, async () => {
  const scrolls = [];
  window.scrollTo = (options) => scrolls.push(options);
  const flushScroll = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  const originalList = publicClient.listMemberGroupMembers;
  const calls = [];
  let rejectNext = false;
  let settleSecondPage;
  let secondPagePromise;
  publicClient.listMemberGroupMembers = ({ page, limit }) => {
    calls.push({ page, limit });
    if (rejectNext) return Promise.reject(new Error('Unavailable'));
    const response = {
      config: {
        group: { id: 'group-1', name: 'Leadership team' },
        displaySettings: {},
      },
      total: 3,
      records: page === 1
        ? members
        : [
          { id: 'm3', first_name: 'Katherine', last_name: 'Johnson' },
        ],
    };
    if (page === 2 && limit === 2) {
      secondPagePromise = new Promise((resolve) => {
        settleSecondPage = () => resolve(response);
      });
      return secondPagePromise;
    }
    return Promise.resolve(response);
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    ['canvas', 'public-member-group', 'group-1', [], 1, 2],
    {
      config: {
        group: { id: 'group-1', name: 'Leadership team' },
        displaySettings: {},
      },
      total: 3,
      records: members,
    },
  );
  const Editor = getBlockDefinition('member-group')[mode];
  const block = {
    id: 'member-group-live',
    type: 'member-group',
    style: {},
    content: {
      ...content,
      groupId: 'group-1',
      rows: 2,
      columns: { desktop: 3, tablet: 2, mobile: 1 },
    },
  };
  const renderEditor = (breakpoint) => (
    <QueryClientProvider client={queryClient}>
      <Editor block={block} breakpoint={breakpoint} />
    </QueryClientProvider>
  );

  try {
    await act(async () => {
      root.render(renderEditor('mobile'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      container.querySelector('[data-testid="text-member-group-page"]')?.textContent,
      'Page 1 of 2',
      `calls=${JSON.stringify(calls)} html=${container.innerHTML}`,
    );
    await flushScroll();
    assert.equal(scrolls.length, 0, 'initial load must not scroll');

    await act(async () => {
      container.querySelector('[data-testid="button-member-group-next"]').click();
    });
    assert.equal(
      container.querySelector('[data-testid="text-member-group-page"]')?.textContent,
      'Page 2 of 2',
      'placeholder total must prevent the uncached page from clamping back to page 1',
    );
    assert.equal(container.querySelector('[data-testid="button-member-group-next"]').disabled, true);
    assert.equal(container.querySelector('[data-testid="button-member-group-prev"]').disabled, true);
    await flushScroll();
    assert.equal(scrolls.length, 0, 'placeholder content must not scroll');

    await act(async () => {
      settleSecondPage();
      await secondPagePromise;
    });
    for (let attempt = 0; attempt < 10 && !container.textContent.includes('Katherine'); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    assert.equal(container.querySelector('[data-testid="text-member-group-page"]')?.textContent, 'Page 2 of 2');
    assert.match(container.textContent, /Katherine/);
    assert.equal(container.querySelector('[data-testid="button-member-group-next"]').disabled, true);
    assert.equal(container.querySelector('[data-testid="button-member-group-prev"]').disabled, false);
    await flushScroll();
    assert.equal(scrolls.length, mode === 'Renderer' ? 1 : 0);
    assert.equal(container.querySelectorAll('[data-testid="member-group-list"] > li').length, 1);

    await act(async () => {
      container.querySelector('[data-testid="button-member-group-prev"]').click();
    });
    assert.equal(container.querySelector('[data-testid="text-member-group-page"]')?.textContent, 'Page 1 of 2');
    await flushScroll();
    assert.equal(scrolls.length, mode === 'Renderer' ? 2 : 0, 'cached Previous scrolls once');
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['canvas', 'public-member-group', 'group-1', [], 1, 2] });
    });
    await flushScroll();
    assert.equal(scrolls.length, mode === 'Renderer' ? 2 : 0, 'background refresh must not scroll');

    await act(async () => {
      root.render(renderEditor('desktop'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector('[data-testid="text-member-group-page"]'), null);
    await flushScroll();
    assert.equal(scrolls.length, mode === 'Renderer' ? 2 : 0, 'breakpoint reset must not scroll');
    assert.deepEqual(calls.map(({ page, limit }) => [page, limit]), [[2, 2], [1, 2], [1, 6]]);
    await act(async () => root.render(renderEditor('mobile')));
    await flushScroll();
    queryClient.removeQueries({ queryKey: ['canvas', 'public-member-group', 'group-1', [], 2, 2], exact: true });
    rejectNext = true;
    await act(async () => {
      container.querySelector('[data-testid="button-member-group-next"]').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flushScroll();
    assert.ok(container.querySelector('[data-testid="member-group-error"]'));
    assert.equal(scrolls.length, mode === 'Renderer' ? 2 : 0, 'failed request must not scroll');
  } finally {
    publicClient.listMemberGroupMembers = originalList;
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('scroll ownership respects nested containers, sticky chrome, and block identity', async () => {
  const { scrollMemberGroupToTop } = await import('./memberGroupScroll.js');
  const owner = document.createElement('div');
  owner.style.overflowY = 'auto';
  const header = document.createElement('header');
  header.style.position = 'sticky';
  const first = document.createElement('div');
  const second = document.createElement('div');
  owner.append(header, first, second);
  document.body.append(owner);
  Object.defineProperties(owner, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 400 },
  });
  owner.scrollTop = 300;
  owner.getBoundingClientRect = () => ({ top: 100 });
  header.getBoundingClientRect = () => ({ top: 100, bottom: 160 });
  first.getBoundingClientRect = () => ({ top: 220 });
  second.getBoundingClientRect = () => ({ top: 700 });
  const nestedScrolls = [];
  const outerScrolls = [];
  owner.scrollTo = (options) => nestedScrolls.push(options);
  window.scrollTo = (options) => outerScrolls.push(options);
  try {
    scrollMemberGroupToTop(second);
    assert.deepEqual(nestedScrolls, [{ top: 832, behavior: 'instant' }]);
    assert.deepEqual(outerScrolls, []);
    scrollMemberGroupToTop(first);
    assert.equal(nestedScrolls[1].top, 352);
  } finally {
    owner.remove();
  }
});

test('multiple mounted blocks consume only their own navigation and cancel queued scrolling', async () => {
  const scrolls = [];
  window.scrollTo = (options) => scrolls.push(options);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    content, records: members, columns: 1, pageSize: 2, currentPage: 1, total: 4,
  };
  const firstNavigation = { page: 2 };
  const secondNavigation = { page: 2 };
  const tree = (first, second) => <>
    <MemberGroupBlockView {...props} block={{ id: 'first' }} pageNavigation={first} />
    <MemberGroupBlockView {...props} block={{ id: 'second' }} pageNavigation={second} />
  </>;
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  try {
    await act(async () => root.render(tree(null, null)));
    const blocks = container.querySelectorAll('[data-testid="member-group-block"]');
    blocks[0].getBoundingClientRect = () => ({ top: 200 });
    blocks[1].getBoundingClientRect = () => ({ top: 600 });
    await act(async () => root.render(tree(null, secondNavigation)));
    await flush();
    assert.deepEqual(scrolls.map(({ top }) => top), [592]);
    await act(async () => root.render(tree(null, secondNavigation)));
    await flush();
    assert.equal(scrolls.length, 1, 'unrelated render must not repeat scrolling');
    await act(async () => root.render(tree(firstNavigation, secondNavigation)));
    await act(async () => root.render(tree(null, secondNavigation)));
    await flush();
    assert.equal(scrolls.length, 1, 'reset cancels pending animation frames');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
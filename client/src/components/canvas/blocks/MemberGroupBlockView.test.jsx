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

test('one uncached mobile Next click survives loading, settles, and respects resets and boundaries', async () => {
  const originalList = publicClient.listMemberGroupMembers;
  const calls = [];
  let settleSecondPage;
  let secondPagePromise;
  publicClient.listMemberGroupMembers = ({ page, limit }) => {
    calls.push({ page, limit });
    const response = {
      config: {
        group: { id: 'group-1', name: 'Leadership team' },
        displaySettings: {},
      },
      total: 4,
      records: page === 1
        ? members
        : [
          { id: 'm3', first_name: 'Katherine', last_name: 'Johnson' },
          { id: 'm4', first_name: 'Dorothy', last_name: 'Vaughan' },
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
      total: 4,
      records: members,
    },
  );
  const Editor = getBlockDefinition('member-group').Editor;
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

    await act(async () => {
      container.querySelector('[data-testid="button-member-group-prev"]').click();
    });
    assert.equal(container.querySelector('[data-testid="text-member-group-page"]')?.textContent, 'Page 1 of 2');

    await act(async () => {
      root.render(renderEditor('desktop'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector('[data-testid="text-member-group-page"]'), null);
    assert.deepEqual(calls.map(({ page, limit }) => [page, limit]), [[2, 2], [1, 6]]);
  } finally {
    publicClient.listMemberGroupMembers = originalList;
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
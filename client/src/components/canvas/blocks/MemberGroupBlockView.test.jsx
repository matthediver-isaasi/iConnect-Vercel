import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const React = (await import('react')).default;
globalThis.React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
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
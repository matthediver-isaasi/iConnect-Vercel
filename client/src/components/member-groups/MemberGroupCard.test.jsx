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
const { MemoryRouter } = await import('react-router-dom');
const {
  default: MemberGroupCard,
  guardMemberGroupCardEditorInteraction,
} = await import('./MemberGroupCard.jsx');
const {
  buildMemberGroupCardDestination,
  isMemberGroupCardActivationKey,
} = await import('../../lib/memberGroupCards.js');

const group = {
  id: 'group-1',
  name: 'Leadership network',
  description: '<p>A network for <strong>leaders</strong>.</p><script>alert(1)</script>',
  default_self_join_role: 'Member',
};

function render(overrides = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MemberGroupCard group={group} isAuthenticated={false} {...overrides} />
    </MemoryRouter>,
  );
}

test('guest card keeps the canonical image fallback, sanitised description, and login CTA', () => {
  const html = render();
  assert.match(html, /Leadership network/);
  assert.match(html, /A network for <strong>leaders<\/strong>/);
  assert.ok(!html.includes('alert(1)'), 'untrusted description script is removed');
  assert.match(html, /Member only content - Click to login/);
  assert.match(html, /role="link"/);
  assert.match(html, /tabindex="0"/);
});

test('authenticated card shows joined role, group-admin and vacancy indicators', () => {
  const html = render({
    isAuthenticated: true,
    assignment: { group_role: 'Chair' },
    isGroupAdmin: true,
    openVacancyCount: 2,
  });
  assert.match(html, /2 open vacancies/);
  assert.match(html, /You have joined the group as/);
  assert.match(html, /Chair/);
  assert.match(html, /badge-group-admin-group-1/);
  assert.match(html, /Find out more/);
});

test('Canvas cards show every supplied safe holder while ordinary cards remain unchanged', () => {
  const html = render({
    featuredRole: 'Chair',
    roleHolders: [
      {
        id: 'member-1',
        name: 'Ada Lovelace',
        job_title: 'Director',
        organization_name: 'Analytical Society',
        profile_photo_url: 'https://example.test/ada.jpg',
      },
      {
        id: 'member-2',
        first_name: 'Grace',
        last_name: 'Hopper',
        subtitle: 'Admiral',
      },
    ],
  });
  assert.match(html, /group-role-holders-group-1/);
  assert.match(html, />Chair</);
  assert.match(html, /Ada Lovelace/);
  assert.match(html, /Director/);
  assert.match(html, /Analytical Society/);
  assert.match(html, /https:\/\/example.test\/ada.jpg/);
  assert.match(html, /Grace Hopper/);
  assert.match(html, /Admiral/);

  const noPublishableHolder = render({
    featuredRole: 'Chair',
    roleHolders: [],
  });
  assert.ok(!noPublishableHolder.includes('group-role-holders-group-1'));
  assert.ok(!render().includes('group-role-holders-group-1'));
});

test('standalone self-join cards preserve the legacy joined display for an existing assignment', () => {
  const html = render({
    isAuthenticated: true,
    assignment: { group_role: 'Former member', expires_at: '2020-01-01' },
  });
  assert.match(html, /You have joined the group as/);
  assert.match(html, /Former member/);
  assert.match(html, /Find out more/);
});

test('closed registration retains its disabled CTA for guests and members', () => {
  const html = render({
    group: { ...group, self_join_closed: true, self_join_closed_label: 'Applications are closed' },
    isAuthenticated: true,
  });
  assert.match(html, /Applications are closed/);
  assert.match(html, /disabled=""/);
  assert.ok(!html.includes('Find out more'));
});

test('editor interaction guard stops navigation safely', () => {
  let prevented = false;
  let stopped = false;
  guardMemberGroupCardEditorInteraction({
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('card destinations preserve guest return targets and authenticated detail links', () => {
  assert.equal(
    buildMemberGroupCardDestination({
      groupId: 'group 1',
      isAuthenticated: false,
      detailPath: '/MemberGroupDetail',
    }),
    '/login?returnTo=%2FMemberGroupDetail&groupId=group%201',
  );
  assert.equal(
    buildMemberGroupCardDestination({
      groupId: 'group-1',
      isAuthenticated: true,
      detailPath: '/MemberGroupDetail',
    }),
    '/MemberGroupDetail?id=group-1',
  );
  assert.equal(isMemberGroupCardActivationKey('Enter'), true);
  assert.equal(isMemberGroupCardActivationKey(' '), true);
  assert.equal(isMemberGroupCardActivationKey('Tab'), false);
});
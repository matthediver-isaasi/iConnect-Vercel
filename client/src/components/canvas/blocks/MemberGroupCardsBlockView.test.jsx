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
const { default: MemberGroupCardsBlockView } = await import('./MemberGroupCardsBlockView.jsx');
const { resolveMemberGroupCardLimit } = await import('../../../lib/memberGroupCards.js');

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

test('the group card grid matches the Member Groups responsive treatment', () => {
  const html = render();
  assert.match(html, /grid md:grid-cols-2 lg:grid-cols-3 gap-6/);
  assert.match(html, /card-group-a/);
  assert.match(html, /card-group-b/);
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
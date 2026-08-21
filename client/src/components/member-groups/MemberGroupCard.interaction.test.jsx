import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/MemberGroups',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { default: MemberGroupCard } = await import('./MemberGroupCard.jsx');

const group = {
  id: 'group-1',
  name: 'Leadership network',
  allow_self_join: true,
  default_self_join_role: 'Member',
};

async function mount(overrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const navigations = [];

  await act(async () => {
    root.render(
      <MemoryRouter>
        <MemberGroupCard
          group={group}
          isAuthenticated={false}
          onNavigate={(destination) => navigations.push(destination)}
          {...overrides}
        />
      </MemoryRouter>,
    );
  });

  return {
    container,
    navigations,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function click(element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function press(element, key) {
  element.dispatchEvent(new window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

test('guest whole-card and CTA activation use the login return target exactly once', async () => {
  const view = await mount();
  const card = view.container.querySelector('[data-testid="card-group-group-1"]');
  const cta = view.container.querySelector('[data-testid="button-login-required-group-1"]');

  await act(async () => click(card));
  assert.deepEqual(view.navigations, ['/login?returnTo=%2FMemberGroupDetail&groupId=group-1']);

  view.navigations.length = 0;
  await act(async () => click(cta));
  assert.deepEqual(view.navigations, ['/login?returnTo=%2FMemberGroupDetail&groupId=group-1']);
  await view.cleanup();
});

test('authenticated cards activate with Enter and Space and ignore unrelated keys', async () => {
  const view = await mount({ isAuthenticated: true });
  const card = view.container.querySelector('[data-testid="card-group-group-1"]');

  await act(async () => press(card, 'Tab'));
  assert.deepEqual(view.navigations, []);
  await act(async () => press(card, 'Enter'));
  await act(async () => press(card, ' '));
  assert.deepEqual(view.navigations, [
    '/MemberGroupDetail?id=group-1',
    '/MemberGroupDetail?id=group-1',
  ]);
  await view.cleanup();
});

test('closed CTA is disabled while whole-card detail activation remains available', async () => {
  const view = await mount({
    isAuthenticated: true,
    group: { ...group, self_join_closed: true },
  });
  const card = view.container.querySelector('[data-testid="card-group-group-1"]');
  const cta = view.container.querySelector('[data-testid="button-closed-group-1"]');

  assert.equal(cta.disabled, true);
  await act(async () => click(cta));
  assert.deepEqual(view.navigations, []);
  await act(async () => click(card));
  assert.deepEqual(view.navigations, ['/MemberGroupDetail?id=group-1']);
  await view.cleanup();
});

test('editor mode suppresses card, CTA and keyboard navigation without trapping Tab', async () => {
  const view = await mount({ asEditor: true, isAuthenticated: true });
  const card = view.container.querySelector('[data-testid="card-group-group-1"]');
  const cta = view.container.querySelector('[data-testid="button-find-out-more-group-1"]');

  await act(async () => click(card));
  await act(async () => click(cta));
  await act(async () => press(card, 'Enter'));
  const tabEvent = new window.KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => card.dispatchEvent(tabEvent));

  assert.deepEqual(view.navigations, []);
  assert.equal(tabEvent.defaultPrevented, false);
  await view.cleanup();
});

test('managed group cards are only actionable for a current member or group admin', async () => {
  const managedGroup = { ...group, allow_self_join: false, default_self_join_role: '' };
  const guestView = await mount({ group: managedGroup });
  const guestCard = guestView.container.querySelector('[data-testid="card-group-group-1"]');
  const memberOnly = guestView.container.querySelector('[data-testid="button-members-only-group-1"]');
  assert.equal(memberOnly.disabled, true);
  assert.equal(guestCard.getAttribute('role'), null);
  await act(async () => click(guestCard));
  assert.deepEqual(guestView.navigations, []);
  await guestView.cleanup();

  const memberView = await mount({
    group: managedGroup,
    isAuthenticated: true,
    assignment: { group_id: 'group-1' },
  });
  const memberCard = memberView.container.querySelector('[data-testid="card-group-group-1"]');
  await act(async () => click(memberCard));
  assert.deepEqual(memberView.navigations, ['/MemberGroupDetail?id=group-1']);
  await memberView.cleanup();

  const expiredView = await mount({
    group: managedGroup,
    isAuthenticated: true,
    assignment: { group_id: 'group-1', expires_at: '2020-01-01' },
  });
  const expiredCard = expiredView.container.querySelector('[data-testid="card-group-group-1"]');
  assert.equal(expiredCard.getAttribute('role'), null);
  assert.equal(expiredView.container.querySelector('[data-testid="text-joined-role-group-1"]'), null);
  await act(async () => click(expiredCard));
  assert.deepEqual(expiredView.navigations, []);
  await expiredView.cleanup();
});
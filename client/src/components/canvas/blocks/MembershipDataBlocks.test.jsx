import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test/' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'CustomEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.ResizeObserver = globalThis.ResizeObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Simulate } = await import('react-dom/test-utils');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { MembershipDataView, MembershipDataInspector } = await import('./MembershipDataBlocks.jsx');
const { getCanvasMembershipDefaults, MEMBERSHIP_DATA_STATES, MEMBERSHIP_TEXT_ROLES } = await import('../../../lib/canvasMembershipData.js');

const live = {
  membership: { state: 'active', memberSince: '2017-01-01', membershipType: 'Professional' },
  payment: { state: 'active', method: 'monthly_direct_debit', nextPayment: '2029-10-01' },
};
function render(overrides = {}) {
  return renderToStaticMarkup(<MembershipDataView
    block={{ id: 'membership-test', content: {} }}
    result={{ status: 'ready', data: live }}
    {...overrides}
  />);
}

test('summary semantic labels, values, responsive grid and sample boundary', () => {
  const html = render();
  assert.match(html, /Membership Active/);
  assert.match(html, /<dl[^]*<dt[^]*Member since/);
  assert.match(html, /2017/);
  assert.match(html, /Professional/);
  assert.match(html, /Monthly Direct Debit/);
  assert.match(html, /1 October 2029/);
  assert.match(html, /@container \(max-width:380px\)/);
  assert.doesNotMatch(html, /sample data/);
  assert.match(render({ asEditor: true, result: { status: 'ready', data: live, isSample: true } }), /sample data, not a member record/);
});

test('all lifecycle states select their own copy for both cards', () => {
  for (const type of ['membership-summary', 'payment-details']) {
    const defaults = getCanvasMembershipDefaults(type);
    for (const state of MEMBERSHIP_DATA_STATES) {
      const html = render({
        type, result: { status: 'ready', data: {
          membership: { ...live.membership, state }, payment: { ...live.payment, state },
        } },
      });
      assert.ok(html.includes(defaults.states[state].heading));
      assert.ok(html.includes(defaults.states[state].supporting));
      assert.ok(html.includes(`data-membership-state="${state}"`));
      if (state !== 'active') {
        assert.ok(!html.includes(defaults.states.active.heading));
        assert.ok(!html.includes(defaults.states.active.supporting));
      }
    }
  }
});

test('guest, denied, error and loading never paint cached active data', () => {
  for (const status of ['guest', 'denied', 'error', 'loading']) {
    const html = render({ result: { status, data: live } });
    assert.ok(html.includes(getCanvasMembershipDefaults().messages[status]));
    assert.doesNotMatch(html, /Membership Active|Professional|Monthly Direct Debit|1 October 2029/);
    if (status === 'error' || status === 'denied') assert.match(html, /role="alert"/);
  }
  assert.match(render({ result: { status: 'ready', data: {} } }), /Not available/);
});

test('manage payments hidden without safe destination, editor prevents navigation, new tab is safe', () => {
  for (const manageLink of ['', 'javascript:alert(1)', '//evil.test']) {
    assert.doesNotMatch(render({ type: 'payment-details', block: { id: 'p', content: { manageLink } } }), /<a /);
  }
  const html = render({ type: 'payment-details', block: { id: 'p', content: {
    manageLink: '/membership-payments', manageLinkText: 'Review payments', manageLinkNewTab: true,
  } } });
  assert.match(html, /href="\/membership-payments"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Review payments/);
  assert.doesNotMatch(render({ type: 'payment-details', block: { id: 'p', content: { manageLink: '/pay' } }, result: { status: 'guest' } }), /<a /);
});

test('seven typography roles resolve saved IDs and responsive CSS on their text elements', () => {
  const content = getCanvasMembershipDefaults();
  content.typography = Object.fromEntries(MEMBERSHIP_TEXT_ROLES.map(role => [role, 'tenant-style']));
  const tenantStyles = [{ id: 'tenant-style', font_family: 'Example Serif', font_size: 24, font_size_mobile: 15, line_height: 1.7, color: '#123456' }];
  const html = render({ block: { id: 'typo', content }, tenantStyles });
  for (const role of MEMBERSHIP_TEXT_ROLES) assert.ok(html.includes(`[data-membership-role="${role}"]`));
  assert.match(html, /font-family:Example Serif/);
  assert.match(html, /font-size:15px !important/);
  const mobile = render({ block: { id: 'typo', content }, tenantStyles, asEditor: true, breakpoint: 'mobile' });
  assert.match(mobile, /font-size:15px/);
  assert.doesNotMatch(mobile, /font-size:15px !important/);
  assert.match(render({ block: { id: 'typo', content }, stylesResolved: false }), /visibility:hidden/);
  assert.doesNotMatch(render({ block: { id: 'typo', content }, stylesResolved: true }), /visibility:hidden/);
});

test('inspector state edits preserve metadata, independent state copy, seven style selectors and panel controls', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Avoid unrelated typography/colour network reads in this authoring test.
  client.setQueryData(['/api/public/typography-styles', null], [{ id: 'heading-style', name: 'Heading', style_type: 'h2' }]);
  const block = { id: 'p', type: 'payment-details', locked: true, content: {} };
  const updates = [];
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <MembershipDataInspector block={block} update={updater => updates.push(updater)} />
    </QueryClientProvider>));
    const state = container.querySelector('[data-testid="membership-state-wording"]');
    await act(async () => Simulate.change(state, { target: { value: 'paused' } }));
    const heading = container.querySelector('[data-testid="membership-input-paused-heading"]');
    await act(async () => Simulate.change(heading, { target: { value: 'Collections on hold' } }));
    const next = updates.at(-1)(block);
    assert.equal(next.content.states.paused.heading, 'Collections on hold');
    assert.equal(next.content.states.active.heading, 'Your payment method');
    assert.equal(next.locked, true);
    assert.equal(next.id, 'p');
    for (const role of MEMBERSHIP_TEXT_ROLES) assert.ok(container.querySelector(`[data-testid="membership-typography-${role}"]`));
    assert.ok(container.querySelector('[data-testid="membership-panel-background"]'));
    assert.ok(container.querySelector('[data-testid="membership-manage-link"]'));
    assert.equal(next.content.sample, undefined);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test('the configured payment link cannot navigate from an editor sample', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MembershipDataView
      block={{ id: 'payment-preview', content: { manageLink: '/payments' } }}
      type="payment-details" asEditor
      result={{ status: 'ready', data: live, isSample: true }}
    />));
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    container.querySelector('a').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
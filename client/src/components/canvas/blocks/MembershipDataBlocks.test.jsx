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
const {
  getCanvasMembershipDefaults, MEMBERSHIP_DATA_STATES, MEMBERSHIP_PAYMENT_STATES, MEMBERSHIP_TEXT_ROLES,
} = await import('../../../lib/canvasMembershipData.js');

const live = {
  membership: { state: 'active', memberSince: '2017-01-01', membershipType: 'Professional' },
  payment: {
    state: 'active', method: 'monthly_direct_debit', nextPayment: '2029-10-01',
    amount: 21.5, currency: 'GBP', collectionStatus: 'planned',
    plannedPayment: { date: '2029-10-01', amount: 21.5, currency: 'GBP' }, mandateStatus: 'active',
  },
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
  assert.match(html, /Your membership/);
  assert.match(html, /<dl[^]*<dt[^]*Member since/);
  assert.match(html, /2017/);
  assert.match(html, /Next payment amount/);
  assert.match(html, /£21.50/);
  assert.match(html, /Monthly Direct Debit/);
  assert.match(html, /Planned payment date/);
  assert.match(html, /1 October 2029/);
  assert.match(html, /@container \(max-width:380px\)/);
  assert.doesNotMatch(html, /sample data/);
  assert.match(render({ asEditor: true, result: { status: 'ready', data: live, isSample: true } }), /sample data, not a member record/);
});

test('responsive outer minimum height subtracts wrapper chrome and keeps Auto content-sized', () => {
  const style = {
    paddingTop: 20, paddingBottom: 30, borderStyle: 'solid', borderWidth: 2,
  };
  const html = render({ block: {
    id: 'minimum-height', style,
    content: { minHeight: { desktop: 500, tablet: 360, mobile: 0 } },
  } });
  assert.match(html, /min-height:446px/);
  assert.match(html, /max-width:1023\.98px[^]*min-height:306px/);
  assert.match(html, /max-width:639\.98px[^]*min-height:0px/);
  const mobile = render({ breakpoint: 'mobile', block: {
    id: 'minimum-height-mobile', style, content: { minHeight: 280 },
  } });
  assert.match(mobile, /min-height:226px/);
  assert.doesNotMatch(mobile, /@media \(max-width:1023\.98px\).*min-height/);
  assert.match(render(), /min-height:0/);
});

test('all lifecycle states select their own copy for both cards', () => {
  for (const type of ['membership-summary', 'payment-details']) {
    const defaults = getCanvasMembershipDefaults(type);
    const states = type === 'payment-details' ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES;
    for (const state of states) {
      const html = render({
        type, result: { status: 'ready', data: {
          membership: { ...live.membership, state }, payment: { ...live.payment, state },
        } },
      });
      assert.ok(html.includes(defaults.states[state].heading));
      assert.ok(html.includes(defaults.states[state].supporting));
      assert.ok(html.includes(`data-membership-state="${state}"`));
      if (state !== 'active') assert.ok(!html.includes(defaults.states.active.supporting));
    }
  }
});

test('paid-upfront cards render renewal without implying an automatic charge', () => {
  const paid = {
    membership: { ...live.membership, renewalDate: '2030-04-15' },
    payment: { state: 'paid', method: 'card', nextPayment: null },
  };
  const paymentHtml = render({
    type: 'payment-details', result: { status: 'ready', data: paid },
  });
  assert.match(paymentHtml, /Payment details/);
  assert.match(paymentHtml, /Your current membership has been paid in full\./);
  assert.doesNotMatch(paymentHtml, /automatic|auto-renew|saved card/i);

  const summaryHtml = render({ result: { status: 'ready', data: paid } });
  assert.doesNotMatch(summaryHtml, /Next payment amount|Payment method|Payment date/);

  const withoutRenewal = {
    membership: live.membership,
    payment: { state: 'paid', method: 'bank_transfer', nextPayment: null },
  };
  for (const type of ['membership-summary', 'payment-details']) {
    const html = render({ type, result: { status: 'ready', data: withoutRenewal } });
    assert.doesNotMatch(html, /automatic|auto-renew|saved card/i);
  }
});

test('recurring Direct Debit keeps its actual next payment presentation', () => {
  const html = render({ result: { status: 'ready', data: live } });
  assert.match(html, /Monthly Direct Debit/);
  assert.match(html, /Next payment/);
  assert.match(html, /1 October 2029/);
  assert.doesNotMatch(html, /Renewal date|No scheduled payment recorded/);
});

test('planned payment never presents as confirmed and Flat Rate is hidden', () => {
  const html = render({ result: { status: 'ready', data: {
    membership: { state: 'active', memberSince: null, paymentHistoryFrom: '2021-03-01' },
    payment: {
      state: 'active', method: 'flat_rate', amount: 0, currency: 'GBP',
      nextPayment: '2030-11-01',
      plannedPayment: { date: '2030-11-01', amount: 0, currency: 'GBP' },
      confirmedPayment: { date: '2030-10-01', amount: 12.5, currency: 'GBP', historical: true },
      collectionStatus: 'planned',
    },
  } } });
  assert.match(html, /Join date not recorded/);
  assert.match(html, /£0.00/);
  assert.match(html, /Planned payment date/);
  assert.match(html, /1 November 2030/);
  assert.match(html, /Payment history from[^]*March 2021/);
  assert.doesNotMatch(html, /Flat Rate|1 October 2030/);
});

test('next collection is prioritised in payment details while historical confirmation is never a next collection', () => {
  const data = {
    membership: { state: 'active' },
    payment: {
      state: 'active', method: 'monthly_direct_debit', amount: 24, currency: 'GBP', collectionStatus: 'confirmed',
      nextPayment: '2031-01-15',
      nextCollection: { date: '2031-01-15', amount: 24, currency: 'GBP', status: 'confirmed' },
      confirmedPayment: { date: '2030-12-15', amount: 22, currency: 'GBP', historical: true },
      mandateStatus: 'active',
    },
  };
  const html = render({ type: 'payment-details', result: { status: 'ready', data } });
  assert.match(html, /Next payment amount[^]*£24.00/);
  assert.match(html, /Historical confirmed payment[^]*15 December 2030/);
  assert.match(html, /Confirmed payment date[^]*15 January 2031/);
  assert.match(html, /Direct Debit status[^]*active/);
  const summary = render({ result: { status: 'ready', data } });
  assert.match(summary, /Next payment amount[^]*£24.00/);
  assert.match(summary, /Confirmed payment date[^]*15 January 2031/);
  assert.doesNotMatch(summary, /15 December 2030/);
});

test('guest, denied, error and loading never paint cached active data', () => {
  for (const status of ['guest', 'denied', 'error', 'loading']) {
    const html = render({ result: { status, data: live } });
    assert.ok(html.includes(getCanvasMembershipDefaults().messages[status]));
    assert.doesNotMatch(html, /Professional|Monthly Direct Debit|1 October 2029/);
    if (status === 'error' || status === 'denied') assert.match(html, /role="alert"/);
  }
  assert.match(render({ result: { status: 'ready', data: {} } }), /Join date not recorded/);
});

test('published payment details hide only for a ready normalized none state', () => {
  const none = {
    membership: { state: 'active' },
    payment: { state: 'none' },
  };
  const published = render({
    type: 'payment-details',
    result: { status: 'ready', data: none },
  });
  assert.match(published, /data-payment-details-visibility="hidden"/);
  assert.match(published, /hidden=""/);
  assert.match(
    published,
    /\[data-block-type="payment-details"\]:has\(> \[data-payment-details-visibility="hidden"\]\)\{display:none !important\}/,
  );

  const editor = render({
    type: 'payment-details',
    asEditor: true,
    result: { status: 'ready', data: none, isSample: true },
  });
  assert.doesNotMatch(editor, /<section[^>]*data-payment-details-visibility="hidden"/);
  assert.doesNotMatch(editor, /<section[^>]*hidden=""/);
  assert.match(editor, /No payment arrangement/);

  for (const result of [
    { status: 'loading', data: none },
    { status: 'error', data: none },
    { status: 'ready', data: { membership: {}, payment: { state: 'unavailable' } } },
    { status: 'ready', data: { membership: {}, payment: { state: 'unexpected' } } },
  ]) {
    const html = render({ type: 'payment-details', result });
    assert.doesNotMatch(html, /<section[^>]*data-payment-details-visibility="hidden"/);
    assert.doesNotMatch(html, /<section[^>]*hidden=""/);
  }

  const summary = render({ result: { status: 'ready', data: none } });
  assert.doesNotMatch(summary, /<section[^>]*data-payment-details-visibility="hidden"/);
});

test('custom membership type remains paired to the actual record while generated type copy retires', () => {
  const data = {
    membership: { state: 'active', membershipType: 'Chartered member' },
    payment: { state: 'active', method: 'card', amount: 12, currency: 'GBP', collectionStatus: 'unscheduled' },
  };
  const custom = render({ block: { id: 'custom-type', content: {
    fields: { membershipType: 'Membership level' },
  } }, result: { status: 'ready', data } });
  assert.match(custom, /Membership level[^]*Chartered member/);
  const generated = render({ block: { id: 'old-type', content: {
    fields: { membershipType: 'Membership type' },
  } }, result: { status: 'ready', data } });
  assert.doesNotMatch(generated, /Membership type|Chartered member/);
});

test('authored legacy and semantic collection labels render for their matching future evidence', () => {
  const planned = {
    membership: { state: 'active' },
    payment: {
      state: 'active', method: 'card', amount: 12, currency: 'GBP', collectionStatus: 'planned',
      nextPayment: '2031-03-01', nextCollection: { date: '2031-03-01', amount: 12, currency: 'GBP', status: 'planned' },
    },
  };
  const legacy = render({ block: { id: 'legacy-date', content: {
    fields: { nextPayment: 'Collection expected on' },
  } }, result: { status: 'ready', data: planned } });
  assert.match(legacy, /Collection expected on[^]*1 March 2031/);
  const confirmed = render({ block: { id: 'confirmed-date', content: {
    fields: { confirmedPaymentDate: 'Provider-confirmed collection date' },
  } }, result: { status: 'ready', data: { ...planned, payment: {
    ...planned.payment, collectionStatus: 'confirmed',
    nextCollection: { ...planned.payment.nextCollection, status: 'confirmed' },
  } } } });
  assert.match(confirmed, /Provider-confirmed collection date[^]*1 March 2031/);
});

test('organisation and paid-upfront records do not imply a pending collection', () => {
  const organisation = render({ result: { status: 'ready', data: {
    membership: { state: 'active', membershipType: 'Organisation membership' },
    payment: { state: 'unavailable', method: 'unavailable', amount: null, collectionStatus: 'unavailable' },
  } } });
  assert.doesNotMatch(organisation, /Next payment amount|Payment method|Payment date/);
  const paid = render({ result: { status: 'ready', data: {
    membership: { state: 'active' },
    payment: { state: 'paid', method: 'card', amount: null, collectionStatus: 'unavailable' },
  } } });
  assert.doesNotMatch(paid, /Next payment amount|Payment method|Payment date/);
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
    assert.ok([...state.options].some(option => option.value === 'paid'));
    await act(async () => Simulate.change(state, { target: { value: 'paused' } }));
    const heading = container.querySelector('[data-testid="membership-input-paused-heading"]');
    await act(async () => Simulate.change(heading, { target: { value: 'Collections on hold' } }));
    const next = updates.at(-1)(block);
    assert.equal(next.content.states.paused.heading, 'Collections on hold');
    assert.equal(next.content.states.active.heading, 'Payment details');
    assert.equal(next.locked, true);
    assert.equal(next.id, 'p');
    for (const role of MEMBERSHIP_TEXT_ROLES) assert.ok(container.querySelector(`[data-testid="membership-typography-${role}"]`));
    assert.ok(container.querySelector('[data-testid="membership-panel-background"]'));
    assert.ok(container.querySelector('[data-testid="membership-manage-link"]'));
    const heightMode = container.querySelector('[data-testid="membership-min-height-mode"]');
    assert.equal(heightMode.value, 'auto');
    assert.match(
      container.querySelector('[data-testid="membership-min-height-help"]').textContent,
      /outer padding and border[^]*will not be clipped/i,
    );
    await act(async () => Simulate.change(heightMode, { target: { value: 'custom' } }));
    const heightBlock = updates.at(-1)(block);
    assert.equal(heightBlock.content.minHeight, 330);
    assert.equal(next.content.sample, undefined);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <MembershipDataInspector block={{ ...block, type: 'membership-summary' }} update={() => {}} />
    </QueryClientProvider>));
    assert.equal(
      [...container.querySelector('[data-testid="membership-state-wording"]').options]
        .some(option => option.value === 'paid'),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test('inspector writes independent responsive Auto and custom minimum heights', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const block = {
    id: 'responsive-height', type: 'membership-summary',
    content: { minHeight: { desktop: 480, tablet: 360 } },
  };
  const updates = [];
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <MembershipDataInspector block={block} breakpoint="mobile" update={updater => updates.push(updater)} />
    </QueryClientProvider>));
    assert.equal(container.querySelector('[data-testid="membership-min-height-mode"]').value, 'custom');
    assert.equal(container.querySelector('[data-testid="membership-min-height"]').value, '360');
    await act(async () => Simulate.change(
      container.querySelector('[data-testid="membership-min-height"]'),
      { target: { value: '' } },
    ));
    const next = updates.at(-1)(block);
    assert.deepEqual(next.content.minHeight, { desktop: 480, tablet: 360, mobile: 0 });
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
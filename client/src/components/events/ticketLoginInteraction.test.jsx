import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { canLoginForTicket, ticketLoginInteraction } from './ticketLoginInteraction.js';

const eligible = { purchasable: false, authenticated: false, released: true,
  soldOut: false, registrationClosed: false, eventSoldOut: false };

test('only otherwise available logged-out restricted tickets invite login', () => {
  assert.equal(canLoginForTicket(eligible), true);
  for (const override of [{ purchasable: true }, { authenticated: true }, { released: false },
    { soldOut: true }, { registrationClosed: true }, { eventSoldOut: true }]) {
    assert.equal(canLoginForTicket({ ...eligible, ...override }), false);
    assert.deepEqual(ticketLoginInteraction(false, () => {}), {});
  }
});

test('whole ticket, message, price and keyboard each open login once without selecting a ticket', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, React,
    IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import('react-dom/client');
  const { default: Message } = await import('./TicketRestrictionMessage.jsx');
  const container = document.getElementById('root');
  const root = createRoot(container);
  let opened = 0;
  try {
    await act(async () => root.render(
      <div {...ticketLoginInteraction(true, () => opened++, 'Member ticket')}>
        <span data-testid="name">Member ticket</span>
        <Message {...eligible} ticket={{ role_match_only: true, role_ids: ['member'] }}
          suffix="test" cardLogin />
        <span data-testid="price">£675.00</span>
      </div>
    ));
    const card = container.firstChild;
    assert.equal(card.tabIndex, 0);
    assert.equal(card.getAttribute('role'), 'button');
    assert.equal(container.querySelector('button'), null, 'no nested interactive login control');
    assert.equal(container.querySelector('[data-testid="ticket-disabled-test"]').textContent,
      'Member only - click to login');
    for (const target of [card, ...container.querySelectorAll('[data-testid="name"], [data-testid="price"], [data-testid="link-login-ticket-test"]')]) {
      const before = opened;
      await act(async () => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      assert.equal(opened, before + 1);
    }
    for (const key of ['Enter', ' ']) {
      const before = opened;
      await act(async () => card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      assert.equal(opened, before + 1);
    }
    await act(async () => root.render(<Message {...eligible} authenticated ticket={{ role_match_only: true, role_ids: ['member'] }} suffix="test" />));
    assert.match(container.textContent, /not eligible/);
    assert.doesNotMatch(container.textContent, /click to login/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
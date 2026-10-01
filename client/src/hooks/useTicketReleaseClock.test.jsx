import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTicketReleaseClock } from './useTicketReleaseClock.js';
import { isTicketReleased } from '../../../shared/ticketRelease.js';

test('release clock wakes at the boundary, reschedules settings and reconciles tab return', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  function Probe({ ticket }) {
    const now = useTicketReleaseClock([ticket]);
    return <button disabled={!isTicketReleased(ticket, now)}>Book</button>;
  }
  const render = async ticket => {
    await act(async () => root.render(<Probe ticket={ticket} />));
  };
  try {
    const ticket = { release_at: new Date(Date.now() + 70).toISOString(), release_timezone: 'Europe/London' };
    await render(ticket);
    assert.equal(document.querySelector('button').disabled, true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    assert.equal(document.querySelector('button').disabled, false);
    const later = { ...ticket, release_at: new Date(Date.now() + 60_000).toISOString() };
    await render(later);
    assert.equal(document.querySelector('button').disabled, true);
    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse(later.release_at);
      await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
      assert.equal(document.querySelector('button').disabled, false);
      Date.now = () => Date.parse(later.release_at) - 1000;
      await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
      assert.equal(document.querySelector('button').disabled, true);
    } finally {
      Date.now = originalNow;
    }
    await render({ release_at: null, release_timezone: null });
    assert.equal(document.querySelector('button').disabled, false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
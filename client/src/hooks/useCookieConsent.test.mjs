import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const React = (await import('react')).default;
const { createElement: h, act } = React;
const { createRoot } = await import('react-dom/client');
const { CONSENT_STATUS, useCookieConsent: useConsent } = await import('./useCookieConsent.js');

test('accepting and declining in one hook updates independent same-window consumers immediately', async () => {
  window.localStorage.clear();

  let bannerActions;
  let trackingStatus;

  function BannerHarness() {
    const consent = useConsent();
    bannerActions = consent;
    return null;
  }

  function TrackingHarness() {
    const consent = useConsent();
    trackingStatus = consent.consentStatus;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(h(React.Fragment, null, h(BannerHarness), h(TrackingHarness)));
  });
  assert.equal(trackingStatus, CONSENT_STATUS.PENDING);

  await act(async () => {
    bannerActions.acceptCookies();
  });
  assert.equal(trackingStatus, CONSENT_STATUS.ACCEPTED);
  assert.equal(window.localStorage.getItem('cookie-consent'), CONSENT_STATUS.ACCEPTED);

  await act(async () => {
    bannerActions.declineCookies();
  });
  assert.equal(trackingStatus, CONSENT_STATUS.DECLINED);
  assert.equal(window.localStorage.getItem('cookie-consent'), CONSENT_STATUS.DECLINED);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { popupExternalInterferenceActive } from './popupInterference.js';

function check(html, width = 400, height = 300) {
  const dom = new JSDOM(`<body>${html}</body>`);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  for (const frame of document.querySelectorAll('iframe')) frame.getBoundingClientRect = () => ({ width, height });
  try { return popupExternalInterferenceActive(); }
  finally { dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.Element; }
}
test('hidden Stripe telemetry and pixel frames do not block CMS popups', () => {
  assert.equal(check('<iframe src="https://js.stripe.com/v3/m-outer.html" style="visibility:hidden"></iframe>'), false);
  assert.equal(check('<iframe src="https://js.stripe.com/v3/m-outer.html"></iframe>', 1000, 1), false);
  assert.equal(check('<section hidden><iframe src="https://js.stripe.com/"></iframe></section>'), false);
  assert.equal(check('<section style="display:none"><iframe src="https://js.stripe.com/"></iframe></section>'), false);
});
test('visible Stripe checkout and authentication frames still block popups', () => {
  assert.equal(check('<iframe src="https://js.stripe.com/v3/elements-inner-payment.html"></iframe>'), true);
});
test('payment flow markers and competing dialogs remain protected', () => {
  assert.equal(check('<section data-payment-active><iframe src="https://js.stripe.com/" hidden></iframe></section>'), true);
  assert.equal(check('<iframe data-payment-active src="https://js.stripe.com/" hidden></iframe>'), true);
  assert.equal(check('<section role="dialog"></section>'), true);
  assert.equal(check('<form data-submitting="true"></form>'), true);
});
test('the popup’s own content never blocks itself', () => {
  assert.equal(check('<section data-cms-popup-modal><section role="dialog"></section></section>'), false);
});

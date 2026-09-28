import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
for (const name of ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent']) {
  globalThis[name] = window[name];
}
globalThis.PointerEvent = window.PointerEvent || window.MouseEvent;
globalThis.NodeFilter = window.NodeFilter;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TooltipProvider } = await import('@radix-ui/react-tooltip');
const { EVENT_CPD_EMAIL_PLACEHOLDERS } = await import('../../../../shared/eventCpdEmailPlaceholders.js');
const { EMAIL_PLACEHOLDERS, groupBuilderPlaceholders } = await import('../../lib/emailPlaceholders.js');
const { BLOCK_TYPES, createBlock, defaultEmailDesign, normalizeDuplicateDynamicTokens } = await import('./types.js');
const { designToHtml } = await import('./mjmlConverter.js');
const BlockEditor = (await import('./BlockEditor.jsx')).default;

test('builder registry contains every canonical CPD token exactly once, retaining survey URLs and other contexts', () => {
  const tokens = EMAIL_PLACEHOLDERS.map((p) => p.token);
  const groups = groupBuilderPlaceholders();
  const options = groups.flatMap((g) => g.items.map((p) => p.token));
  assert.equal(groups[0].category, 'CPD certificate email');
  assert.deepEqual(groups[0].items.map((p) => p.token), EVENT_CPD_EMAIL_PLACEHOLDERS.map((p) => p.token));
  for (const token of [...EVENT_CPD_EMAIL_PLACEHOLDERS.map((p) => p.token), '{{event_survey_url}}', '[[event.survey_url]]']) {
    assert.equal(tokens.filter((t) => t === token).length, 1, token);
    assert.equal(options.filter((t) => t === token).length, 1, `dropdown: ${token}`);
  }
  for (const token of EVENT_CPD_EMAIL_PLACEHOLDERS.map((p) => p.token)) {
    assert.ok(EMAIL_PLACEHOLDERS.find((p) => p.token === token).contexts.includes('CPD certificate emails'));
  }
  assert.ok(EMAIL_PLACEHOLDERS.find((p) => p.token === '{{organisation_name}}').contexts.includes('Membership Fee Link'));
  assert.ok(EMAIL_PLACEHOLDERS.find((p) => p.token === '{{attendee_name}}').contexts.includes('Booking Confirmations'));
});

test('actual dropdown searches and inserts each CPD token; saved designs reopen with literal preview tokens', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let block = createBlock(BLOCK_TYPES.PLACEHOLDER);
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(BlockEditor, {
        block,
        onChange: (updated) => { block = updated; },
      })));
    });
  };
  try {
    await render();
    for (const { token, label } of EVENT_CPD_EMAIL_PLACEHOLDERS) {
      await act(async () => { host.querySelector('[data-testid="placeholder-picker-trigger"]').click(); });
      const search = document.querySelector('[data-testid="placeholder-picker-search"]');
      assert.ok(search, 'real dropdown opens');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(search, token === '{{event_survey_list}}' ? 'survey_list' : label);
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      const option = document.querySelector(`[data-testid="placeholder-option-${token}"]`);
      assert.ok(option, `search finds ${token}`);
      assert.match(option.textContent, new RegExp(label, 'i'));
      await act(async () => { option.click(); });
      assert.equal(block.placeholder, token);
      assert.match(block.label, new RegExp(label, 'i'));
      await render();

      // Same normalization, HTML generation and JSON payload used when saving.
      const { design: saveDesign } = normalizeDuplicateDynamicTokens({
        ...defaultEmailDesign, blocks: [block],
      });
      const reopened = JSON.parse(JSON.stringify(saveDesign));
      assert.equal(reopened.blocks[0].placeholder, token);
      const html = designToHtml(reopened);
      assert.ok(html?.includes(token), `generated preview preserves ${token}`);
      assert.doesNotMatch(html, /#certificate_grant=|\/survey\/[^" ]*token=/i,
        'the visual preview must not expose attendee bearer links');
    }
    await act(async () => { root.unmount(); });
    const reopened = JSON.parse(JSON.stringify({ ...defaultEmailDesign, blocks: [block] }));
    const reopenRoot = createRoot(host);
    try {
      await act(async () => {
        reopenRoot.render(React.createElement(TooltipProvider, null, React.createElement(BlockEditor, {
          block: reopened.blocks[0], onChange: () => {},
        })));
      });
      assert.equal(host.querySelector('[data-testid="placeholder-selected-token"]').textContent, '{{event_survey_list}}');
    } finally {
      await act(async () => { reopenRoot.unmount(); });
    }
  } finally {
    if (host.firstChild) await act(async () => { root.unmount(); });
    host.remove();
  }
});
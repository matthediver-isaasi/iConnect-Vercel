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
const { EMAIL_PLACEHOLDERS, groupPlaceholdersByCategory } = await import('../../lib/emailPlaceholders.js');
const { BLOCK_TYPES, createBlock, defaultEmailDesign, normalizeDuplicateDynamicTokens } = await import('./types.js');
const { designToHtml } = await import('./mjmlConverter.js');
const BlockEditor = (await import('./BlockEditor.jsx')).default;

test('actual builder registry includes survey list without replacing survey URLs', () => {
  const tokens = EMAIL_PLACEHOLDERS.map((p) => p.token);
  for (const token of ['{{event_survey_list}}', '{{event_survey_url}}', '[[event.survey_url]]']) {
    assert.equal(tokens.filter((t) => t === token).length, 1, token);
  }
  assert.ok(groupPlaceholdersByCategory().some((g) =>
    g.items.some((p) => p.token === '{{event_survey_list}}')));
});

test('placeholder dropdown search selects survey list; saved design reopens and preview contains no bearer link', async () => {
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
    await act(async () => {
      host.querySelector('[data-testid="placeholder-picker-trigger"]').click();
    });
    const search = document.querySelector('[data-testid="placeholder-picker-search"]');
    assert.ok(search, 'real dropdown opens');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, 'survey_list');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const option = document.querySelector('[data-testid="placeholder-option-{{event_survey_list}}"]');
    assert.ok(option, 'search finds the actual list option');
    assert.match(option.textContent, /Event survey list/);
    await act(async () => { option.click(); });
    assert.equal(block.placeholder, '{{event_survey_list}}');
    assert.match(block.label, /Event survey list/);

    // Same JSON payload the template editor persists in design_json.
    const { design: saveDesign } = normalizeDuplicateDynamicTokens({
      ...defaultEmailDesign, blocks: [block],
    });
    const saved = JSON.stringify(saveDesign);
    const reopened = JSON.parse(saved);
    assert.equal(reopened.blocks[0].placeholder, '{{event_survey_list}}');
    await act(async () => { root.unmount(); });
    const reopenRoot = createRoot(host);
    try {
      await act(async () => {
        reopenRoot.render(React.createElement(TooltipProvider, null, React.createElement(BlockEditor, {
          block: reopened.blocks[0], onChange: () => {},
        })));
      });
      assert.equal(host.querySelector('[data-testid="placeholder-selected-token"]').textContent, '{{event_survey_list}}');
      const html = designToHtml(reopened);
      assert.ok(html?.includes('{{event_survey_list}}'), 'generated preview preserves send-time token');
      assert.doesNotMatch(html, /#certificate_grant=|\/survey\/[^" ]*token=/i,
        'the visual preview must not expose attendee bearer links');
    } finally {
      await act(async () => { reopenRoot.unmount(); });
    }
  } finally {
    if (host.firstChild) await act(async () => { root.unmount(); });
    host.remove();
  }
});
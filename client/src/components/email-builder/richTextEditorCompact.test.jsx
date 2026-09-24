/**
 * Compact slot toolbar keeps saved slot styling intact (Task #3380).
 *
 * The dynamic text slot popover (DynamicTextSlotEditor in BlockRenderer.jsx)
 * renders RichTextEditor with `compact` — a toolbar-only mode. These tests
 * prove:
 *  1. Round-trip: rich slot HTML with a heading + colored text + font size
 *     loads into an editor built from the SAME extension list the component
 *     uses (buildRichTextExtensions), and editing unrelated text never strips
 *     or rewrites the existing markup.
 *  2. Render: compact mode hides heading/font/color/undo controls while full
 *     mode still shows them (compact hides controls, nothing else).
 *
 * Runs under tsx (see the `test` workflow) because it needs JSX + @ aliases.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// --- jsdom environment (must exist before tiptap/react imports) ----------
before(() => {});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.MutationObserver = window.MutationObserver;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.PointerEvent = window.PointerEvent || window.MouseEvent;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
// tsx compiles this repo's JSX with the classic runtime; component files
// (like RichTextEditor.jsx) rely on Vite's automatic runtime in the app, so
// expose React globally for the classic-transformed createElement calls.
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { Editor } = await import('@tiptap/core');
const RichTextEditorModule = await import('./RichTextEditor.jsx');
const RichTextEditor = RichTextEditorModule.default;
const { buildRichTextExtensions } = RichTextEditorModule;

test('campaign survey placeholders survive the real link editor extension and HTML round trip', () => {
  for (const token of ['{{event_survey_url}}', '[[event.survey_url]]']) {
    const editor = new Editor({ extensions: buildRichTextExtensions(), content: '<p>Survey</p>' });
    try {
      editor.commands.selectAll();
      assert.equal(editor.commands.setLink({ href: token }), true);
      assert.ok(editor.getHTML().includes(`href="${token}"`));
      editor.commands.setContent(editor.getHTML());
      assert.ok(editor.getHTML().includes(`href="${token}"`));
    } finally {
      editor.destroy();
    }
  }
});

// Rich slot HTML authored before compact mode existed: heading, colored
// text, explicit font size. rgb() form matches what jsdom/tiptap emit so we
// can also assert byte-identity of the untouched part.
const RICH_SLOT_HTML =
  '<h2>Member update</h2>' +
  '<p><span style="color: rgb(200, 16, 46)">Important</span> details and ' +
  '<span style="font-size: 24px">big text</span></p>';

function makeHeadlessEditor(content) {
  return new Editor({
    element: document.createElement('div'),
    extensions: buildRichTextExtensions(),
    content,
  });
}

test('rich slot HTML round-trips unchanged through the compact editor when unrelated text is edited', () => {
  const editor = makeHeadlessEditor(RICH_SLOT_HTML);

  // Opening the editor must not rewrite the saved markup.
  const loaded = editor.getHTML();
  assert.ok(loaded.includes('<h2>Member update</h2>'), `heading survived load: ${loaded}`);
  assert.ok(loaded.includes('color: rgb(200, 16, 46)'), `color survived load: ${loaded}`);
  assert.ok(loaded.includes('font-size: 24px'), `font size survived load: ${loaded}`);

  // Edit UNRELATED text: append a new paragraph at the end of the doc —
  // exactly what a user typing extra plain text in the slot popover does.
  editor.commands.insertContentAt(editor.state.doc.content.size, '<p>ps: see you there</p>');
  const edited = editor.getHTML();

  // The original markup is a byte-identical prefix; only the new paragraph
  // was appended. Nothing was stripped or rewritten.
  assert.equal(edited, `${loaded}<p>ps: see you there</p>`);

  editor.destroy();
});

test('editing inside an existing styled paragraph keeps heading/color/font-size marks', () => {
  const editor = makeHeadlessEditor(RICH_SLOT_HTML);
  const before = editor.getHTML();

  // Type plain text at the very end of the second paragraph (after "big text").
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' more');
  const after = editor.getHTML();

  assert.ok(after.includes('<h2>Member update</h2>'), `heading kept: ${after}`);
  assert.ok(after.includes('color: rgb(200, 16, 46)'), `color kept: ${after}`);
  assert.ok(after.includes('font-size: 24px'), `font size kept: ${after}`);
  assert.notEqual(after, before, 'edit actually changed the doc');

  editor.destroy();
});

// --- render check: compact hides controls, full mode shows them ----------

async function renderEditor(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(RichTextEditor, { content: '<p>hi</p>', onChange: () => {}, ...props }));
  });
  // one extra tick for tiptap's post-mount editor state
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    host,
    q: (testid) => host.querySelector(`[data-testid="${testid}"]`),
    editable: () => host.querySelector('[contenteditable="true"]'),
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

const HIDDEN_IN_COMPACT = [
  'rte-btn-heading-1',
  'rte-btn-heading-2',
  'rte-btn-heading-3',
  'rte-btn-text-color',
  'rte-btn-bg-color',
  'rte-font-family',
  'rte-font-size',
  'rte-btn-undo',
  'rte-btn-redo',
];
const ALWAYS_SHOWN = [
  'rte-btn-bold',
  'rte-btn-italic',
  'rte-btn-underline',
  'rte-btn-bullet-list',
  'rte-btn-ordered-list',
  'rte-btn-add-link',
];

test('compact mode hides heading/font/color/undo controls but keeps bold/italic/underline/lists/link', async () => {
  const r = await renderEditor({ compact: true });
  for (const id of HIDDEN_IN_COMPACT) {
    assert.equal(r.q(id), null, `${id} must be hidden in compact mode`);
  }
  for (const id of ALWAYS_SHOWN) {
    assert.ok(r.q(id), `${id} must remain in compact mode`);
  }
  await r.unmount();
});

test('full mode still shows every control', async () => {
  const r = await renderEditor({});
  for (const id of [...HIDDEN_IN_COMPACT, ...ALWAYS_SHOWN]) {
    assert.ok(r.q(id), `${id} must be visible in full mode`);
  }
  await r.unmount();
});

const MEMBER_TOKENS = [
  {
    key: 'member.first_name',
    label: 'First name',
    token: '{{member.first_name}}',
  },
  {
    key: 'member.organization.name',
    label: 'Organisation name',
    token: '{{member.organization.name}}',
  },
];

async function placeCaret(editable, textOffset) {
  const walker = document.createTreeWalker(editable.querySelector('p'), window.NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  assert.ok(text, 'editor paragraph has a text node');
  editable.focus();
  const range = document.createRange();
  range.setStart(text, textOffset);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new window.Event('selectionchange', { bubbles: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function pointerOpenTokenPicker(trigger) {
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
    }));
    trigger.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function chooseToken(option) {
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
    }));
    option.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('token picker is opt-in and leaves the shared email toolbar unchanged by default', async () => {
  const emailEditor = await renderEditor({});
  assert.equal(emailEditor.q('rte-token-picker'), null);
  assert.equal(document.querySelector('[data-testid="rte-token-menu"]'), null);
  await emailEditor.unmount();
});

test('pointer token selection inserts literal token at the saved caret with active formatting and supports undo/redo', async () => {
  const changes = [];
  const r = await renderEditor({
    content: '<p><strong>Hello world</strong></p>',
    tokenOptions: MEMBER_TOKENS,
    onChange: (html) => changes.push(html),
  });
  const trigger = r.q('rte-token-picker');
  assert.ok(trigger, 'opt-in picker is rendered');
  assert.equal(trigger.getAttribute('aria-label'), 'Insert member data');

  await placeCaret(r.editable(), 5);
  await pointerOpenTokenPicker(trigger);
  const option = document.querySelector('[data-testid="rte-token-option-member.first_name"]');
  assert.ok(option, 'pointer-opened menu exposes labelled token options');
  assert.match(option.textContent, /First name/);
  await chooseToken(option);

  const inserted = r.editable().innerHTML;
  assert.equal(
    inserted,
    '<p><strong>Hello{{member.first_name}} world</strong></p>',
    'literal token is inserted at the pre-menu caret and inherits bold',
  );

  const undo = r.q('rte-btn-undo');
  await act(async () => { undo.click(); });
  assert.equal(r.editable().innerHTML, '<p><strong>Hello world</strong></p>');
  const redo = r.q('rte-btn-redo');
  await act(async () => { redo.click(); });
  assert.equal(r.editable().innerHTML, inserted);
  assert.equal(changes.at(-1), inserted, 'token round-trips through normal editor HTML');

  await r.unmount();
});

test('token inserted after toggling bold at an empty caret keeps the stored mark', async () => {
  const r = await renderEditor({
    content: '<p>Hello world</p>',
    tokenOptions: MEMBER_TOKENS,
  });

  await placeCaret(r.editable(), 5);
  await act(async () => {
    r.q('rte-btn-bold').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await pointerOpenTokenPicker(r.q('rte-token-picker'));
  const option = document.querySelector('[data-testid="rte-token-option-member.first_name"]');
  assert.ok(option);
  await chooseToken(option);

  assert.equal(
    r.editable().innerHTML,
    '<p>Hello<strong>{{member.first_name}}</strong> world</p>',
    'the picker restores TipTap storedMarks after restoring the caret',
  );
  await r.unmount();
});

test('keyboard-opened picker restores a selected range and uses a custom accessible label', async () => {
  const r = await renderEditor({
    content: '<p>Hello world</p>',
    tokenOptions: MEMBER_TOKENS,
    tokenPickerLabel: 'Insert viewer field',
  });
  const editable = r.editable();
  const text = editable.querySelector('p').firstChild;
  editable.focus();
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 11);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new window.Event('selectionchange', { bubbles: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const trigger = r.q('rte-token-picker');
  assert.equal(trigger.textContent, 'Insert viewer field');
  assert.equal(trigger.getAttribute('aria-label'), 'Insert viewer field');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const option = document.querySelector('[data-testid="rte-token-option-member.organization.name"]');
  assert.ok(option, 'keyboard-opened menu exposes options');
  await chooseToken(option);

  assert.equal(
    editable.innerHTML,
    '<p>Hello {{member.organization.name}}</p>',
    'selection captured before keyboard focus moved is replaced by the token',
  );
  await r.unmount();
});

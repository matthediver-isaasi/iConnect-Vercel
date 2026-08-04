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
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.MutationObserver = window.MutationObserver;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
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

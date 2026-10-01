import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlock, createEmptyCanvasDesign, getRootChildren, setRootChildren } from './canvasDesign.js';
import { createSymbolEditorDocument, getSymbolEditUnsupportedReason, prepareSymbolEditorSave } from './canvasSymbolEditorState.js';

const symbol = () => ({
  id: 'shared',
  design: setRootChildren(createEmptyCanvasDesign(), [
    createBlock('text', { id: 'text', desktop: { x: 20, y: 30 }, tablet: { x: 40, y: 90 }, mobile: { x: 10, y: 50 } }),
    createBlock('button', { id: 'button', desktop: { x: 30, y: 70 }, tablet: { x: 50, y: 120 }, mobile: { x: 20, y: 110 } }),
  ]),
});

test('private draft never mutates the fetched shared definition and preserves metadata on save', () => {
  const source = symbol();
  source.design.extension = { retained: true };
  source.design.root.extension = 'root';
  source.design.root.sections[0].extension = 'section';
  source.design.root.sections[0].children[0].extension = 'block';
  source.design.root.groups = [{ id: 'group', name: 'Keep group', collapsed: false }];
  source.design.root.sections[0].children[0].groupId = 'group';
  source.design.root.guides = { vertical: [{ pos: 100, locked: true }], horizontal: [] };
  const snapshot = JSON.stringify(source);
  const draft = createSymbolEditorDocument(source);
  draft.root.sections[0].children[0].content.html = '<p>Updated</p>';
  const saved = prepareSymbolEditorSave(source.design, draft);
  assert.equal(JSON.stringify(source), snapshot);
  assert.deepEqual(saved.extension, { retained: true });
  assert.equal(saved.root.extension, 'root');
  assert.equal(saved.root.sections[0].extension, 'section');
  assert.equal(saved.root.sections[0].children[0].extension, 'block');
  assert.equal(getRootChildren(saved)[0].content.html, '<p>Updated</p>');
  assert.deepEqual(saved.root.groups, source.design.root.groups);
  assert.deepEqual(saved.root.guides, source.design.root.guides);
});

test('save normalizes each explicit breakpoint origin and retains relative spacing', () => {
  const source = symbol();
  const saved = prepareSymbolEditorSave(source.design, createSymbolEditorDocument(source));
  const [text, button] = getRootChildren(saved);
  for (const bp of ['desktop', 'tablet', 'mobile']) {
    assert.equal(text.bp[bp].x, 0);
    assert.equal(text.bp[bp].y, 0);
    assert.equal(button.bp[bp].x, 10);
  }
  assert.equal(button.bp.desktop.y, 40);
  assert.equal(button.bp.tablet.y, 30);
  assert.equal(button.bp.mobile.y, 60);
});

test('deleting blocks does not restore them from the original definition', () => {
  const source = symbol();
  const draft = createSymbolEditorDocument(source);
  draft.root.sections[0].children.pop();
  assert.deepEqual(getRootChildren(prepareSymbolEditorSave(source.design, draft)).map((b) => b.id), ['text']);
});

test('cleared responsive overrides and content keys are not resurrected as metadata', () => {
  const source = symbol();
  source.design.root.sections[0].children[0].content.optionalLink = '/old';
  const draft = createSymbolEditorDocument(source);
  draft.root.sections[0].children[0].bp.mobile = {};
  delete draft.root.sections[0].children[0].content.optionalLink;
  const saved = prepareSymbolEditorSave(source.design, draft);
  assert.deepEqual(saved.root.sections[0].children[0].bp.mobile, {});
  assert.equal(saved.root.sections[0].children[0].content.optionalLink, undefined);
});

test('unsupported documents are rejected before hydration and before saving', () => {
  const source = symbol();
  const variants = [
    null, { ...source.design, version: 2 }, { ...source.design, version: 99 },
    { version: 1, root: { sections: [] } },
    { version: 1, root: { sections: [source.design.root.sections[0], { id: 'extra', children: [] }] } },
    ...['symbol', 'row', 'group', 'future-block'].map((type) => ({
      version: 1, root: { sections: [{ children: [{ id: 'unsupported', type }] }] },
    })),
    { version: 1, root: { sections: [{ children: [{ id: 'nested', type: 'section', children: [] }] }] } },
    { version: 1, root: { sections: [{ children: [createBlock('advanced-accordion', { content: { items: [
      { id: 'item', children: [{ id: 'bad', type: 'symbol' }] },
    ] } })] }] } },
  ];
  for (const design of variants) {
    assert.ok(getSymbolEditUnsupportedReason(design));
    assert.throws(() => createSymbolEditorDocument({ id: 'bad', design }));
    assert.throws(() => prepareSymbolEditorSave(source.design, design));
  }
});
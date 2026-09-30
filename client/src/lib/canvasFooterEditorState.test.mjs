import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvasFooterInitialDesignResolver } from './canvasFooterEditorState.js';
import { setRootChildren } from './canvasDesign.js';

const design = (blockIds) => ({
  version: 1,
  root: {
    background: null,
    sections: [{
      id: 'root-section',
      children: blockIds.map((id) => ({ id })),
    }],
  },
});

test('same-footer rerenders keep one CanvasBuilder hydration object', () => {
  const normalizeCalls = [];
  const resolveInitialDesign = createCanvasFooterInitialDesignResolver((value) => {
    normalizeCalls.push(value);
    return structuredClone(value);
  });

  const first = resolveInitialDesign({ id: 'footer-1', design: design([]) });
  const afterDirtyRerender = resolveInitialDesign({
    id: 'footer-1',
    design: design([]),
  });
  const afterSaveRefetch = resolveInitialDesign({
    id: 'footer-1',
    design: design(['saved-block']),
  });

  assert.equal(afterDirtyRerender, first);
  assert.equal(afterSaveRefetch, first);
  assert.equal(normalizeCalls.length, 1);
});

test('switching footers hydrates the newly selected footer', () => {
  const resolveInitialDesign = createCanvasFooterInitialDesignResolver(structuredClone);
  const first = resolveInitialDesign({ id: 'footer-1', design: design(['one']) });
  const second = resolveInitialDesign({ id: 'footer-2', design: design(['two']) });

  assert.notEqual(second, first);
  assert.deepEqual(second, design(['two']));
});

test('reopening a footer loads its persisted design into a fresh editor', () => {
  const firstEditor = createCanvasFooterInitialDesignResolver(structuredClone);
  firstEditor({ id: 'footer-1', design: design([]) });

  const reopenedEditor = createCanvasFooterInitialDesignResolver(structuredClone);
  const reopened = reopenedEditor({
    id: 'footer-1',
    design: design(['persisted-block']),
  });

  assert.deepEqual(reopened, design(['persisted-block']));
});

test('save snapshot plus same-footer refetch allows a later edit to become dirty', () => {
  const resolveInitialDesign = createCanvasFooterInitialDesignResolver(structuredClone);
  const initial = resolveInitialDesign({ id: 'footer-1', design: design([]) });
  let localDesign = initial;
  let savedSnapshot = JSON.stringify(initial);

  localDesign = design(['first-block']);
  assert.notEqual(JSON.stringify(localDesign), savedSnapshot);

  // CanvasBuilder.performSave advances its own snapshot after onSave resolves.
  savedSnapshot = JSON.stringify(localDesign);
  assert.equal(JSON.stringify(localDesign), savedSnapshot);

  const refetchedInitial = resolveInitialDesign({
    id: 'footer-1',
    design: design(['first-block']),
  });
  assert.equal(refetchedInitial, initial);

  localDesign = design(['first-block', 'second-block']);
  assert.notEqual(JSON.stringify(localDesign), savedSnapshot);
});

test('footer header saves through CanvasBuilder and persistence stays its callback', () => {
  const source = fs.readFileSync(
    new URL('../pages/CanvasFooterEditor.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /const doSave = useCallback\(\s*\(\) => canvasRef\.current\?\.saveNow\?\.\(\),\s*\[\],\s*\);/,
  );
  assert.match(source, /<CanvasBuilder[^>]+onSave=\{persistDesign\}/);
});

test('editing root children preserves additional document sections', () => {
  const original = {
    version: 1,
    root: {
      sections: [
        { id: 'root-section', children: [] },
        { id: 'retained-section', children: [{ id: 'retained-block' }] },
      ],
    },
  };

  const updated = setRootChildren(original, [{ id: 'dropped-block' }]);

  assert.equal(updated.root.sections.length, 2);
  assert.equal(updated.root.sections[0].children[0].id, 'dropped-block');
  assert.equal(updated.root.sections[1].id, 'retained-section');
  assert.equal(updated.root.sections[1].children[0].id, 'retained-block');
});
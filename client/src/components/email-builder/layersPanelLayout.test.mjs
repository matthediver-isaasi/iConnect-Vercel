import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getEmailBuilderPanelLayout } from './emailBuilderPanelLayout.js';

const source = await readFile(
  new URL('./LayersPanel.jsx', import.meta.url),
  'utf8',
);
const builderSource = await readFile(
  new URL('./EmailBuilder.jsx', import.meta.url),
  'utf8',
);

test('sortable layer rows constrain long labels while reserving action width', () => {
  assert.match(
    source,
    /itemClassName = 'flex w-full min-w-0 items-center[^']*overflow-hidden/,
    'top-level and nested sortable rows must not grow wider than the Layers panel',
  );
  assert.match(
    source,
    /<span className="min-w-0 flex-1 truncate text-\[13px\]">\{getBlockLabel\(item\.block\)\}<\/span>/,
    'sortable labels must yield horizontal space and truncate',
  );
  assert.match(
    source,
    /<div className="ml-auto flex flex-shrink-0 items-center gap-0\.5" style=\{\{ visibility: 'visible' \}\}>/,
    'visibility, duplicate, and delete controls must retain their width',
  );
});

test('column-child rows constrain long labels without losing delete controls', () => {
  assert.match(
    source,
    /<span className="min-w-0 flex-1 truncate text-\[13px\]">\{getBlockLabel\(child\)\}<\/span>/,
    'column-child labels must shrink inside their indented row',
  );
  assert.match(
    source,
    /<div className="ml-auto flex flex-shrink-0 items-center gap-0\.5">\s*<button[\s\S]*?layer-col-child-delete-/,
    'column-child delete controls must retain their width',
  );
  assert.match(
    source,
    /<div key=\{col\.id\} className="min-w-0">/,
    'nested column containers must allow their descendants to shrink',
  );
});

test('constrained editor reserves separate, non-overlapping panel bounds', () => {
  for (const propertiesExpanded of [false, true]) {
    const layout = getEmailBuilderPanelLayout({
      editorWidth: 900,
      layersOpen: true,
      propertiesExpanded,
    });

    const layers = { left: 0, right: layout.layersWidth };
    const properties = {
      left: layout.layersWidth,
      right: layout.layersWidth + layout.propertiesWidth,
    };

    assert.ok(layout.layersWidth >= 240, 'Layers remains usable at constrained widths');
    assert.ok(layout.propertiesWidth >= 240, 'Properties remains usable at constrained widths');
    assert.equal(
      layers.right,
      properties.left,
      'Properties starts after Layers instead of covering its controls',
    );
    assert.equal(layout.railWidth, properties.right);
  }
});

test('opening and closing Layers changes reserved rail space', () => {
  const closed = getEmailBuilderPanelLayout({
    editorWidth: 1100,
    layersOpen: false,
    propertiesExpanded: false,
  });
  const open = getEmailBuilderPanelLayout({
    editorWidth: 1100,
    layersOpen: true,
    propertiesExpanded: false,
  });

  assert.equal(closed.layersWidth, 0);
  assert.ok(open.layersWidth > 0);
  assert.equal(open.railWidth, open.layersWidth + open.propertiesWidth);
  assert.ok(open.railWidth > closed.railWidth);
});

test('expanded Properties uses available width without entering Layers bounds', () => {
  const layout = getEmailBuilderPanelLayout({
    editorWidth: 1440,
    layersOpen: true,
    propertiesExpanded: true,
  });

  assert.equal(layout.showPalette, false, 'surrounding palette collapses before either right panel');
  assert.ok(layout.propertiesWidth > layout.layersWidth);
  assert.ok(layout.railWidth <= 1200, 'the canvas keeps its minimum editing width');
});

test('the block palette remains reachable whenever responsive layout collapses it', () => {
  const collapsed = getEmailBuilderPanelLayout({
    editorWidth: 900,
    layersOpen: true,
    propertiesExpanded: true,
  });
  const reopened = getEmailBuilderPanelLayout({
    editorWidth: 900,
    layersOpen: true,
    propertiesExpanded: true,
    compactPaletteOpen: true,
  });

  assert.equal(collapsed.showPalette, false);
  assert.equal(reopened.showPalette, true);
  assert.match(
    builderSource,
    /data-testid="button-open-block-palette"/,
    'collapsed layouts must retain a control that restores the block inserter',
  );
  assert.match(
    builderSource,
    /data-testid="button-close-block-palette"/,
    'the compact block palette must be closable to restore canvas space',
  );
  assert.match(
    builderSource,
    /<BlockPalette \/>/,
    'the restored compact palette must use the real draggable block inserter',
  );
});
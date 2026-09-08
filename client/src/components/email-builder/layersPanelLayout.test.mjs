import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getEmailBuilderPanelLayout,
  LAYERS_PANEL_WIDTH,
} from './emailBuilderPanelLayout.js';

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

test('Layers reserves a wider dedicated pane in every Properties mode', () => {
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

    assert.equal(
      layout.layersWidth,
      LAYERS_PANEL_WIDTH,
      'Layers keeps the width required by nested labels and all row actions',
    );
    assert.ok(layout.propertiesWidth >= 240, 'Properties remains usable at constrained widths');
    assert.equal(
      layers.right,
      properties.left,
      'Properties starts after Layers instead of covering its controls',
    );
    assert.equal(layout.railWidth, properties.right);
  }
});

test('Layers content and controls reserve space before the scrollbar gutter', () => {
  assert.match(
    source,
    /className="min-w-0 py-2 pl-2 pr-4 space-y-1"\s*data-testid="layers-scroll-content"/,
    'the scroll content must reserve a 16px right inset for the scrollbar',
  );

  const pane = { left: 0, right: LAYERS_PANEL_WIDTH };
  const scrollbarGutter = { left: pane.right - 12, right: pane.right };
  const usableContent = { left: 8, right: pane.right - 16 };
  const deepestRowIndent = 40;
  const fixedLeadingControls = 20 + 16;
  const actionSetWidth = 3 * 18;
  const minimumLabelWidth = 64;
  const deleteControl = {
    left: usableContent.right - 18,
    right: usableContent.right,
  };

  assert.ok(
    usableContent.right - usableContent.left
      >= deepestRowIndent + fixedLeadingControls + actionSetWidth + minimumLabelWidth,
    'deeply indented rows retain label and action space',
  );
  assert.ok(
    deleteControl.right <= scrollbarGutter.left,
    'the rightmost delete control stays clear of the scrollbar gutter',
  );
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
  assert.equal(open.layersWidth, LAYERS_PANEL_WIDTH);
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

test('Properties begins after the scrollbar-safe Layers content in all panel modes', () => {
  for (const editorWidth of [900, 1100, 1440]) {
    for (const propertiesExpanded of [false, true]) {
      const layout = getEmailBuilderPanelLayout({
        editorWidth,
        layersOpen: true,
        propertiesExpanded,
      });
      const usableLayersRight = layout.layersWidth - 16;
      const scrollbarRight = layout.layersWidth;
      const propertiesLeft = layout.layersWidth;

      assert.ok(usableLayersRight < scrollbarRight);
      assert.equal(
        scrollbarRight,
        propertiesLeft,
        `Properties must start outside Layers at ${editorWidth}px`,
      );
    }
  }
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
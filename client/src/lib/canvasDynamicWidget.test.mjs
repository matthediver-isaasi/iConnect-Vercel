import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANVAS_DYNAMIC_WIDGET_DEFAULT_CONTENT,
  CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY,
  canvasDashboardWidgetDataUrl,
  canvasDashboardWidgetUrl,
  canvasDashboardWidgetsUrl,
  canvasDynamicWidgetAuthoredFrame,
  canvasDynamicWidgetDisplaySize,
  canvasDynamicWidgetQueryScope,
  canvasDynamicWidgetResizeLimits,
  clampCanvasDynamicWidgetSize,
  collectCanvasDashboardWidgetPages,
  normalizeCanvasDashboardWidgetsResponse,
  normalizeCanvasDynamicWidgetContent,
  resizeCanvasDynamicWidgetSize,
} from './canvasDynamicWidget.js';
import {
  BLOCK_TYPES,
  createBlock,
  createFlowNode,
  normalizeCanvasDesign,
  normalizeFlowDesign,
} from './canvasDesign.js';

test('dynamic widget defaults are the fixed 600 by 400 authored frame', () => {
  assert.deepEqual(CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY, { w: 600, h: 400 });
  assert.deepEqual(CANVAS_DYNAMIC_WIDGET_DEFAULT_CONTENT, {
    widgetId: '',
    allowUserResize: false,
  });
});

test('dynamic widget content persists only the widget reference', () => {
  assert.deepEqual(
    normalizeCanvasDynamicWidgetContent({
      widgetId: ' widget-123 ',
      title: 'must not persist',
      data: { private: true },
    }),
    { widgetId: 'widget-123', allowUserResize: false },
  );
  assert.deepEqual(normalizeCanvasDynamicWidgetContent({
    widgetId: 'widget-123',
    allowUserResize: true,
    copiedDashboardData: { private: true },
  }), { widgetId: 'widget-123', allowUserResize: true });
  assert.deepEqual(normalizeCanvasDynamicWidgetContent(null), {
    widgetId: '',
    allowUserResize: false,
  });
});

test('v1 and v2 persistence keep only widgetId and the authored frame defaults', () => {
  const v1 = createBlock(BLOCK_TYPES.DYNAMIC_WIDGET, {
    id: 'widget-block-v1',
    content: { widgetId: 'shared-1', title: 'discarded' },
  });
  assert.deepEqual(v1.content, { widgetId: 'shared-1', allowUserResize: false });
  assert.deepEqual(
    { w: v1.bp.desktop.w, h: v1.bp.desktop.h },
    CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY,
  );

  const normalizedV1 = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root', children: [{
      ...v1,
      content: { widgetId: 'shared-1', config: { private: true } },
    }] }] },
  });
  assert.deepEqual(normalizedV1.root.sections[0].children[0].content, {
    widgetId: 'shared-1',
    allowUserResize: false,
  });

  const v2 = createFlowNode(BLOCK_TYPES.DYNAMIC_WIDGET, {
    id: 'widget-block-v2',
    content: { widgetId: 'shared-2', data: 'discarded' },
  });
  assert.equal(v2.flow.heightMode, 'fixed');
  assert.equal(v2.flow.height, CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.h);
  const normalizedV2 = normalizeFlowDesign({
    version: 2,
    root: {
      sections: [{
        id: 'section',
        type: BLOCK_TYPES.SECTION,
        children: [{
          ...v2,
          flow: { heightMode: 'auto', height: null },
          content: { widgetId: 'shared-2', data: 'discarded' },
        }],
      }],
    },
  });
  const child = normalizedV2.root.sections[0].children[0];
  assert.equal(child.flow.heightMode, 'fixed');
  assert.deepEqual(child.content, {
    widgetId: 'shared-2',
    allowUserResize: false,
  });
});

test('allowUserResize is an explicit content preference and round-trips in both designs', () => {
  const v1 = createBlock(BLOCK_TYPES.DYNAMIC_WIDGET, {
    id: 'widget-block-v1-resize',
    content: { widgetId: 'shared-1', allowUserResize: true },
  });
  assert.deepEqual(v1.content, { widgetId: 'shared-1', allowUserResize: true });
  const normalizedV1 = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root', children: [v1] }] },
  });
  assert.equal(
    normalizedV1.root.sections[0].children[0].content.allowUserResize,
    true,
  );

  const v2 = createFlowNode(BLOCK_TYPES.DYNAMIC_WIDGET, {
    id: 'widget-block-v2-resize',
    content: { widgetId: 'shared-2', allowUserResize: true },
  });
  assert.equal(v2.content.allowUserResize, true);
  const normalizedV2 = normalizeFlowDesign({
    version: 2,
    root: {
      sections: [{ id: 'section', type: BLOCK_TYPES.SECTION, children: [v2] }],
    },
  });
  assert.equal(
    normalizedV2.root.sections[0].children[0].content.allowUserResize,
    true,
  );
});

test('dashboard URLs use the Canvas embed scope and encode references', () => {
  assert.equal(canvasDashboardWidgetsUrl(), '/api/dashboard/widgets?embed=canvas');
  assert.equal(
    canvasDashboardWidgetsUrl({ page: 2, pageSize: 50 }),
    '/api/dashboard/widgets?embed=canvas&page=2&pageSize=50',
  );
  assert.equal(
    canvasDashboardWidgetUrl('widget/with spaces'),
    '/api/dashboard/widgets/widget%2Fwith%20spaces?embed=canvas',
  );
  assert.equal(
    canvasDashboardWidgetDataUrl('widget-123'),
    '/api/dashboard/widgets/widget-123/data?embed=canvas',
  );
  assert.equal(canvasDashboardWidgetUrl(''), null);
});

test('Canvas picker coordinates the existing list response without personal widgets', () => {
  const result = normalizeCanvasDashboardWidgetsResponse({
    shared: [{ id: 'shared-1' }],
    personal: [{ id: 'private-1' }],
    palette: [{ key: 'default', color: '#fff' }],
    pagination: {
      page: 1,
      pageSize: 50,
      total: 1,
      pages: 1,
      hasMore: false,
    },
  });
  assert.deepEqual(result.shared, [{ id: 'shared-1' }]);
  assert.deepEqual(result.palette, [{ key: 'default', color: '#fff' }]);
  assert.deepEqual(result.pagination, {
    page: 1,
    pageSize: 50,
    total: 1,
    pages: 1,
    hasMore: false,
  });
  assert.deepEqual(normalizeCanvasDashboardWidgetsResponse(null), {
    shared: [],
    palette: [],
    pagination: null,
  });
});

test('Canvas picker follows every paginated shared-widget discovery page', async () => {
  const requests = [];
  const pages = {
    '/api/dashboard/widgets?embed=canvas': {
      shared: [{ id: 'shared-1' }],
      palette: [{ key: 'default', color: '#fff' }],
      pagination: { page: 1, pageSize: 1, total: 3, pages: 3, hasMore: true },
    },
    '/api/dashboard/widgets?embed=canvas&page=2&pageSize=1': {
      shared: [{ id: 'shared-2' }],
      palette: [],
      pagination: { page: 2, pageSize: 1, total: 3, pages: 3, hasMore: true },
    },
    '/api/dashboard/widgets?embed=canvas&page=3&pageSize=1': {
      shared: [{ id: 'shared-3' }],
      palette: [],
      pagination: { page: 3, pageSize: 1, total: 3, pages: 3, hasMore: false },
    },
  };
  const result = await collectCanvasDashboardWidgetPages(async (url) => {
    requests.push(url);
    return pages[url];
  });
  assert.deepEqual(requests, Object.keys(pages));
  assert.deepEqual(result.shared.map((widget) => widget.id), [
    'shared-1',
    'shared-2',
    'shared-3',
  ]);
  assert.deepEqual(result.palette, [{ key: 'default', color: '#fff' }]);
});

test('viewer resize is local and bounded by the authored frame', () => {
  assert.deepEqual(clampCanvasDynamicWidgetSize(1200, 900, 600, 400), {
    width: 600,
    height: 400,
  });
  assert.deepEqual(clampCanvasDynamicWidgetSize(320, 240, 600, 400), {
    width: 320,
    height: 240,
  });
  assert.deepEqual(clampCanvasDynamicWidgetSize(undefined, undefined, 600, 400), {
    width: 600,
    height: 400,
  });
});

test('each instance has an isolated data query scope', () => {
  assert.notEqual(
    canvasDynamicWidgetQueryScope('block-a', 'widget-1'),
    canvasDynamicWidgetQueryScope('block-b', 'widget-1'),
  );
  assert.match(canvasDynamicWidgetQueryScope('block-a', 'widget-1'), /block-a/);
});

test('viewer resize controls stay inside measured authored bounds', () => {
  assert.deepEqual(canvasDynamicWidgetResizeLimits(640, 480), {
    minWidth: 160,
    minHeight: 120,
    maxWidth: 640,
    maxHeight: 480,
  });
  assert.deepEqual(canvasDynamicWidgetResizeLimits(90, 80), {
    minWidth: 90,
    minHeight: 80,
    maxWidth: 90,
    maxHeight: 80,
  });
  assert.deepEqual(
    resizeCanvasDynamicWidgetSize(
      { width: 300, height: 220 },
      { width: 999, height: 90 },
      640,
      480,
    ),
    { width: 640, height: 120 },
  );
  assert.deepEqual(
    resizeCanvasDynamicWidgetSize(
      { width: 300, height: 220 },
      { width: 1, height: 1 },
      640,
      480,
    ),
    { width: 160, height: 120 },
  );
});

test('viewer bounds use the active authored breakpoint frame', () => {
  const block = {
    bp: {
      desktop: { w: 600, h: 400 },
      tablet: { w: 920, h: 520 },
      mobile: { w: 360, h: undefined },
    },
    flow: {},
  };
  assert.deepEqual(canvasDynamicWidgetAuthoredFrame(block, 'tablet'), {
    width: 920,
    height: 520,
  });
  assert.deepEqual(canvasDynamicWidgetAuthoredFrame(block, 'mobile'), {
    width: 360,
    height: 520,
  });
  assert.deepEqual(canvasDynamicWidgetAuthoredFrame({
    bp: { desktop: { w: 600, h: 400 }, tablet: { w: 920 } },
    flow: { height: 480 },
  }, 'tablet'), {
    width: 920,
    height: 480,
  });
});

test('turning viewer resize off restores the measured frame fill', () => {
  const shrunk = { width: 240, height: 180 };
  assert.deepEqual(canvasDynamicWidgetDisplaySize(true, false, shrunk), shrunk);
  assert.deepEqual(canvasDynamicWidgetDisplaySize(false, false, shrunk), {
    width: '100%',
    height: '100%',
  });
  assert.deepEqual(canvasDynamicWidgetDisplaySize(true, true, shrunk), {
    width: '100%',
    height: '100%',
  });
});

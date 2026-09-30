// Shared, React-free helpers for the Canvas Dynamic Widget block.
//
// The widget itself is deliberately only a dashboard reference plus the
// explicit viewer-local resize preference.
// Keeping the URL and content rules here means the editor, public renderer,
// and persistence normaliser cannot accidentally grow a second copy of the
// dashboard widget configuration (which could expose stale/private data).

export const CANVAS_DYNAMIC_WIDGET_TYPE = 'dynamic-widget';

export const CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY = Object.freeze({
  w: 600,
  h: 400,
});

export const CANVAS_DYNAMIC_WIDGET_DEFAULT_CONTENT = Object.freeze({
  widgetId: '',
  allowUserResize: false,
});

/**
 * Dynamic widget content is intentionally a very small reference object.
 * Unknown fields are dropped so a copied dashboard response can never become
 * persisted Canvas content. allowUserResize is Canvas presentation policy,
 * not copied dashboard metadata, and defaults to false for old documents.
 */
export function normalizeCanvasDynamicWidgetContent(content) {
  return {
    widgetId: typeof content?.widgetId === 'string' ? content.widgetId.trim() : '',
    allowUserResize: content?.allowUserResize === true,
  };
}

export function canvasDashboardWidgetsUrl(options = {}) {
  const normalized = typeof options === 'number' ? { page: options } : (options || {});
  const params = new URLSearchParams({ embed: 'canvas' });
  if (normalized.page != null) params.set('page', String(normalized.page));
  if (normalized.pageSize != null) params.set('pageSize', String(normalized.pageSize));
  return `/api/dashboard/widgets?${params.toString()}`;
}

export function canvasDashboardWidgetUrl(widgetId) {
  if (widgetId == null || String(widgetId).trim() === '') return null;
  return `/api/dashboard/widgets/${encodeURIComponent(String(widgetId))}?embed=canvas`;
}

export function canvasDashboardWidgetDataUrl(widgetId) {
  const detailUrl = canvasDashboardWidgetUrl(widgetId);
  if (!detailUrl) return null;
  return detailUrl.replace('?embed=canvas', '/data?embed=canvas');
}

/**
 * The dashboard list response already carries the tenant palette alongside
 * shared/personal widgets. Keep this adapter tolerant of a missing/invalid
 * response, but never merge personal widgets into the Canvas picker.
 */
export function normalizeCanvasDashboardWidgetsResponse(payload) {
  const rawPagination = payload?.pagination;
  const pagination = rawPagination && typeof rawPagination === 'object'
    ? {
        page: Number(rawPagination.page) || 1,
        pageSize: Number(rawPagination.pageSize) || 50,
        total: Number(rawPagination.total) || 0,
        pages: Number(rawPagination.pages) || 1,
        hasMore: rawPagination.hasMore === true,
      }
    : null;
  return {
    shared: Array.isArray(payload?.shared) ? payload.shared : [],
    palette: Array.isArray(payload?.palette) ? payload.palette : [],
    pagination,
  };
}

/**
 * Resolve every shared discovery page while keeping the dashboard response's
 * palette. The first URL remains the default embed discovery URL; subsequent
 * requests follow the server's pagination contract.
 */
export async function collectCanvasDashboardWidgetPages(fetchPage) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('A page fetcher is required');
  }
  const shared = [];
  let palette = [];
  let page = 1;
  let pageSize = 50;
  let pagination = null;

  while (true) {
    const payload = await fetchPage(canvasDashboardWidgetsUrl(
      page === 1 ? {} : { page, pageSize },
    ));
    const result = normalizeCanvasDashboardWidgetsResponse(payload);
    shared.push(...result.shared);
    if (palette.length === 0) palette = result.palette;
    pagination = result.pagination;
    if (!pagination?.hasMore) break;
    const nextPage = pagination.page + 1;
    if (!Number.isInteger(nextPage) || nextPage <= page || nextPage > pagination.pages) break;
    page = nextPage;
    pageSize = pagination.pageSize || pageSize;
  }

  return { shared, palette, pagination };
}

export function canvasWidgetFromDetailResponse(payload) {
  return payload?.widget && typeof payload.widget === 'object'
    ? payload.widget
    : null;
}

/**
 * Query scopes are part of React Query keys. A Canvas page can contain the
 * same dashboard widget more than once, and each instance must have an
 * isolated cache entry so an auth transition cannot paint a previous
 * instance's data.
 */
export function canvasDynamicWidgetQueryScope(instanceId, widgetId = '') {
  const instance = String(instanceId || 'instance').trim() || 'instance';
  const widget = String(widgetId || '').trim();
  return `canvas-dynamic-widget:${instance}:${widget}`;
}

/**
 * Resize is display-only. A viewer may have a smaller local viewport (for
 * example, an accessible browser zoom/layout) but must never make an
 * embedded WidgetCard exceed the authored Canvas frame or persist dimensions.
 */
export function clampCanvasDynamicWidgetSize(
  width,
  height,
  authoredWidth = CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.w,
  authoredHeight = CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.h,
) {
  const maxWidth = Number.isFinite(Number(authoredWidth))
    ? Math.max(1, Number(authoredWidth))
    : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.w;
  const maxHeight = Number.isFinite(Number(authoredHeight))
    ? Math.max(1, Number(authoredHeight))
    : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.h;
  const safeWidth = Number.isFinite(Number(width)) ? Number(width) : maxWidth;
  const safeHeight = Number.isFinite(Number(height)) ? Number(height) : maxHeight;
  return {
    width: Math.max(1, Math.min(maxWidth, safeWidth)),
    height: Math.max(1, Math.min(maxHeight, safeHeight)),
  };
}

export function resizeCanvasDynamicWidgetSize(
  currentSize,
  patch,
  authoredWidth,
  authoredHeight,
) {
  const limits = canvasDynamicWidgetResizeLimits(
    authoredWidth,
    authoredHeight,
  );
  const clamped = clampCanvasDynamicWidgetSize(
    patch?.width ?? currentSize?.width,
    patch?.height ?? currentSize?.height,
    limits.maxWidth,
    limits.maxHeight,
  );
  return {
    width: Math.max(limits.minWidth, clamped.width),
    height: Math.max(limits.minHeight, clamped.height),
  };
}

export function canvasDynamicWidgetResizeLimits(
  authoredWidth,
  authoredHeight,
  minimumWidth = 160,
  minimumHeight = 120,
) {
  const maxWidth = Number.isFinite(Number(authoredWidth))
    ? Math.max(1, Number(authoredWidth))
    : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.w;
  const maxHeight = Number.isFinite(Number(authoredHeight))
    ? Math.max(1, Number(authoredHeight))
    : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.h;
  return {
    minWidth: Math.min(maxWidth, Math.max(1, Number(minimumWidth) || 1)),
    minHeight: Math.min(maxHeight, Math.max(1, Number(minimumHeight) || 1)),
    maxWidth,
    maxHeight,
  };
}

export function canvasDynamicWidgetAuthoredFrame(block, breakpoint = 'desktop') {
  const activeBreakpoint = ['desktop', 'tablet', 'mobile'].includes(breakpoint)
    ? breakpoint
    : 'desktop';
  const desktop = block?.bp?.desktop || {};
  const mergeDefined = (base, source) => Object.entries(source || {}).reduce(
    (result, [key, value]) => (
      value === undefined || value === null
        ? result
        : { ...result, [key]: value }
    ),
    { ...base },
  );
  const frame = {
    ...mergeDefined({}, desktop),
    ...(activeBreakpoint === 'tablet' || activeBreakpoint === 'mobile'
      ? mergeDefined({}, block?.bp?.tablet)
      : {}),
    ...(activeBreakpoint === 'mobile' ? mergeDefined({}, block?.bp?.mobile) : {}),
  };
  const width = Number(frame.w) > 0 ? Number(frame.w) : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.w;
  const height = Number(block?.flow?.height) > 0
    ? Number(block.flow.height)
    : (Number(frame.h) > 0 ? Number(frame.h) : CANVAS_DYNAMIC_WIDGET_DEFAULT_GEOMETRY.h);
  return { width, height };
}

export function canvasDynamicWidgetDisplaySize(
  allowUserResize,
  asEditor,
  localSize,
) {
  if (!allowUserResize || asEditor) {
    return { width: '100%', height: '100%' };
  }
  return {
    width: Number(localSize?.width) > 0 ? Number(localSize.width) : '100%',
    height: Number(localSize?.height) > 0 ? Number(localSize.height) : '100%',
  };
}

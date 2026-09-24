import {
  canvasDashboardWidgetUrl,
  collectCanvasDashboardWidgetPages,
} from './canvasDynamicWidget.js';

// Metadata belongs to the authenticated viewer, not the visual block instance.
// Share concurrent discovery only; discard it when the last observer leaves.
// Result/refresh state remains separately scoped to each Canvas card.
export function canvasWidgetDiscoveryOptions({ authScope, widgetId, ready, fetchJson }) {
  const common = {
    enabled: Boolean(ready && widgetId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  };
  return {
    list: {
      ...common,
      queryKey: ['canvas-dynamic-widget-list', authScope],
      queryFn: ({ signal }) => collectCanvasDashboardWidgetPages(
        url => fetchJson(url, signal),
      ),
    },
    detail: {
      ...common,
      queryKey: ['canvas-dynamic-widget-detail', authScope, widgetId],
      queryFn: ({ signal }) => fetchJson(canvasDashboardWidgetUrl(widgetId), signal),
    },
  };
}
// Layout identities include the destination: retargeting a choice must not
// inherit a connector drawn for a different connection.
export const funnelConnectorKey = edge => JSON.stringify([edge.source, edge.sourceHandle, edge.target]);
export const DEFAULT_FUNNEL_STEP_WIDTH = 215;
export const MIN_FUNNEL_STEP_WIDTH = 160;
export const MAX_FUNNEL_STEP_WIDTH = 640;
export const isFunnelStepWidth = width => Number.isInteger(width)
  && width >= MIN_FUNNEL_STEP_WIDTH && width <= MAX_FUNNEL_STEP_WIDTH;

export function funnelConnectorKeys(graph) {
  const keys = new Set();
  const nodes = graph?.nodes || [];
  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    const choices = node.type === 'condition'
      ? [...(node.rules || []).map((rule, i) => [`rule-${i}`, rule.to]), ['fallback', node.fallback]]
      : node.type === 'source' ? [['accept', node.accept]]
        : node.type === 'checkout' ? [] : [['accept', node.accept], ['skip', node.skip]];
    for (const [sourceHandle, target] of choices) {
      if (target && ids.has(target)) keys.add(funnelConnectorKey({ source: node.id, sourceHandle, target }));
    }
  }
  return keys;
}

export const isFunnelLayoutPoint = point => point && typeof point === 'object' && !Array.isArray(point)
  && Number.isFinite(point.x) && Number.isFinite(point.y)
  && Math.abs(point.x) <= 100000 && Math.abs(point.y) <= 100000;

// Remove only geometry whose node or connection was explicitly removed.
export function pruneFunnelEditorLayout(layout, graph) {
  const ids = new Set((graph?.nodes || []).map(node => node.id));
  const keys = funnelConnectorKeys(graph);
  return {
    ...layout,
    positions: Object.fromEntries(Object.entries(layout?.positions || {}).filter(([id]) => ids.has(id))),
    ...(layout?.nodeWidths ? { nodeWidths: Object.fromEntries(Object.entries(layout.nodeWidths).filter(([id]) => ids.has(id))) } : {}),
    ...(layout?.connectors ? { connectors: Object.fromEntries(Object.entries(layout.connectors).filter(([key]) => keys.has(key))) } : {}),
  };
}

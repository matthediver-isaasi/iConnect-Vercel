import { isFunnelImageUrl } from '../../../../shared/eventFunnelPresentation.mjs';

export function safeAddonImageUrl(value) {
  return isFunnelImageUrl(value) ? value : '';
}

export function addonPresentationPatch(current, key, value) {
  const next = { ...(current && typeof current === 'object' ? current : {}) };
  const clean = typeof value === 'string' ? value : '';
  if (clean) next[key] = clean;
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}

export function updateAddonPresentationNode(nodes, nodeId, key, value) {
  return (nodes || []).map(node => {
    if (node.id !== nodeId || node.type !== 'addon') return node;
    const presentation = addonPresentationPatch(node.presentation, key, value);
    if (presentation) return { ...node, presentation };
    const { presentation: ignored, ...rest } = node;
    void ignored;
    return rest;
  });
}

export function isAddonModalVisible(activeAddonId, closedAddonId) {
  return Boolean(activeAddonId && activeAddonId !== closedAddonId);
}

export function previousSameEventPurchase(nodes, currentNode, routeIds) {
  const eventKey = event => event && typeof event === 'object'
    ? JSON.stringify([event.kind, event.id])
    : JSON.stringify([undefined, event]);
  const route = Array.isArray(routeIds) ? routeIds : [];
  const byId = new Map((nodes || []).map(node => [node.id, node]));
  const ordered = route.map(id => byId.get(id)).filter(Boolean);
  if (currentNode && !ordered.some(node => node.id === currentNode.id)) ordered.push(currentNode);
  const index = ordered.findIndex(node => node.id === currentNode?.id);
  if (index < 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = ordered[cursor];
    if (['source', 'event', 'addon'].includes(candidate.type)
      && eventKey(candidate.event) === eventKey(currentNode.event)) return candidate;
  }
  return null;
}

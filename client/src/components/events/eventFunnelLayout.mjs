import dagre from '@dagrejs/dagre';
import { graphConnections } from './eventFunnelBuilderModel.mjs';

// A view-only projection: never attach layout metadata to the purchase graph.
export function autoLayoutFunnel(graph, measuredNodes = []) {
  const layout = new dagre.graphlib.Graph({ multigraph: true });
  layout.setGraph({ rankdir: 'TB', ranksep: 105, nodesep: 90, edgesep: 30, marginx: 45, marginy: 45 });
  layout.setDefaultEdgeLabel(() => ({}));
  const measured = new Map(measuredNodes.map(node => [node.id, node.measured || {}]));
  const nodes = graph?.nodes || [];
  for (const node of nodes) {
    const size = measured.get(node.id);
    layout.setNode(node.id, {
      width: Math.max(215, Number(size?.width) || 0),
      height: Math.max(130, Number(size?.height) || 0),
    });
  }
  for (const [index, edge] of graphConnections(graph).entries()) {
    if (layout.hasNode(edge.source) && layout.hasNode(edge.target)) {
      layout.setEdge(edge.source, edge.target, {}, String(index));
    }
  }
  dagre.layout(layout);
  return Object.fromEntries(nodes.map(node => {
    const placed = layout.node(node.id);
    return [node.id, { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 }];
  }));
}

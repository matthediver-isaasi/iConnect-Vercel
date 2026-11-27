import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { FUNNEL_PRESENTATION_TAGS, FUNNEL_PRESENTATION_ATTRS } from '../../shared/eventFunnelPresentation.mjs';

let purifier;
export function sanitizeFunnelPresentation(graph) {
  return { ...graph, nodes: graph.nodes.map(node => {
    if (!node.presentation) return node;
    const presentation = { ...node.presentation };
    if (presentation.bodyHtml) {
      purifier ??= createDOMPurify(new JSDOM('').window);
      presentation.bodyHtml = purifier.sanitize(presentation.bodyHtml, {
        ALLOWED_TAGS: FUNNEL_PRESENTATION_TAGS,
        ALLOWED_ATTR: FUNNEL_PRESENTATION_ATTRS,
        ALLOW_DATA_ATTR: false,
      });
    }
    return { ...node, presentation };
  }) };
}

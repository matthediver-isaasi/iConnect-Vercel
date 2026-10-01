import { BLOCK_TYPES, normalizeCanvasDesign, normalizeSymbolDesignFrames } from './canvasDesign.js';

const supportedTypes = new Set(Object.values(BLOCK_TYPES).filter(
  (type) => ![BLOCK_TYPES.SYMBOL, BLOCK_TYPES.ROW, BLOCK_TYPES.GROUP].includes(type),
));

// Check the stored document BEFORE normalizing: the normalizer deliberately
// repairs page documents, which is not permission to flatten a shared symbol.
export function getSymbolEditUnsupportedReason(design) {
  if (!design || design.version !== 1) {
    return 'Only version 1 positioned symbols can be edited here. Flow and other document versions are not supported.';
  }
  const sections = design.root?.sections;
  if (!Array.isArray(sections) || sections.length !== 1 || !Array.isArray(sections[0]?.children)) {
    return 'This symbol has an unsupported section structure. Editing would lose content, so it has not been opened.';
  }
  const ids = new Set();
  function check(blocks, nested = false) {
    for (const block of blocks) {
      if (!block || !supportedTypes.has(block.type)) {
        return 'This symbol contains nested symbols, flow containers, or an unknown block type. These cannot be edited here.';
      }
      if (block.children || block.layoutMode) {
        return 'This symbol contains a nested layout structure that this editor cannot safely preserve.';
      }
      if (!block.id || ids.has(block.id)) return 'This symbol has missing or duplicate block identifiers and cannot be safely edited.';
      ids.add(block.id);
      if (block.type === BLOCK_TYPES.ADVANCED_ACCORDION) {
        if (nested || !Array.isArray(block.content?.items)) return 'This symbol contains an unsupported accordion structure.';
        for (const item of block.content.items) {
          if (!Array.isArray(item?.children)) return 'This symbol contains an unsupported accordion structure.';
          const reason = check(item.children, true);
          if (reason) return reason;
        }
      }
    }
    return null;
  }
  return check(sections[0].children);
}

export function createSymbolEditorDocument(symbol) {
  const reason = getSymbolEditUnsupportedReason(symbol?.design);
  if (reason) throw new Error(reason);
  return normalizeCanvasDesign(symbol.design);
}

// Preserve extension metadata the page normalizer doesn't know, but never
// resurrect deleted blocks/items. Arrays represent the edited set and order.
function retainMetadata(original, edited, known) {
  if (Array.isArray(edited)) {
    return edited.map((value) => retainMetadata(
      value?.id ? original?.find?.((old) => old?.id === value.id) : undefined, value,
      value?.id ? known?.find?.((old) => old?.id === value.id) : undefined,
    ));
  }
  if (!edited || typeof edited !== 'object') return edited;
  const result = {};
  for (const [key, value] of Object.entries(original && typeof original === 'object' ? original : {})) {
    // Only restore metadata that the builder never received. A known key
    // absent from the draft was deliberately cleared (e.g. Reset override).
    if (!(key in edited) && !(known && typeof known === 'object' && key in known)) result[key] = value;
  }
  for (const [key, value] of Object.entries(edited)) {
    result[key] = retainMetadata(original?.[key], value, known?.[key]);
  }
  return result;
}

export function prepareSymbolEditorSave(originalDesign, draft) {
  const reason = getSymbolEditUnsupportedReason(draft);
  if (reason) throw new Error(reason);
  const normalized = normalizeSymbolDesignFrames(draft);
  return retainMetadata(originalDesign, normalized, normalizeCanvasDesign(originalDesign));
}
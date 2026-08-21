import { sanitizeAnchorId } from './canvasDesign.js';

export const ADVANCED_ACCORDION_MODES = new Set([
  'multiple',
  'single',
  'single-required',
]);

function blockTreeHasAnchor(block, target, depth = 0) {
  if (!block || typeof block !== 'object' || depth > 24) return false;
  if (sanitizeAnchorId(block.anchorId || '') === target) return true;
  return (Array.isArray(block.children) ? block.children : [])
    .some((child) => blockTreeHasAnchor(child, target, depth + 1));
}

export function findAdvancedAccordionHashItemId(content, hash = '') {
  const target = sanitizeAnchorId(String(hash || '').replace(/^#/, ''));
  if (!target) return '';
  const items = Array.isArray(content?.items) ? content.items : [];
  const match = items.find((item) => (
    sanitizeAnchorId(item?.anchor || '') === target
    || (Array.isArray(item?.children) ? item.children : [])
      .some((child) => blockTreeHasAnchor(child, target))
  ));
  return match?.id || '';
}

export function resolveAdvancedAccordionInitialOpen(content, hash = '') {
  const items = Array.isArray(content?.items) ? content.items : [];
  const ids = new Set(items.map((item) => item?.id).filter(Boolean));
  const hashItemId = findAdvancedAccordionHashItemId(content, hash);
  if (hashItemId) return [hashItemId];

  const mode = ADVANCED_ACCORDION_MODES.has(content?.mode)
    ? content.mode
    : 'single';
  const state = content?.initialState || 'all-closed';
  const configured = Array.isArray(content?.initialOpenIds)
    ? content.initialOpenIds.filter((id) => ids.has(id))
    : [];

  if (state === 'first' || (mode === 'single-required' && state === 'all-closed')) {
    return items[0]?.id ? [items[0].id] : [];
  }
  if (state === 'specific') {
    const id = configured[0] || (ids.has(content?.initialId) ? content.initialId : '');
    return id ? [id] : (mode === 'single-required' && items[0]?.id ? [items[0].id] : []);
  }
  if (state === 'multiple' && mode === 'multiple') {
    return Array.from(new Set(configured));
  }
  return mode === 'single-required' && items[0]?.id ? [items[0].id] : [];
}

export function toggleAdvancedAccordionOpen(currentIds, itemId, mode, itemIds = []) {
  const current = Array.from(new Set((Array.isArray(currentIds) ? currentIds : []).filter(Boolean)));
  const isOpen = current.includes(itemId);
  if (mode === 'multiple') {
    return isOpen ? current.filter((id) => id !== itemId) : [...current, itemId];
  }
  if (mode === 'single-required') {
    return isOpen ? current : [itemId];
  }
  return isOpen ? [] : [itemId];
}

export function reconcileAdvancedAccordionOpen(currentIds, content) {
  const items = Array.isArray(content?.items) ? content.items : [];
  const valid = new Set(items.map((item) => item?.id).filter(Boolean));
  let next = Array.from(new Set((Array.isArray(currentIds) ? currentIds : []).filter((id) => valid.has(id))));
  if (content?.mode !== 'multiple' && next.length > 1) next = next.slice(0, 1);
  if (content?.mode === 'single-required' && next.length === 0 && items[0]?.id) next = [items[0].id];
  return next;
}
/**
 * AI Composition patch applier — Phase 2 (Task #2850).
 *
 * Pure, dependency-free logic for applying validated patch operations to an
 * AI Composition document (spec §15), enforcing protected values (§17),
 * breakpoint isolation (§18) and collecting internal link references for
 * broken-link checks (§16).
 *
 * `applyPatch(doc, ops)` never mutates the input document. It deep-clones,
 * applies each operation, then re-runs `validateComposition()` — an invalid
 * result returns `{ ok: false }` with the ORIGINAL document untouched.
 */

import {
  validateComposition,
  validatePatch,
  AI_BREAKPOINTS,
} from './aiCompositionSchema.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Find an element anywhere in the document. Returns { el, section, parentList, index } or null. */
export function findElement(doc, elementId) {
  for (const section of doc?.sections || []) {
    const stack = [{ list: section.elements || [] }];
    while (stack.length) {
      const { list } = stack.pop();
      for (let i = 0; i < list.length; i += 1) {
        const el = list[i];
        if (!el) continue;
        if (el.id === elementId) return { el, section, parentList: list, index: i };
        if (Array.isArray(el.children)) stack.push({ list: el.children });
      }
    }
  }
  return null;
}

export function findSection(doc, sectionId) {
  const sections = doc?.sections || [];
  const index = sections.findIndex((s) => s && s.id === sectionId);
  return index === -1 ? null : { section: sections[index], index };
}

/** All element ids inside a section (top-level + nested). */
export function sectionElementIds(section) {
  const ids = [];
  const walk = (els) => {
    for (const el of els || []) {
      if (!el || !el.id) continue;
      ids.push(el.id);
      if (Array.isArray(el.children)) walk(el.children);
    }
  };
  walk(section?.elements);
  return ids;
}

/** All element ids inside an element subtree (including itself). */
function subtreeIds(el) {
  const ids = [];
  const walk = (e) => {
    if (!e || !e.id) return;
    ids.push(e.id);
    for (const c of e.children || []) walk(c);
  };
  walk(el);
  return ids;
}

function removeLayoutFrames(doc, ids) {
  const idSet = new Set(ids);
  for (const bp of AI_BREAKPOINTS) {
    const map = doc.layouts?.[bp];
    if (!isPlainObject(map)) continue;
    for (const id of Object.keys(map)) {
      if (idSet.has(id)) delete map[id];
    }
  }
}

function removeProtectedFor(doc, ids) {
  if (!Array.isArray(doc.protectedValues)) return;
  const idSet = new Set(ids);
  doc.protectedValues = doc.protectedValues.filter((pv) => !idSet.has(pv?.elementId));
}

/** Merge per-breakpoint frames for a set of elements into doc.layouts. */
function mergeLayouts(doc, layouts) {
  if (!isPlainObject(layouts)) return;
  if (!isPlainObject(doc.layouts)) doc.layouts = {};
  for (const bp of AI_BREAKPOINTS) {
    const src = layouts[bp];
    if (!isPlainObject(src)) continue;
    if (!isPlainObject(doc.layouts[bp])) doc.layouts[bp] = {};
    for (const [id, frame] of Object.entries(src)) {
      doc.layouts[bp][id] = frame;
    }
  }
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

function applyOne(doc, op) {
  switch (op.op) {
    case 'update_content': {
      const found = findElement(doc, op.elementId);
      if (!found) return `update_content: element "${op.elementId}" not found`;
      if (!isPlainObject(op.changes)) return 'update_content: changes object required';
      found.el.content = { ...(found.el.content || {}), ...op.changes };
      // role change for headings rides along on changes.role
      if (typeof op.changes.role === 'string') {
        found.el.role = op.changes.role;
        delete found.el.content.role;
      }
      return null;
    }
    case 'update_link': {
      const found = findElement(doc, op.elementId);
      if (!found) return `update_link: element "${op.elementId}" not found`;
      if (op.changes?.link === null) { delete found.el.link; return null; }
      if (!isPlainObject(op.changes?.link)) return 'update_link: changes.link required';
      found.el.link = op.changes.link;
      return null;
    }
    case 'update_style': {
      const found = findElement(doc, op.elementId);
      if (!found) return `update_style: element "${op.elementId}" not found`;
      if (isPlainObject(op.changes?.style)) {
        found.el.style = { ...(found.el.style || {}), ...op.changes.style };
        for (const [k, v] of Object.entries(found.el.style)) {
          if (v === null || v === undefined) delete found.el.style[k];
        }
      }
      if (isPlainObject(op.changes?.frame)) {
        const bp = op.breakpoint && op.breakpoint !== 'all' ? op.breakpoint : 'desktop';
        if (!isPlainObject(doc.layouts)) doc.layouts = {};
        if (!isPlainObject(doc.layouts[bp])) doc.layouts[bp] = {};
        doc.layouts[bp][op.elementId] = {
          ...(doc.layouts[bp][op.elementId] || {}),
          ...op.changes.frame,
        };
      }
      return null;
    }
    case 'replace_asset': {
      const found = findElement(doc, op.elementId);
      if (!found) return `replace_asset: element "${op.elementId}" not found`;
      if (!isPlainObject(op.asset)) return 'replace_asset: asset object required';
      found.el.asset = op.asset;
      return null;
    }
    case 'update_data': {
      const found = findElement(doc, op.elementId);
      if (!found) return `update_data: element "${op.elementId}" not found`;
      if (!isPlainObject(op.changes)) return 'update_data: changes object required';
      found.el.data = { ...(found.el.data || {}), ...op.changes };
      return null;
    }
    case 'insert_element': {
      const target = findSection(doc, op.sectionId);
      if (!target) return `insert_element: section "${op.sectionId}" not found`;
      if (!isPlainObject(op.element) || !op.element.id) return 'insert_element: element with id required';
      if (findElement(doc, op.element.id)) return `insert_element: id "${op.element.id}" already exists`;
      const { section } = target;
      if (op.parentId) {
        const parent = findElement(doc, op.parentId);
        if (!parent) return `insert_element: parent "${op.parentId}" not found`;
        if (!Array.isArray(parent.el.children)) parent.el.children = [];
        parent.el.children.push(op.element);
      } else {
        const pos = Number.isInteger(op.position)
          ? Math.max(0, Math.min(op.position, section.elements.length))
          : section.elements.length;
        section.elements.splice(pos, 0, op.element);
        if (!Array.isArray(section.readingOrder)) section.readingOrder = [];
        const roPos = Number.isInteger(op.position)
          ? Math.max(0, Math.min(op.position, section.readingOrder.length))
          : section.readingOrder.length;
        section.readingOrder.splice(roPos, 0, op.element.id);
      }
      mergeLayouts(doc, op.layouts);
      // Convenience: single desktop frame via op.frame.
      if (isPlainObject(op.frame)) {
        if (!isPlainObject(doc.layouts)) doc.layouts = {};
        if (!isPlainObject(doc.layouts.desktop)) doc.layouts.desktop = {};
        doc.layouts.desktop[op.element.id] = op.frame;
      }
      return null;
    }
    case 'remove_element': {
      const found = findElement(doc, op.elementId);
      if (!found) return `remove_element: element "${op.elementId}" not found`;
      const ids = subtreeIds(found.el);
      found.parentList.splice(found.index, 1);
      if (Array.isArray(found.section.readingOrder)) {
        found.section.readingOrder = found.section.readingOrder.filter((id) => id !== op.elementId);
      }
      removeLayoutFrames(doc, ids);
      removeProtectedFor(doc, ids);
      return null;
    }
    case 'insert_section': {
      if (!isPlainObject(op.section) || !op.section.id) return 'insert_section: section with id required';
      if (findSection(doc, op.section.id)) return `insert_section: id "${op.section.id}" already exists`;
      const pos = Number.isInteger(op.position)
        ? Math.max(0, Math.min(op.position, doc.sections.length))
        : doc.sections.length;
      doc.sections.splice(pos, 0, op.section);
      mergeLayouts(doc, op.layouts);
      if (doc.compositionType === 'section' && doc.sections.length > 1) {
        doc.compositionType = 'multi_section_page';
      }
      return null;
    }
    case 'remove_section': {
      const target = findSection(doc, op.sectionId);
      if (!target) return `remove_section: section "${op.sectionId}" not found`;
      if (doc.sections.length <= 1) return 'remove_section: cannot remove the only section';
      const ids = sectionElementIds(target.section);
      doc.sections.splice(target.index, 1);
      removeLayoutFrames(doc, ids);
      removeProtectedFor(doc, ids);
      return null;
    }
    case 'reorder_sections': {
      if (!Array.isArray(op.order)) return 'reorder_sections: order array required';
      const byId = new Map(doc.sections.map((s) => [s.id, s]));
      if (op.order.length !== doc.sections.length) return 'reorder_sections: order must list every section exactly once';
      const next = [];
      for (const id of op.order) {
        const s = byId.get(id);
        if (!s) return `reorder_sections: unknown section "${id}"`;
        byId.delete(id);
        next.push(s);
      }
      doc.sections = next;
      return null;
    }
    case 'replace_section': {
      const target = findSection(doc, op.sectionId);
      if (!target) return `replace_section: section "${op.sectionId}" not found`;
      if (!isPlainObject(op.section) || !op.section.id) return 'replace_section: section with id required';
      const oldIds = sectionElementIds(target.section);
      const newIds = new Set(sectionElementIds(op.section));
      doc.sections[target.index] = op.section;
      // Drop frames for elements that no longer exist; keep frames whose ids
      // survive (redesigns that keep protected elements keep their bindings).
      removeLayoutFrames(doc, oldIds.filter((id) => !newIds.has(id)));
      mergeLayouts(doc, op.layouts);
      return null;
    }
    default:
      return `unknown op "${op.op}"`;
  }
}

/**
 * Apply a patch to a document. Pure: the input is never mutated.
 * @returns {{ ok: true, doc: object } | { ok: false, errors: string[] }}
 */
export function applyPatch(doc, ops) {
  const structural = validatePatch(ops);
  if (!structural.ok) return { ok: false, errors: structural.errors };
  const next = clone(doc);
  for (let i = 0; i < ops.length; i += 1) {
    const err = applyOne(next, ops[i]);
    if (err) return { ok: false, errors: [`patch[${i}]: ${err}`] };
  }
  const result = validateComposition(next);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, doc: next };
}

// ---------------------------------------------------------------------------
// Protected values (§17)
// ---------------------------------------------------------------------------

function getAtPath(root, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Compare a document against its predecessor's protected values.
 * Returns the list of violations — protected values that were removed or
 * changed. Empty array ⇒ every protected value survived.
 *
 * A violation carries { kind, elementId, path, before, after, reason }.
 */
export function diffProtectedValues(beforeDoc, afterDoc) {
  const violations = [];
  for (const pv of beforeDoc?.protectedValues || []) {
    if (!pv || !pv.elementId || !pv.path) continue;
    const beforeEl = findElement(beforeDoc, pv.elementId)?.el;
    if (!beforeEl) continue; // stale marker — nothing to protect
    const afterEl = findElement(afterDoc, pv.elementId)?.el;
    const beforeVal = getAtPath(beforeEl, pv.path);
    if (!afterEl) {
      violations.push({ ...pv, before: beforeVal, after: undefined, reason: 'element removed' });
      continue;
    }
    const afterVal = getAtPath(afterEl, pv.path);
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      violations.push({ ...pv, before: beforeVal, after: afterVal, reason: 'value changed' });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Breakpoint isolation (§18)
// ---------------------------------------------------------------------------

/**
 * For a breakpoint-scoped edit, every OTHER breakpoint's layout map must be
 * unchanged. Returns a list of violation strings (empty = isolated).
 */
export function checkBreakpointIsolation(beforeDoc, afterDoc, breakpoint) {
  if (!breakpoint || breakpoint === 'all') return [];
  const violations = [];
  for (const bp of AI_BREAKPOINTS) {
    if (bp === breakpoint) continue;
    const a = beforeDoc?.layouts?.[bp] || {};
    const b = afterDoc?.layouts?.[bp] || {};
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      violations.push(`layouts.${bp} changed during a ${breakpoint}-only edit`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Link collection (§16 broken-link checks)
// ---------------------------------------------------------------------------

const LINK_ID_FIELDS = {
  page: ['pageId', 'i_edit_page'],
  event_registration: ['eventId', 'event'],
  form: ['formId', 'form'],
  document: ['fileId', 'file_repository'],
  membership_application: ['tierId', 'membership_tier_config'],
};

/**
 * Collect every internal record-ID link reference in the document.
 * Returns [{ elementId, kind, table, field, id }]. Kinds without a record
 * lookup (external/email/tel/anchor/iconnect_action) are skipped.
 */
export function collectLinkRefs(doc) {
  const refs = [];
  const visit = (el) => {
    if (!el || typeof el !== 'object') return;
    const link = el.link;
    if (isPlainObject(link) && LINK_ID_FIELDS[link.kind]) {
      const [field, table] = LINK_ID_FIELDS[link.kind];
      const id = link[field];
      if (typeof id === 'string' && id) {
        refs.push({ elementId: el.id, kind: link.kind, table, field, id });
      }
    }
    for (const c of el.children || []) visit(c);
  };
  for (const s of doc?.sections || []) for (const el of s.elements || []) visit(el);
  return refs;
}

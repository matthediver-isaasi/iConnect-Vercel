// Task #2558 — the ONE shared, pure flow (auto-layout) resolution engine.
//
// Given a normalized flow (v2) design, a breakpoint, an available container
// width, and a map of measured leaf heights, this module computes an absolute
// {x,y,w,h} box for every node. It is the single source of truth that BOTH the
// builder (live preview) and the published page renderer will drive off, so the
// two surfaces can never drift (the exact drift problem the absolute-coordinate
// model created).
//
// Design constraints:
//   - PURE + React-free: no DOM, no imports beyond the data-layer constants, so
//     it runs identically in the browser (builder), on Vercel (SSR/render), and
//     under `node --test`.
//   - DETERMINISTIC: same inputs -> same boxes. Measurement is injected via the
//     `measured` map; the engine never measures anything itself.
//
// Coordinate space: every returned box is ABSOLUTE (relative to the page
// origin, 0,0 at the top-left of the first section), so a consumer can position
// everything from one flat map or diff it cheaply.
//
// Layout rules (mirrors the model doc in canvasDesign.js):
//   - The root stacks its sections vertically (section flow.margin adds space).
//   - A FLOW section/group stacks its children vertically; gap sits between
//     children; a child may narrow itself via flow.basis/maxWidth + align.
//   - A FLOW row lays its children out horizontally as columns; widths derive
//     from flow.basis/flow.grow; row height = max column height.
//   - A FREE container places its children by their absolute bp geometry
//     (overlap preserved) and is rigid internally, but still flows as one item
//     in its parent.
//   - A leaf's height = fixed (flow.height) | measured[id].height | bp geom h.

import {
  BLOCK_TYPES,
  LAYOUT_MODES,
  BREAKPOINT_WIDTHS,
  resolveBlockAtBreakpoint,
  isFlowContainerType,
  AUTO_HEIGHT_LEAF_TYPES,
} from './canvasDesign.js';

// Resolve a `flow.basis` value (px number, '<n>%' string, or null) against an
// available main-axis size. null -> the full available size (stretch).
function resolveBasis(basis, avail) {
  if (typeof basis === 'number' && Number.isFinite(basis)) return basis;
  if (typeof basis === 'string') {
    const s = basis.trim();
    if (s.endsWith('%')) {
      const pct = Number(s.slice(0, -1));
      if (Number.isFinite(pct)) return (pct / 100) * avail;
    } else if (Number.isFinite(Number(s))) {
      return Number(s);
    }
  }
  return avail;
}

// Is this node hidden at the given breakpoint? A per-breakpoint responsive
// override wins; otherwise fall back to the bp-geometry `hidden` cascade so v1
// per-breakpoint hides keep working after conversion.
function isHiddenAt(node, breakpoint) {
  const r = node.responsive && node.responsive[breakpoint];
  if (r && typeof r.hidden === 'boolean') return r.hidden;
  const geom = resolveBlockAtBreakpoint(node, breakpoint);
  return !!geom.hidden;
}

// Children in render order, honoring per-breakpoint `order` overrides (stable).
function orderedVisibleChildren(node, breakpoint) {
  const children = Array.isArray(node.children) ? node.children : [];
  return children
    .map((child, index) => {
      const r = child.responsive && child.responsive[breakpoint];
      const order = r && Number.isFinite(r.order) ? r.order : index;
      return { child, index, order };
    })
    .filter(({ child }) => !isHiddenAt(child, breakpoint))
    .sort((a, b) => (a.order - b.order) || (a.index - b.index))
    .map(({ child }) => child);
}

// Should a Row collapse to a vertical stack at this breakpoint?
function rowStacksAt(node, breakpoint) {
  const r = node.responsive && node.responsive[breakpoint];
  if (r && typeof r.stack === 'boolean') return r.stack;
  const c = node.content || {};
  if (breakpoint === 'tablet') return !!c.stackTablet;
  if (breakpoint === 'mobile') return c.stackMobile !== false; // default stack on mobile
  return false;
}

function leafHeight(node, breakpoint, measured) {
  const flow = node.flow || {};
  if (flow.heightMode === 'fixed' && Number.isFinite(flow.height)) return flow.height;
  const m = measured && measured[node.id];
  if (m && Number.isFinite(m.height)) return m.height;
  const geom = resolveBlockAtBreakpoint(node, breakpoint);
  return Number.isFinite(geom.h) ? geom.h : 0;
}

// Core recursive layout. Writes boxes into `ctx.boxes` and returns this node's
// resolved height. `x`/`y` are the node's absolute top-left; `width` is the
// width allotted to the node by its parent.
function layoutNode(node, x, y, width, ctx) {
  const { breakpoint, measured } = ctx;

  if (!isFlowContainerType(node.type)) {
    const h = leafHeight(node, breakpoint, measured);
    ctx.boxes[node.id] = { x, y, w: width, h };
    return h;
  }

  const flow = node.flow || {};
  // Optional centered content max-width.
  let boxX = x;
  let boxW = width;
  if (Number.isFinite(flow.maxWidth) && flow.maxWidth > 0 && flow.maxWidth < width) {
    boxX = x + (width - flow.maxWidth) / 2;
    boxW = flow.maxWidth;
  }
  const padTop = flow.padTop || 0;
  const padRight = flow.padRight || 0;
  const padBottom = flow.padBottom || 0;
  const padLeft = flow.padLeft || 0;
  const innerX = boxX + padLeft;
  const innerY = y + padTop;
  const innerW = Math.max(0, boxW - padLeft - padRight);

  let contentHeight = 0;

  if (node.layoutMode === LAYOUT_MODES.FREE) {
    contentHeight = layoutFreeChildren(node, innerX, innerY, innerW, ctx);
  } else if (node.type === BLOCK_TYPES.ROW && !rowStacksAt(node, breakpoint)) {
    contentHeight = layoutRow(node, innerX, innerY, innerW, ctx);
  } else {
    contentHeight = layoutStack(node, innerX, innerY, innerW, ctx);
  }

  let h = padTop + contentHeight + padBottom;
  if (flow.heightMode === 'fixed' && Number.isFinite(flow.height)) h = flow.height;

  ctx.boxes[node.id] = { x: boxX, y, w: boxW, h };
  return h;
}

// FREE: place children by absolute bp geometry (overlap preserved). Containers
// recurse (so nested content still gets boxes) but the free child stays rigid
// at its geometry box — the container's own reported height is its geom h.
function layoutFreeChildren(node, innerX, innerY, innerW, ctx) {
  const { breakpoint, measured } = ctx;
  // First pass: place every child and record its stored vs measured height so
  // the second pass can grow background boxes that wrap taller content.
  const placed = [];
  for (const child of node.children || []) {
    if (isHiddenAt(child, breakpoint)) continue;
    const geom = resolveBlockAtBreakpoint(child, breakpoint, { canvasWidth: innerW });
    const cx = innerX + (Number.isFinite(geom.x) ? geom.x : 0);
    const cy = innerY + (Number.isFinite(geom.y) ? geom.y : 0);
    const cw = Number.isFinite(geom.w) ? geom.w : innerW;
    const storedH = Number.isFinite(geom.h) ? geom.h : 0;
    // Use the MEASURED leaf height (falls back to stored/geom h) so a text
    // block whose content grew past its stored height reports its true bottom.
    // This also feeds `maxBottom`, so the enclosing FREE container's reported
    // height correctly pushes sibling sections further down the page.
    const isContainer = isFlowContainerType(child.type);
    const ch = isContainer ? storedH : leafHeight(child, breakpoint, measured);
    if (isContainer) {
      layoutNode(child, cx, cy, cw, ctx);
      // Keep the free child rigid at its authored geometry height.
      ctx.boxes[child.id] = { x: cx, y: cy, w: cw, h: ch };
    } else {
      ctx.boxes[child.id] = { x: cx, y: cy, w: cw, h: ch };
    }
    placed.push({ child, cx, cy, cw, storedH, measuredH: ch });
  }

  // Second pass: resize background-style boxes so they stay wrapped around any
  // overlapping child. A candidate is a `box` (or any non-container leaf that is
  // not itself auto-height — future shape types). A child is "inside" the box
  // when its stored bounds fit within the box's stored bounds.
  //
  // The box is sized from the GEOMETRY of the content it wraps, not from a global
  // max over per-child height deltas: it keeps its authored bottom inset (the gap
  // the author left below the deepest contained child) and re-anchors that inset
  // beneath the deepest child's LIVE (measured) bottom.
  //   - content grew: the box GROWS to keep wrapping it (#2575).
  //   - content shrank / was removed: the box SHRINKS back toward its authored
  //     height so a box that grew once no longer stays too tall (Task #2583).
  //   - a fixed-height child (image/icon) that did not change contributes its
  //     unchanged bottom, so it can neither block a shrink driven by shrinking
  //     text nor force spurious growth.
  // With no measurement (measured === stored) the deepest measured bottom equals
  // the deepest stored bottom, so the box keeps its authored height exactly. The
  // authored inset is non-negative, so the box always fully contains its live
  // content and can never clip it.
  for (const bg of placed) {
    const isCandidate =
      bg.child.type === BLOCK_TYPES.BOX ||
      (!isFlowContainerType(bg.child.type) && !AUTO_HEIGHT_LEAF_TYPES.has(bg.child.type));
    if (!isCandidate) continue;
    const bgRight = bg.cx + bg.cw;
    const bgBottom = bg.cy + bg.storedH;
    let deepestMeasuredBottomRel = null; // null = no contained child
    let deepestStoredBottomRel = 0;
    for (const c of placed) {
      if (c === bg) continue;
      const cRight = c.cx + c.cw;
      const cBottom = c.cy + c.storedH;
      const inside =
        c.cx >= bg.cx && c.cy >= bg.cy && cRight <= bgRight && cBottom <= bgBottom;
      if (!inside) continue;
      const measuredBottomRel = (c.cy - bg.cy) + c.measuredH;
      const storedBottomRel = (c.cy - bg.cy) + c.storedH;
      if (deepestMeasuredBottomRel === null || measuredBottomRel > deepestMeasuredBottomRel) {
        deepestMeasuredBottomRel = measuredBottomRel;
      }
      if (storedBottomRel > deepestStoredBottomRel) deepestStoredBottomRel = storedBottomRel;
    }
    if (deepestMeasuredBottomRel !== null && ctx.boxes[bg.child.id]) {
      const authoredBottomInset = Math.max(0, bg.storedH - deepestStoredBottomRel);
      ctx.boxes[bg.child.id].h = deepestMeasuredBottomRel + authoredBottomInset;
    }
  }

  // Recompute the container's content height from the (possibly grown) boxes so
  // its reported height reflects both taller text and any grown background box.
  let maxBottom = 0;
  for (const p of placed) {
    const box = ctx.boxes[p.child.id];
    const h = box ? box.h : p.measuredH;
    maxBottom = Math.max(maxBottom, (p.cy - innerY) + h);
  }
  return maxBottom;
}

// FLOW vertical stack (sections, flow groups, stacked rows).
function layoutStack(node, innerX, innerY, innerW, ctx) {
  const { breakpoint } = ctx;
  const flow = node.flow || {};
  const gap = flow.gap || 0;
  const align = flow.align || 'stretch';
  const children = orderedVisibleChildren(node, breakpoint);

  let cursor = innerY;
  children.forEach((child, i) => {
    const cf = child.flow || {};
    cursor += cf.marginTop || 0;
    // Cross-axis (horizontal) sizing/placement of the child within innerW.
    let cw = innerW;
    let cx = innerX;
    if (align !== 'stretch') {
      cw = Math.min(innerW, resolveBasis(cf.basis, innerW));
      if (align === 'center') cx = innerX + (innerW - cw) / 2;
      else if (align === 'end') cx = innerX + (innerW - cw);
    }
    const h = layoutNode(child, cx, cursor, cw, ctx);
    cursor += h + (cf.marginBottom || 0);
    if (i < children.length - 1) cursor += gap;
  });
  return Math.max(0, cursor - innerY);
}

// FLOW row: horizontal columns. Widths derive from flow.basis (fixed px/%) and
// flow.grow (share of the leftover); null-basis children split leftover equally
// when no grow is specified. Row height = max column height; cross-axis align
// positions each column vertically within that height.
function layoutRow(node, innerX, innerY, innerW, ctx) {
  const flow = node.flow || {};
  const gap = flow.gap || 0;
  const align = flow.align || 'stretch';
  const justify = flow.justify || 'start';
  const children = orderedVisibleChildren(node, ctx.breakpoint);
  const n = children.length;
  if (n === 0) return 0;

  const availableMain = Math.max(0, innerW - gap * (n - 1));

  // Base widths from basis; leftover distributed by weight (grow, else
  // equal share among null-basis children).
  const bases = children.map((c) => {
    const b = (c.flow || {}).basis;
    return b == null ? null : resolveBasis(b, availableMain);
  });
  const sumBase = bases.reduce((s, b) => s + (b || 0), 0);
  const remaining = Math.max(0, availableMain - sumBase);
  const grows = children.map((c) => (c.flow || {}).grow || 0);
  const sumGrow = grows.reduce((s, g) => s + g, 0);
  const nullCount = bases.filter((b) => b == null).length;

  const weights = children.map((c, i) => {
    if (sumGrow > 0) return grows[i];
    return bases[i] == null ? 1 : 0;
  });
  const sumWeights = weights.reduce((s, w) => s + w, 0);

  const widths = children.map((c, i) => {
    const base = bases[i] == null ? 0 : bases[i];
    const extra = sumWeights > 0 ? remaining * (weights[i] / sumWeights) : 0;
    return base + extra;
  });

  const sumWidths = widths.reduce((s, w) => s + w, 0);
  // Leading offset + inter-column spacing when there is unallocated space.
  const slack = Math.max(0, availableMain - sumWidths);
  let cursor = innerX;
  let extraGap = 0;
  if (sumWeights === 0 && slack > 0) {
    if (justify === 'center') cursor += slack / 2;
    else if (justify === 'end') cursor += slack;
    else if (justify === 'between' && n > 1) extraGap = slack / (n - 1);
    else if (justify === 'around') { cursor += slack / (n * 2); extraGap = slack / n; }
  }

  // First pass: lay out each column to learn its natural height.
  const cols = children.map((child, i) => {
    const cx = cursor;
    const h = layoutNode(child, cx, innerY, widths[i], ctx);
    cursor += widths[i] + gap + extraGap;
    return { child, cx, w: widths[i], h };
  });
  const rowHeight = cols.reduce((m, c) => Math.max(m, c.h), 0);

  // Second pass: apply cross-axis alignment (and stretch to equal height).
  for (const col of cols) {
    const box = ctx.boxes[col.child.id];
    if (!box) continue;
    if (align === 'stretch') {
      box.h = rowHeight;
    } else if (align === 'center') {
      box.y = innerY + (rowHeight - col.h) / 2;
    } else if (align === 'end') {
      box.y = innerY + (rowHeight - col.h);
    }
  }
  return rowHeight;
}

// Public entry point. Returns { boxes: { [id]: {x,y,w,h} }, height }.
export function resolveFlowLayout(design, options = {}) {
  const breakpoint = options.breakpoint || 'desktop';
  const containerWidth = Number.isFinite(options.containerWidth)
    ? options.containerWidth
    : (BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop);
  const measured = options.measured || {};
  const ctx = { breakpoint, measured, boxes: {} };

  const sections = (design && design.root && design.root.sections) || [];
  let y = 0;
  for (const section of sections) {
    if (isHiddenAt(section, breakpoint)) continue;
    const sf = section.flow || {};
    y += sf.marginTop || 0;
    const h = layoutNode(section, 0, y, containerWidth, ctx);
    y += h + (sf.marginBottom || 0);
  }
  return { boxes: ctx.boxes, height: y };
}

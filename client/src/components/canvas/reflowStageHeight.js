import { BLOCK_TYPES, blockIsFullWidthLike } from '../../lib/canvasDesign';

// Slack used by aspect-height carousels when deciding whether a block authored
// flush beneath the visible carousel should follow its signed grow/shrink.
export const SIGNED_ROW_PUSH_TOLERANCE = 12;

function numericBound(value) {
  return typeof value === 'number' && !Number.isNaN(value);
}

function horizontalBounds(item) {
  if (!item) return null;
  if (item.fullWidth) return { left: -Infinity, right: Infinity };
  const left = numericBound(item.left)
    ? item.left
    : (Number.isFinite(item.x) ? item.x : null);
  const right = numericBound(item.right)
    ? item.right
    : (
      Number.isFinite(item.x) && Number.isFinite(item.w)
        ? item.x + Math.max(0, item.w)
        : null
    );
  if (!numericBound(left) || !numericBound(right)) return null;
  return { left, right };
}

export function horizontalReflowOverlap(a, b) {
  const aBounds = horizontalBounds(a);
  const bBounds = horizontalBounds(b);
  // Legacy/pre-spatial row fixtures have no X bounds. Treat them as full-width
  // so existing callers keep the former vertical-only behaviour.
  if (!aBounds || !bBounds) return true;
  return aBounds.left < bBounds.right && bBounds.left < aBounds.right;
}

function containsMember(containerGeom, member) {
  if (!containerGeom || !member) return false;
  const containerTop = Number.isFinite(containerGeom.y) ? containerGeom.y : 0;
  const containerBottom = containerTop + (Number.isFinite(containerGeom.h) ? containerGeom.h : 0);
  const memberTop = Number.isFinite(member.top) ? member.top : 0;
  const memberBottom = Number.isFinite(member.bottom)
    ? member.bottom
    : memberTop;
  if (memberTop < containerTop || memberBottom > containerBottom) return false;

  const containerBounds = horizontalBounds(containerGeom);
  const memberBounds = horizontalBounds({
    ...member,
    // Full-width is a rendering instruction. Geometric containment must still
    // use the block's resolved stored bounds.
    fullWidth: false,
  });
  if (!containerBounds || !memberBounds) return true;
  return memberBounds.left >= containerBounds.left && memberBounds.right <= containerBounds.right;
}

function createRow(entry) {
  return {
    top: entry.top,
    bottom: entry.bottom,
    refBottom: entry.refBottom,
    left: entry.left,
    right: entry.right,
    fullWidth: !!entry.fullWidth,
    renderedHeight: entry.effectiveH,
    signed: !!entry.signed,
    isCardRow: !!entry.isCard,
    ids: [entry.id],
    members: [entry],
  };
}

function canShareRow(group, entry) {
  if (!group || entry.top >= group.refBottom) return false;
  // Cards intentionally equalise across horizontally-adjacent columns. Plain
  // auto-height blocks are independent lanes unless their rectangles overlap.
  if (group.isCardRow || entry.isCard) {
    return group.isCardRow && !!entry.isCard;
  }
  return horizontalReflowOverlap(group, entry);
}

export function buildReflowRowGroups(entries) {
  const sorted = [...(entries || [])]
    .filter((entry) => (
      entry &&
      Number.isFinite(entry.top) &&
      Number.isFinite(entry.bottom) &&
      Number.isFinite(entry.refBottom) &&
      Number.isFinite(entry.effectiveH)
    ))
    .sort((a, b) => a.top - b.top);
  const groups = [];

  for (const entry of sorted) {
    // Find the latest compatible open row. Looking across existing rows avoids
    // an unrelated right-column block preventing a later left-column block from
    // joining the correct spatial lane.
    let group = null;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (canShareRow(groups[index], entry)) {
        group = groups[index];
        break;
      }
    }
    if (!group) {
      groups.push(createRow(entry));
      continue;
    }

    group.top = Math.min(group.top, entry.top);
    group.bottom = Math.max(group.bottom, entry.bottom);
    group.refBottom = Math.max(group.refBottom, entry.refBottom);
    group.left = numericBound(group.left) && numericBound(entry.left)
      ? Math.min(group.left, entry.left)
      : group.left;
    group.right = numericBound(group.right) && numericBound(entry.right)
      ? Math.max(group.right, entry.right)
      : group.right;
    group.fullWidth = group.fullWidth || !!entry.fullWidth;
    group.renderedHeight = Math.max(group.renderedHeight, entry.effectiveH);
    group.signed = group.signed && !!entry.signed;
    group.ids.push(entry.id);
    group.members.push(entry);
  }

  for (const group of groups) {
    const delta = (group.top + group.renderedHeight) - group.refBottom;
    group.growth = group.signed ? delta : Math.max(0, delta);
  }
  return groups;
}

function sourceFromMember(group, member) {
  const hasSpatialMember = (
    Number.isFinite(member?.top) &&
    Number.isFinite(member?.refBottom) &&
    Number.isFinite(member?.effectiveH)
  );
  if (!hasSpatialMember) {
    return {
      id: member?.id,
      top: group.top,
      bottom: group.bottom,
      refBottom: group.refBottom,
      left: group.left,
      right: group.right,
      fullWidth: group.fullWidth,
      growth: group.growth,
      signed: group.signed,
    };
  }

  if (member.isCard) {
    return {
      ...member,
      top: group.top,
      refBottom: group.refBottom,
      growth: group.growth,
      signed: false,
    };
  }

  const delta = (member.top + member.effectiveH) - member.refBottom;
  return {
    ...member,
    growth: group.signed ? delta : Math.max(0, delta),
    signed: group.signed,
  };
}

function reflowSources(rowGroups) {
  const sources = [];
  for (const group of rowGroups || []) {
    const members = Array.isArray(group.members) && group.members.length
      ? group.members
      : [null];
    // A signed row keeps its historical row-level delta. Aspect carousels are
    // normally full-width and must retain deterministic grow-and-shrink.
    if (group.signed) {
      sources.push({
        id: group.ids?.join('|'),
        top: group.top,
        bottom: group.bottom,
        refBottom: group.refBottom,
        left: group.left,
        right: group.right,
        fullWidth: group.fullWidth,
        growth: group.growth,
        signed: true,
      });
      continue;
    }
    for (const member of members) sources.push(sourceFromMember(group, member));
  }
  return sources;
}

function positivePathGrowth(sources, targetGeom) {
  const paths = [];
  let targetGrowth = 0;
  const targetY = numericBound(targetGeom?.y) ? targetGeom.y : 0;
  const sorted = [...sources]
    .filter((source) => !source.signed && Number.isFinite(source.growth))
    .sort((a, b) => a.refBottom - b.refBottom || a.top - b.top);

  for (const source of sorted) {
    let upstream = 0;
    for (const path of paths) {
      if (
        path.source.refBottom <= source.top &&
        horizontalReflowOverlap(path.source, source)
      ) {
        upstream = Math.max(upstream, path.cumulative);
      }
    }
    const cumulative = upstream + Math.max(0, source.growth);
    paths.push({ source, cumulative });
    if (
      source.refBottom <= targetY &&
      horizontalReflowOverlap(source, targetGeom)
    ) {
      targetGrowth = Math.max(targetGrowth, cumulative);
    }
  }
  return targetGrowth;
}

export function offsetForTargetGeom(rowGroups, targetGeom) {
  if (!targetGeom) return 0;
  const targetY = numericBound(targetGeom.y) ? targetGeom.y : 0;
  const sources = reflowSources(rowGroups);
  let signedOffset = 0;
  for (const source of sources) {
    if (!source.signed) continue;
    if (
      source.refBottom - SIGNED_ROW_PUSH_TOLERANCE <= targetY &&
      horizontalReflowOverlap(source, targetGeom)
    ) {
      signedOffset += source.growth;
    }
  }
  return signedOffset + positivePathGrowth(sources, targetGeom);
}

export function relativeOffsetWithinContainer(rowGroups, targetGeom, containerGeom) {
  return (
    offsetForTargetGeom(rowGroups, targetGeom) -
    offsetForTargetGeom(rowGroups, containerGeom)
  );
}

export function offsetForStoredY(rowGroups, storedY) {
  return offsetForTargetGeom(rowGroups, { y: storedY });
}

export function growthForContainedGeom(rowGroups, containerGeom) {
  if (!containerGeom) return 0;
  const sources = reflowSources(rowGroups).filter((source) => containsMember(containerGeom, source));
  if (sources.length === 0) return 0;
  let signedGrowth = 0;
  for (const source of sources) {
    if (source.signed) signedGrowth += source.growth;
  }
  // An infinitely-low target captures the deepest cumulative path among the
  // contained positive-growth sources: stacked blocks add, columns take max.
  return signedGrowth + positivePathGrowth(sources, {
    ...containerGeom,
    y: Infinity,
  });
}

export function reflowMemberIsContained(containerGeom, member) {
  return containsMember(containerGeom, member);
}

/**
 * Resolve the public stage height from the bottoms blocks actually render at.
 * Ordinary rows remain grow-only; only a signed aspect-carousel row can pull
 * the stage below its stored baseline.
 */
export function computeReflowStageHeight({
  baseHeight,
  blocks,
  resolveGeom,
  rowGroups,
  editorMode = false,
  getContainerGrowth,
}) {
  const baseline = Number.isFinite(baseHeight) ? baseHeight : 0;
  if (editorMode || !Array.isArray(rowGroups) || rowGroups.length === 0) return baseline;

  const rowMemberById = new Map();
  for (const grp of rowGroups) {
    for (const member of grp.members || []) rowMemberById.set(member.id, { grp, member });
  }

  let maxBottom = 0;
  let hasVisibleBlock = false;
  for (const block of blocks || []) {
    const g = resolveGeom(block);
    if (!g || g.hidden) continue;
    hasVisibleBlock = true;

    const storedHeight = Number.isFinite(g.h) ? g.h : 0;
    let renderedHeight = storedHeight;
    const rowEntry = rowMemberById.get(block.id);
    if (rowEntry) {
      const measuredHeight = rowEntry.member.isCard
        ? rowEntry.grp.renderedHeight
        : rowEntry.member.effectiveH;
      if (Number.isFinite(measuredHeight)) {
        // Only deterministic aspect-height carousels may shrink below authored
        // geometry. Every other auto-height row keeps the public grow-only floor.
        renderedHeight = rowEntry.grp.signed
          ? measuredHeight
          : Math.max(storedHeight, measuredHeight);
      }
    }

    const storedY = Number.isFinite(g.y) ? g.y : 0;
    const offset = offsetForTargetGeom(rowGroups, {
      ...g,
      fullWidth: blockIsFullWidthLike(block),
    });
    const isContainer = block.type === BLOCK_TYPES.SECTION || block.type === BLOCK_TYPES.BOX;
    const containerGrowth = isContainer && typeof getContainerGrowth === 'function'
      ? getContainerGrowth(block, g)
      : 0;
    maxBottom = Math.max(
      maxBottom,
      storedY + renderedHeight + offset + (Number.isFinite(containerGrowth) ? containerGrowth : 0),
    );
  }

  if (!hasVisibleBlock) return baseline;
  if (maxBottom >= baseline) return maxBottom;

  const hasSignedShrink = rowGroups.some((grp) => grp.signed && grp.growth < 0);
  return hasSignedShrink ? Math.max(0, maxBottom) : baseline;
}
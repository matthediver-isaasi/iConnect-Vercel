import { BLOCK_TYPES } from '../../lib/canvasDesign';

// Slack used by aspect-height carousels when deciding whether a block authored
// flush beneath the visible carousel should follow its signed grow/shrink.
export const SIGNED_ROW_PUSH_TOLERANCE = 12;

export function offsetForStoredY(rowGroups, storedY) {
  let offset = 0;
  for (const grp of rowGroups) {
    const slack = grp.signed ? SIGNED_ROW_PUSH_TOLERANCE : 0;
    if (grp.refBottom - slack <= storedY) offset += grp.growth;
  }
  return offset;
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
    const offset = offsetForStoredY(rowGroups, storedY);
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
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

function containsMember(
  containerGeom,
  member,
  { allowBottomOverflow = false } = {},
) {
  if (!containerGeom || !member) return false;
  const containerTop = Number.isFinite(containerGeom.y) ? containerGeom.y : 0;
  const containerBottom = containerTop + (Number.isFinite(containerGeom.h) ? containerGeom.h : 0);
  const memberTop = Number.isFinite(member.top) ? member.top : 0;
  const memberBottom = Number.isFinite(member.bottom)
    ? member.bottom
    : memberTop;
  // Section content is authored as independent absolute blocks. Auto-height
  // text can therefore begin inside the Section while its stored or measured
  // box crosses the authored bottom edge. Its top anchor still establishes
  // visual ownership. Boxes and nested Sections keep strict full-rectangle
  // containment so overlapping peer backgrounds cannot become parents.
  if (
    memberTop < containerTop ||
    (allowBottomOverflow
      ? memberTop >= containerBottom
      : memberBottom > containerBottom)
  ) return false;

  const containerBounds = horizontalBounds({
    ...containerGeom,
    // Like the member below, containment follows the resolved stored rectangle.
    // fullWidth/fullBleed only changes rendering and collision reach; it must not
    // attach blocks that are geometrically beside a Section or Box.
    fullWidth: false,
  });
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

function rowMembersById(rowGroups) {
  const members = new Map();
  for (const group of rowGroups || []) {
    for (const member of group.members || []) {
      if (member?.id) members.set(member.id, { group, member });
    }
  }
  return members;
}

function spatialTarget(target) {
  if (!target) return null;
  const top = Number.isFinite(target.top)
    ? target.top
    : (Number.isFinite(target.y) ? target.y : 0);
  const left = Number.isFinite(target.left) ? target.left : target.x;
  const right = Number.isFinite(target.right)
    ? target.right
    : (
      Number.isFinite(target.x) && Number.isFinite(target.w)
        ? target.x + Math.max(0, target.w)
        : undefined
    );
  const bottom = Number.isFinite(target.bottom)
    ? target.bottom
    : top + (Number.isFinite(target.h) ? target.h : 0);
  return {
    ...target,
    x: Number.isFinite(target.x) ? target.x : left,
    y: Number.isFinite(target.y) ? target.y : top,
    w: Number.isFinite(target.w)
      ? target.w
      : (
        Number.isFinite(left) && Number.isFinite(right)
          ? Math.max(0, right - left)
          : 0
      ),
    h: Number.isFinite(target.h) ? target.h : Math.max(0, bottom - top),
    top,
    bottom,
    left,
    right,
  };
}

function rowMemberTargets(rowGroups) {
  const targets = [];
  for (const group of rowGroups || []) {
    const members = Array.isArray(group.members) && group.members.length
      ? group.members
      : [{ id: group.ids?.[0] }];
    for (const member of members) {
      targets.push(spatialTarget({
        id: member?.id,
        top: Number.isFinite(member?.top) ? member.top : group.top,
        bottom: Number.isFinite(member?.bottom) ? member.bottom : group.bottom,
        left: Number.isFinite(member?.left) ? member.left : group.left,
        right: Number.isFinite(member?.right) ? member.right : group.right,
        fullWidth: member?.fullWidth ?? group.fullWidth,
      }));
    }
  }
  return targets;
}

function liveTargetHeight(target, membersById) {
  const storedHeight = Number.isFinite(target?.h) ? target.h : 0;
  const rowEntry = membersById.get(target?.id);
  if (!rowEntry) return storedHeight;
  const measuredHeight = rowEntry.member.isCard
    ? rowEntry.group.renderedHeight
    : rowEntry.member.effectiveH;
  return Number.isFinite(measuredHeight) ? measuredHeight : storedHeight;
}

function signedBaseOffset(sources, targetGeom, targetY) {
  let offset = 0;
  for (const source of sources) {
    if (!source.signed) continue;
    if (
      source.refBottom - SIGNED_ROW_PUSH_TOLERANCE <= targetY &&
      horizontalReflowOverlap(source, targetGeom)
    ) {
      offset += source.growth;
    }
  }
  return offset;
}

function collisionOffset(paths, targetGeom, targetY, preliminaryY) {
  let offset = 0;
  for (const path of paths) {
    if (
      path.source.refBottom <= targetY &&
      horizontalReflowOverlap(path.source, targetGeom)
    ) {
      offset = Math.max(offset, Math.max(0, path.visibleBottom - preliminaryY));
    }
  }
  return offset;
}

/**
 * Resolve every auto-height source's final visible bottom after signed
 * carousel movement and collisions from earlier sources in the same lane.
 *
 * Ordinary growth consumes authored gaps before it becomes displacement.
 * Signed rows keep their historical grow/shrink base offset, but can also be
 * moved by a real upstream collision. Their resulting visible bottom then
 * participates in later collisions, preventing a following block from being
 * pulled through a carousel that an accordion already moved.
 */
function relaySource(target) {
  const spatial = spatialTarget(target);
  if (!spatial) return null;
  return {
    id: spatial.id,
    top: spatial.top,
    bottom: spatial.bottom,
    refBottom: spatial.bottom,
    left: spatial.left,
    right: spatial.right,
    fullWidth: spatial.fullWidth,
    growth: 0,
    signed: false,
  };
}

function inheritedOffsetFor(inheritedOffsets, id) {
  if (!id || !inheritedOffsets || typeof inheritedOffsets.get !== 'function') return 0;
  const offset = inheritedOffsets.get(id);
  return Number.isFinite(offset) ? offset : 0;
}

function combineInheritedOffset(localOffset, inheritedOffset) {
  if (!Number.isFinite(inheritedOffset) || inheritedOffset === 0) return localOffset;
  if (!Number.isFinite(localOffset) || localOffset === 0) return inheritedOffset;
  if (localOffset > 0 && inheritedOffset > 0) {
    return Math.max(localOffset, inheritedOffset);
  }
  if (localOffset < 0 && inheritedOffset < 0) {
    return Math.min(localOffset, inheritedOffset);
  }
  // Opposing signed movement and container movement are independent effects.
  return localOffset + inheritedOffset;
}

function reflowPaths(sources, relayTargets, inheritedOffsets) {
  const paths = [];
  const sourceIds = new Set(sources.map((source) => source.id).filter(Boolean));
  const relays = (relayTargets || [])
    .map(relaySource)
    .filter((source) => source && (!source.id || !sourceIds.has(source.id)));
  const sorted = [...sources, ...relays]
    .filter((source) => Number.isFinite(source.growth))
    .sort((a, b) => a.top - b.top || a.refBottom - b.refBottom);

  for (const source of sorted) {
    const baseOffset = signedBaseOffset(sources, source, source.top);
    const inheritedOffset = inheritedOffsetFor(inheritedOffsets, source.id);
    const preliminaryOffset = combineInheritedOffset(baseOffset, inheritedOffset);
    const preliminaryTop = source.top + preliminaryOffset;
    const collision = collisionOffset(paths, source, source.top, preliminaryTop);
    paths.push({
      source,
      visibleBottom: source.refBottom + preliminaryOffset + collision + source.growth,
    });
  }
  return paths;
}

export function offsetForTargetGeom(
  rowGroups,
  targetGeom,
  relayTargets,
  inheritedOffsets,
) {
  if (!targetGeom) return 0;
  const targetY = numericBound(targetGeom.y) ? targetGeom.y : 0;
  const sources = reflowSources(rowGroups);
  const baseOffset = signedBaseOffset(sources, targetGeom, targetY);
  const inheritedOffset = inheritedOffsetFor(inheritedOffsets, targetGeom.id);
  const preliminaryOffset = combineInheritedOffset(baseOffset, inheritedOffset);
  const preliminaryY = targetY + preliminaryOffset;
  return (
    preliminaryOffset +
    collisionOffset(
      reflowPaths(sources, relayTargets, inheritedOffsets),
      targetGeom,
      targetY,
      preliminaryY,
    )
  );
}

function sameStoredRect(a, b) {
  if (!a || !b) return false;
  return (
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.right === b.right
  );
}

function targetArea(target) {
  const width = Number.isFinite(target?.w)
    ? Math.max(0, target.w)
    : Math.max(0, (target?.right || 0) - (target?.left || 0));
  const height = Number.isFinite(target?.h)
    ? Math.max(0, target.h)
    : Math.max(0, (target?.bottom || 0) - (target?.top || 0));
  return width * height;
}

function containerOwnerMap(targets, containerTargets) {
  const owners = new Map();
  const containerIds = new Set(
    containerTargets.map((container) => container.id).filter(Boolean),
  );

  for (const target of targets) {
    if (!target?.id) continue;
    const targetIsContainer = containerIds.has(target.id);
    const candidates = containerTargets
      .filter((container) => {
        if (!container?.id || container.id === target.id) return false;
        const containerIsBox = (
          container.containerType === BLOCK_TYPES.BOX ||
          container.type === BLOCK_TYPES.BOX
        );
        if (!containsMember(container, target, {
          allowBottomOverflow: (
            !containerIsBox &&
            !targetIsContainer &&
            target.allowSectionBottomOverflow === true
          ),
        })) return false;
        // Equal-sized overlapping container backgrounds are peers, not a
        // parent/child pair. Treating them as owners would create a cycle.
        return !targetIsContainer || !sameStoredRect(container, target);
      })
      .sort((a, b) => (
        targetArea(a) - targetArea(b) ||
        b.top - a.top ||
        String(a.id).localeCompare(String(b.id))
      ));
    if (candidates.length > 0) owners.set(target.id, candidates[0].id);
  }
  return owners;
}

function sameOffsetMaps(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) {
    if (b.get(id) !== value) return false;
  }
  return true;
}

/**
 * Resolve the effective public offset for every block while keeping geometric
 * Section and Box contents attached to their background. Containers remain
 * root-level absolute blocks, so ownership is inferred from active-breakpoint
 * bounds.
 *
 * A child inherits its owning container's absolute displacement as a starting
 * position. Section ownership permits explicitly eligible auto-height content
 * to cross the Section bottom; Box ownership always requires strict
 * full-rectangle containment. A child's own collision can still move it
 * farther; inherited movement is never added twice. Reflow paths are rebuilt
 * with those inherited positions so moved content relays collisions from the
 * same bottom that is actually drawn.
 */
export function resolveSectionAwareOffsets({
  rowGroups,
  targets,
  sectionTargets,
  containerTargets,
  relayTargets,
}) {
  const spatialTargets = (targets || []).map(spatialTarget).filter(Boolean);
  // `sectionTargets` remains supported for existing pure callers. The public
  // provider supplies the generalized list containing Sections and Boxes.
  const suppliedContainers = Array.isArray(containerTargets)
    ? containerTargets
    : (sectionTargets || []);
  const spatialContainers = suppliedContainers.map(spatialTarget).filter(Boolean);
  const owners = containerOwnerMap(spatialTargets, spatialContainers);
  const targetById = new Map(
    spatialTargets.filter((target) => target.id).map((target) => [target.id, target]),
  );
  const containerById = new Map(
    spatialContainers
      .filter((container) => container.id)
      .map((container) => [container.id, container]),
  );
  let inheritedOffsets = new Map();

  // Each pass can carry a moved source through one more container boundary. A
  // strict containment chain cannot be deeper than the number of containers.
  const maxPasses = Math.max(1, spatialContainers.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const containerOffsets = new Map();
    for (const container of spatialContainers) {
      if (!container.id) continue;
      containerOffsets.set(
        container.id,
        offsetForTargetGeom(rowGroups, container, relayTargets, inheritedOffsets),
      );
    }

    const nextInheritedOffsets = new Map();
    for (const target of spatialTargets) {
      const ownerId = owners.get(target.id);
      if (!ownerId) continue;
      const ownerOffset = containerOffsets.get(ownerId);
      if (Number.isFinite(ownerOffset) && ownerOffset !== 0) {
        nextInheritedOffsets.set(target.id, ownerOffset);
      }
    }
    if (sameOffsetMaps(inheritedOffsets, nextInheritedOffsets)) break;
    inheritedOffsets = nextInheritedOffsets;
  }

  const offsets = new Map();
  for (const [id, target] of targetById) {
    offsets.set(
      id,
      offsetForTargetGeom(rowGroups, target, relayTargets, inheritedOffsets),
    );
  }

  // Keep containers available even if a caller supplied them separately from
  // the general target list.
  for (const [id, container] of containerById) {
    if (offsets.has(id)) continue;
    offsets.set(
      id,
      offsetForTargetGeom(rowGroups, container, relayTargets, inheritedOffsets),
    );
  }

  return { offsets, inheritedOffsets, owners };
}

export function relativeOffsetWithinContainer(
  rowGroups,
  targetGeom,
  containerGeom,
  relayTargets,
  inheritedOffsets,
) {
  return (
    offsetForTargetGeom(rowGroups, targetGeom, relayTargets, inheritedOffsets) -
    offsetForTargetGeom(rowGroups, containerGeom, relayTargets, inheritedOffsets)
  );
}

export function offsetForStoredY(rowGroups, storedY, relayTargets, inheritedOffsets) {
  return offsetForTargetGeom(rowGroups, { y: storedY }, relayTargets, inheritedOffsets);
}

export function growthForContainedGeom(
  rowGroups,
  containerGeom,
  containedTargets,
  {
    growOnly = false,
    relayTargets = containedTargets,
    inheritedOffsets,
    allowBottomOverflow = false,
  } = {},
) {
  if (!containerGeom) return 0;
  const allSources = reflowSources(rowGroups);
  const sources = allSources.filter((source) => containsMember(containerGeom, source, {
    allowBottomOverflow: (
      allowBottomOverflow &&
      source.allowSectionBottomOverflow === true
    ),
  }));
  if (sources.length === 0) return 0;
  let signedGrowth = 0;
  for (const source of sources) {
    if (source.signed) signedGrowth += source.growth;
  }
  const membersById = rowMembersById(rowGroups);
  const targets = Array.isArray(containedTargets)
    ? containedTargets.map(spatialTarget).filter(Boolean)
    : rowMemberTargets(rowGroups);
  const containerOffset = offsetForTargetGeom(
    rowGroups,
    containerGeom,
    relayTargets,
    inheritedOffsets,
  );
  const containerTop = Number.isFinite(containerGeom.y) ? containerGeom.y : 0;
  const containerHeight = Number.isFinite(containerGeom.h) ? containerGeom.h : 0;
  const renderedContainerBottom = (
    containerTop +
    containerHeight +
    containerOffset +
    signedGrowth
  );
  let overflow = 0;

  for (const target of targets) {
    if (!containsMember(containerGeom, target, {
      allowBottomOverflow: (
        allowBottomOverflow &&
        target.allowSectionBottomOverflow === true
      ),
    })) continue;
    const renderedBottom = (
      target.y +
      liveTargetHeight(target, membersById) +
      offsetForTargetGeom(rowGroups, target, relayTargets, inheritedOffsets)
    );
    overflow = Math.max(overflow, renderedBottom - renderedContainerBottom);
  }

  // Keep the signed carousel exception intact for Sections, then extend that
  // adjusted boundary only when a contained block's final visible bottom
  // crosses it. Decorative Boxes remain public grow-only so their runtime
  // geometry never drops below what the author sees in the editor.
  const growth = signedGrowth + Math.max(0, overflow);
  return growOnly ? Math.max(0, growth) : growth;
}

export function reflowMemberIsContained(
  containerGeom,
  member,
  { allowBottomOverflow = false } = {},
) {
  return containsMember(containerGeom, member, { allowBottomOverflow });
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
  relayTargets,
  inheritedOffsets,
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
        // Stage growth follows the live visible bottom. The baseline guard below
        // still prevents ordinary measured shrink from shortening the authored
        // stage; only signed aspect rows may do that.
        renderedHeight = measuredHeight;
      }
    }

    const storedY = Number.isFinite(g.y) ? g.y : 0;
    const offset = offsetForTargetGeom(rowGroups, {
      ...g,
      id: block.id,
      fullWidth: blockIsFullWidthLike(block),
    }, relayTargets, inheritedOffsets);
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
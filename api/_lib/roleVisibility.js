import { MODULE_IDS, PAGE_IDS, FEATURE_TO_PAGE, RESOURCE_TO_MODULE, LEGACY_TO_NEW_MAPPING } from './roleAccessHierarchy.generated.js';
import { supabase as defaultSupabase } from './database.js';

// Task #3349: the legacy-id mapping used to be a hand-maintained copy of the
// client's LEGACY_TO_NEW_MAPPING and had drifted (58 missing entries, e.g.
// page_PendingPurchaseOrdersReport) — it is now imported from the generated
// file so client and server aliasing can never diverge again.

function migrateLegacyFeatureId(legacyId) {
  return LEGACY_TO_NEW_MAPPING[legacyId] || legacyId;
}

// Map-driven parent resolution derived from the client ROLE_ACCESS_MAP
// nesting (generated file — see scripts/generate-role-access-hierarchy.mjs).
// Several ids are nested under parents that do not match their dot-prefix
// (e.g. "admin.canvas-links-manager" under module "site-builder",
// "dashboard.view" under module "system"), so prefix splitting is only a
// fallback for ids not present in the map.
const MODULE_ID_SET = new Set(MODULE_IDS);
const PAGE_ID_SET = new Set(PAGE_IDS);

function getModuleForResource(resourceId) {
  if (MODULE_ID_SET.has(resourceId)) return resourceId;
  const fromMap = RESOURCE_TO_MODULE[resourceId];
  if (fromMap) return fromMap;
  const parts = resourceId.split('.');
  if (parts.length > 0) {
    return parts[0];
  }
  return null;
}

function getPageForResource(resourceId) {
  if (PAGE_ID_SET.has(resourceId)) return resourceId;
  const fromMap = FEATURE_TO_PAGE[resourceId];
  if (fromMap) return fromMap;
  if (MODULE_ID_SET.has(resourceId)) return null;
  const parts = resourceId.split('.');
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task #3349: DB-aware hierarchy overlay.
//
// Role Management's Access Control tree is driven by the role_access_item DB
// table, whose module/page placement can differ from the generated hierarchy
// above (e.g. "events.discount-codes" placed under the "commerce" module).
// Enforcement must match exclusions against the tree AS DISPLAYED, or
// unticking an item in Role Management is a silently dead toggle.
//
// The overlay is loaded once at module init (bounded by a short timeout so a
// slow DB can never block cold starts) and refreshed in the background on a
// short TTL. Matching is a UNION with the hardcoded hierarchy: the overlay
// can only ADD matches, never remove them, so no role gains access if the
// overlay is missing/stale (fail-safe). Empty role_access_item => hardcoded
// behavior, unchanged.

const OVERLAY_TTL_MS = 60_000;
let dbOverlay = null; // { moduleIds:Set, pageIds:Set, featureToPage:Map, resourceToModule:Map } | null
let overlayFetchedAt = 0;
let overlayInFlight = null;

export function buildRoleAccessOverlay(rows) {
  const active = (rows || []).filter((r) => r && r.item_key && r.is_active !== false);
  if (active.length === 0) return null;
  const byId = new Map(active.map((r) => [r.id, r]));
  // Alias legacy keys (page_* etc.) to canonical ids so exclusions stored
  // under either representation match rows keyed under either.
  const norm = (k) => migrateLegacyFeatureId(k);
  const moduleIds = new Set();
  const pageIds = new Set();
  const featureToPage = new Map();
  const resourceToModule = new Map();
  for (const r of active) {
    if (r.item_type === 'module') moduleIds.add(norm(r.item_key));
  }
  for (const r of active) {
    if (r.item_type !== 'page') continue;
    const key = norm(r.item_key);
    pageIds.add(key);
    const parent = r.parent_id ? byId.get(r.parent_id) : null;
    if (parent && parent.item_type === 'module') {
      resourceToModule.set(key, norm(parent.item_key));
    }
  }
  for (const r of active) {
    if (r.item_type !== 'feature') continue;
    const key = norm(r.item_key);
    const page = r.parent_id ? byId.get(r.parent_id) : null;
    if (page && page.item_type === 'page') {
      featureToPage.set(key, norm(page.item_key));
      const mod = page.parent_id ? byId.get(page.parent_id) : null;
      if (mod && mod.item_type === 'module') {
        resourceToModule.set(key, norm(mod.item_key));
      }
    }
  }
  return { moduleIds, pageIds, featureToPage, resourceToModule };
}

export async function refreshRoleAccessOverlay(client = defaultSupabase) {
  if (!client) return dbOverlay;
  if (overlayInFlight) return overlayInFlight;
  overlayInFlight = (async () => {
    try {
      const { data, error } = await client
        .from('role_access_item')
        .select('id,item_type,item_key,parent_id,is_active');
      if (error) throw error;
      dbOverlay = buildRoleAccessOverlay(data);
      overlayFetchedAt = Date.now();
    } catch (err) {
      // Fail open to the hardcoded hierarchy (union semantics mean this can
      // only under-match DB-placement exclusions, never widen legacy ones).
      // Back off briefly so a broken DB doesn't get hammered per call.
      console.error('[roleVisibility] failed to load role_access_item overlay:', err?.message || err);
      overlayFetchedAt = Date.now() - OVERLAY_TTL_MS + 10_000;
    } finally {
      overlayInFlight = null;
    }
    return dbOverlay;
  })();
  return overlayInFlight;
}

function maybeRefreshOverlayInBackground() {
  if (!defaultSupabase) return;
  if (Date.now() - overlayFetchedAt <= OVERLAY_TTL_MS) return;
  refreshRoleAccessOverlay().catch(() => {});
}

/** Test hook: install a fixed overlay and disable background refreshes. */
export function __setRoleAccessOverlayForTests(rows) {
  dbOverlay = buildRoleAccessOverlay(rows);
  overlayFetchedAt = Number.MAX_SAFE_INTEGER;
}

function overlayParentMatch(normalizedId, normalizedExcluded) {
  if (!dbOverlay) return false;
  const pageId = dbOverlay.featureToPage.get(normalizedId);
  if (pageId && normalizedExcluded.includes(pageId)) return true;
  const moduleId = dbOverlay.resourceToModule.get(normalizedId);
  if (moduleId && normalizedExcluded.includes(moduleId)) return true;
  return false;
}

// Prime the overlay at module init so even cold starts enforce DB placement,
// but never let a slow DB delay a function beyond the race timeout.
if (defaultSupabase && !process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME) {
  await Promise.race([
    refreshRoleAccessOverlay().catch(() => {}),
    new Promise((resolve) => {
      const t = setTimeout(resolve, 2500);
      if (typeof t?.unref === 'function') t.unref();
    }),
  ]);
}

export function isResourceExcluded(excludedResources, resourceId) {
  if (!excludedResources || !Array.isArray(excludedResources) || excludedResources.length === 0) {
    return false;
  }

  maybeRefreshOverlayInBackground();

  // Normalize the input resourceId
  const normalizedId = migrateLegacyFeatureId(resourceId);
  
  // Normalize all excluded resources to ensure legacy IDs are converted
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  // Check if the resource itself is excluded
  if (normalizedExcluded.includes(normalizedId)) {
    return true;
  }

  // Check if the parent page is excluded (makes all child features excluded)
  const pageId = getPageForResource(normalizedId);
  if (pageId && normalizedExcluded.includes(pageId)) {
    return true;
  }

  // Check if the parent module is excluded (makes all pages and features excluded)
  const moduleId = getModuleForResource(normalizedId);
  if (moduleId && normalizedExcluded.includes(moduleId)) {
    return true;
  }

  // DB-tree overlay match (Task #3349): parents as placed in role_access_item.
  if (overlayParentMatch(normalizedId, normalizedExcluded)) {
    return true;
  }

  return false;
}

export function isResourceVisible(excludedResources, resourceId) {
  return !isResourceExcluded(excludedResources, resourceId);
}

import { Module, ROLE_ACCESS_MAP, getModuleForResource, getPageForResource, isModuleId, isPageId, migrateLegacyFeatureId } from './roleAccessMap';

// All helpers below accept an optional `accessMap`. When Role Management (or
// any other caller) renders its tree from the role_access_item DB table, the
// SAME map must be passed here so that read/write parent-child resolution
// agrees with what the user sees. Omitting it falls back to the hardcoded
// ROLE_ACCESS_MAP (identical behavior to before).

// ---------------------------------------------------------------------------
// Task #3349: DB-aware hierarchy overlay.
//
// Role Management's Access Control tree is driven by the role_access_item DB
// table, whose module/page placement can differ from the hardcoded
// ROLE_ACCESS_MAP (e.g. a tenant placing "events.discount-codes" under the
// "commerce" module). Enforcement (Layout nav filtering, useMemberAccess)
// must match exclusions against the tree AS DISPLAYED, or unticking an item
// becomes a silently dead toggle.
//
// The overlay is a module-level singleton set once by Layout after fetching
// the RoleAccessItem rows. Matching is a UNION: an exclusion matches if it
// matches via the hardcoded map OR via the DB tree, so no role ever silently
// GAINS access when the overlay loads (fail-safe: overlay only adds matches).
// Tenants with an empty role_access_item table keep hardcoded-map behavior.

export interface RoleAccessItemRow {
  id: string;
  item_type: string;
  item_key: string;
  parent_id?: string | null;
  is_active?: boolean | null;
}

interface OverlayHierarchy {
  moduleIds: Set<string>;
  pageIds: Set<string>;
  featureToPage: Map<string, string>;
  resourceToModule: Map<string, string>;
}

export function buildOverlayHierarchy(rows: RoleAccessItemRow[] | null | undefined): OverlayHierarchy | null {
  const active = (rows || []).filter(r => r && r.item_key && r.is_active !== false);
  if (active.length === 0) return null;
  const byId = new Map(active.map(r => [r.id, r]));
  // Alias legacy keys (page_* etc.) to canonical ids so exclusions stored
  // under either representation match rows keyed under either.
  const norm = (k: string) => migrateLegacyFeatureId(k);
  const moduleIds = new Set<string>();
  const pageIds = new Set<string>();
  const featureToPage = new Map<string, string>();
  const resourceToModule = new Map<string, string>();
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

let dbOverlay: OverlayHierarchy | null = null;

/** Install (or clear, with null/[]) the DB-tree overlay used by isResourceExcluded. */
export function setDbRoleAccessOverlay(rows: RoleAccessItemRow[] | null | undefined): void {
  dbOverlay = buildOverlayHierarchy(rows);
}

export function getDbRoleAccessOverlay(): OverlayHierarchy | null {
  return dbOverlay;
}

function overlayParentMatch(normalizedId: string, normalizedExcluded: string[]): boolean {
  if (!dbOverlay) return false;
  // Parent page (for features) as placed in the DB tree
  const pageId = dbOverlay.featureToPage.get(normalizedId);
  if (pageId && normalizedExcluded.includes(pageId)) return true;
  // Parent module (for pages and features) as placed in the DB tree
  const moduleId = dbOverlay.resourceToModule.get(normalizedId);
  if (moduleId && normalizedExcluded.includes(moduleId)) return true;
  return false;
}

export function isResourceExcluded(
  excludedResources: string[] | null | undefined,
  resourceId: string,
  accessMap?: Module[]
): boolean {
  if (!excludedResources || !Array.isArray(excludedResources) || excludedResources.length === 0) {
    return false;
  }

  // Normalize the input resourceId
  const normalizedId = migrateLegacyFeatureId(resourceId);
  
  // Normalize all excluded resources to ensure legacy IDs are converted
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  // Check if the resource itself is excluded
  if (normalizedExcluded.includes(normalizedId)) {
    return true;
  }

  // Check if the parent page is excluded (makes all child features excluded)
  const pageId = getPageForResource(normalizedId, accessMap);
  if (pageId && normalizedExcluded.includes(pageId)) {
    return true;
  }

  // Check if the parent module is excluded (makes all pages and features excluded)
  const moduleId = getModuleForResource(normalizedId, accessMap);
  if (moduleId && normalizedExcluded.includes(moduleId)) {
    return true;
  }

  // Fail-safe union (Task #3349): when a caller passes a DB-derived accessMap,
  // ALSO check parents from the hardcoded map so exclusions stored under the
  // old canonical placement keep matching (no access widening).
  if (accessMap) {
    const defaultPageId = getPageForResource(normalizedId);
    if (defaultPageId && normalizedExcluded.includes(defaultPageId)) {
      return true;
    }
    const defaultModuleId = getModuleForResource(normalizedId);
    if (defaultModuleId && normalizedExcluded.includes(defaultModuleId)) {
      return true;
    }
  }

  // DB-tree overlay match (Task #3349): parents as placed in role_access_item.
  if (overlayParentMatch(normalizedId, normalizedExcluded)) {
    return true;
  }

  return false;
}

export function isResourceVisible(
  excludedResources: string[] | null | undefined,
  resourceId: string,
  accessMap?: Module[]
): boolean {
  return !isResourceExcluded(excludedResources, resourceId, accessMap);
}

export function getExcludedChildrenCount(
  excludedResources: string[] | null | undefined,
  parentId: string,
  accessMap: Module[] = ROLE_ACCESS_MAP
): { excluded: number; total: number } {
  if (!excludedResources) excludedResources = [];
  
  let excluded = 0;
  let total = 0;

  if (isModuleId(parentId, accessMap)) {
    const module = accessMap.find(m => m.id === parentId);
    if (module) {
      for (const page of module.pages) {
        total++;
        if (isResourceExcluded(excludedResources, page.id, accessMap)) {
          excluded++;
        }
        if (page.features) {
          for (const feature of page.features) {
            total++;
            if (isResourceExcluded(excludedResources, feature.id, accessMap)) {
              excluded++;
            }
          }
        }
      }
    }
  } else if (isPageId(parentId, accessMap)) {
    for (const module of accessMap) {
      const page = module.pages.find(p => p.id === parentId);
      if (page && page.features) {
        for (const feature of page.features) {
          total++;
          if (isResourceExcluded(excludedResources, feature.id, accessMap)) {
            excluded++;
          }
        }
      }
    }
  }

  return { excluded, total };
}

export function toggleResourceExclusion(
  excludedResources: string[],
  resourceId: string,
  exclude: boolean,
  accessMap: Module[] = ROLE_ACCESS_MAP
): string[] {
  // CRITICAL: First normalize all existing exclusions to new format
  // This converts legacy IDs like "page_user_Preferences" to "user.about-me"
  // so that toggle operations work correctly on the canonical ID format
  const normalizedExcluded = new Set(excludedResources.map(id => migrateLegacyFeatureId(id)));
  
  // Ensure resourceId is also normalized
  const normalizedResourceId = migrateLegacyFeatureId(resourceId);

  if (exclude) {
    normalizedExcluded.add(normalizedResourceId);
    
    if (isModuleId(normalizedResourceId, accessMap)) {
      const module = accessMap.find(m => m.id === normalizedResourceId);
      if (module) {
        for (const page of module.pages) {
          normalizedExcluded.delete(page.id);
          if (page.features) {
            for (const feature of page.features) {
              normalizedExcluded.delete(feature.id);
            }
          }
        }
      }
    } else if (isPageId(normalizedResourceId, accessMap)) {
      const moduleId = getModuleForResource(normalizedResourceId, accessMap);
      if (moduleId) {
        const module = accessMap.find(m => m.id === moduleId);
        if (module) {
          const page = module.pages.find(p => p.id === normalizedResourceId);
          if (page && page.features) {
            for (const feature of page.features) {
              normalizedExcluded.delete(feature.id);
            }
          }
        }
      }
    }
  } else {
    normalizedExcluded.delete(normalizedResourceId);
    
    const moduleId = getModuleForResource(normalizedResourceId, accessMap);
    
    // When enabling a module, also clear all page and feature exclusions within it
    if (isModuleId(normalizedResourceId, accessMap)) {
      const module = accessMap.find(m => m.id === normalizedResourceId);
      if (module) {
        for (const page of module.pages) {
          normalizedExcluded.delete(page.id);
          if (page.features) {
            for (const feature of page.features) {
              normalizedExcluded.delete(feature.id);
            }
          }
        }
      }
    }
    
    // When enabling a page, also clear all feature exclusions within it
    if (isPageId(normalizedResourceId, accessMap)) {
      const module = accessMap.find(m => m.id === moduleId);
      if (module) {
        const page = module.pages.find(p => p.id === normalizedResourceId);
        if (page && page.features) {
          for (const feature of page.features) {
            normalizedExcluded.delete(feature.id);
          }
        }
      }
    }
    
    // When enabling a page that was blocked by module exclusion,
    // remove the module exclusion and add all OTHER pages to maintain block
    if (moduleId && normalizedExcluded.has(moduleId) && isPageId(normalizedResourceId, accessMap)) {
      normalizedExcluded.delete(moduleId);
      
      const module = accessMap.find(m => m.id === moduleId);
      if (module) {
        for (const page of module.pages) {
          if (page.id !== normalizedResourceId) {
            normalizedExcluded.add(page.id);
          }
        }
      }
    }
    
    // When enabling a feature that was blocked by page exclusion,
    // remove the page exclusion and add all OTHER features to maintain block
    if (!isModuleId(normalizedResourceId, accessMap) && !isPageId(normalizedResourceId, accessMap)) {
      const pageId = getPageForResource(normalizedResourceId, accessMap);
      if (pageId && normalizedExcluded.has(pageId)) {
        normalizedExcluded.delete(pageId);
        
        const module = accessMap.find(m => m.id === moduleId);
        if (module) {
          const page = module.pages.find(p => p.id === pageId);
          if (page && page.features) {
            for (const feature of page.features) {
              if (feature.id !== normalizedResourceId) {
                normalizedExcluded.add(feature.id);
              }
            }
          }
        }
      }
    }
  }

  return Array.from(normalizedExcluded);
}

export function getModuleExclusionState(
  excludedResources: string[],
  moduleId: string,
  accessMap: Module[] = ROLE_ACCESS_MAP
): 'all' | 'some' | 'none' {
  // Normalize excluded resources with legacy mappings
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  if (normalizedExcluded.includes(moduleId)) {
    return 'all';
  }

  const module = accessMap.find(m => m.id === moduleId);
  if (!module) return 'none';

  let hasExcluded = false;
  let allExcluded = true;

  for (const page of module.pages) {
    const pageIsExcluded = normalizedExcluded.includes(page.id);
    
    if (pageIsExcluded) {
      hasExcluded = true;
      // Page is explicitly excluded - continue to next page
    } else {
      // Page is not directly excluded - check its features
      if (page.features && page.features.length > 0) {
        let excludedFeatureCount = 0;
        for (const feature of page.features) {
          if (normalizedExcluded.includes(feature.id)) {
            hasExcluded = true;
            excludedFeatureCount++;
          }
        }
        // If not ALL features are excluded, the page is not fully excluded
        if (excludedFeatureCount < page.features.length) {
          allExcluded = false;
        }
      } else {
        // Page has no features and is not excluded
        allExcluded = false;
      }
    }
  }

  if (hasExcluded && !allExcluded) return 'some';
  if (hasExcluded) return 'all';
  return 'none';
}

export function getPageExclusionState(
  excludedResources: string[],
  pageId: string,
  accessMap: Module[] = ROLE_ACCESS_MAP
): 'all' | 'some' | 'none' {
  // Normalize excluded resources with legacy mappings
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  if (normalizedExcluded.includes(pageId)) {
    return 'all';
  }

  const moduleId = getModuleForResource(pageId, accessMap);
  if (moduleId && normalizedExcluded.includes(moduleId)) {
    return 'all';
  }

  let module = null;
  let page = null;
  for (const m of accessMap) {
    const p = m.pages.find(pg => pg.id === pageId);
    if (p) {
      module = m;
      page = p;
      break;
    }
  }

  if (!page || !page.features || page.features.length === 0) {
    return 'none';
  }

  // Check if any features are excluded
  const hasExcludedFeature = page.features.some(feature => 
    normalizedExcluded.includes(feature.id)
  );

  // Return 'some' if any features are excluded
  // Only return 'all' if the page or module itself is directly excluded (checked above)
  return hasExcludedFeature ? 'some' : 'none';
}

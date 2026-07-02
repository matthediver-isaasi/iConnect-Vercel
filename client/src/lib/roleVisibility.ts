import { ROLE_ACCESS_MAP, getModuleForResource, getPageForResource, isModuleId, isPageId, migrateLegacyFeatureId } from './roleAccessMap';

export function isResourceExcluded(
  excludedResources: string[] | null | undefined,
  resourceId: string
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
  const pageId = getPageForResource(normalizedId);
  if (pageId && normalizedExcluded.includes(pageId)) {
    return true;
  }

  // Check if the parent module is excluded (makes all pages and features excluded)
  const moduleId = getModuleForResource(normalizedId);
  if (moduleId && normalizedExcluded.includes(moduleId)) {
    return true;
  }

  return false;
}

export function isResourceVisible(
  excludedResources: string[] | null | undefined,
  resourceId: string
): boolean {
  return !isResourceExcluded(excludedResources, resourceId);
}

export function getExcludedChildrenCount(
  excludedResources: string[] | null | undefined,
  parentId: string
): { excluded: number; total: number } {
  if (!excludedResources) excludedResources = [];
  
  let excluded = 0;
  let total = 0;

  if (isModuleId(parentId)) {
    const module = ROLE_ACCESS_MAP.find(m => m.id === parentId);
    if (module) {
      for (const page of module.pages) {
        total++;
        if (isResourceExcluded(excludedResources, page.id)) {
          excluded++;
        }
        if (page.features) {
          for (const feature of page.features) {
            total++;
            if (isResourceExcluded(excludedResources, feature.id)) {
              excluded++;
            }
          }
        }
      }
    }
  } else if (isPageId(parentId)) {
    for (const module of ROLE_ACCESS_MAP) {
      const page = module.pages.find(p => p.id === parentId);
      if (page && page.features) {
        for (const feature of page.features) {
          total++;
          if (isResourceExcluded(excludedResources, feature.id)) {
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
  exclude: boolean
): string[] {
  // CRITICAL: First normalize all existing exclusions to new format
  // This converts legacy IDs like "page_user_Preferences" to "user.about-me"
  // so that toggle operations work correctly on the canonical ID format
  const normalizedExcluded = new Set(excludedResources.map(id => migrateLegacyFeatureId(id)));
  
  // Ensure resourceId is also normalized
  const normalizedResourceId = migrateLegacyFeatureId(resourceId);

  if (exclude) {
    normalizedExcluded.add(normalizedResourceId);
    
    if (isModuleId(normalizedResourceId)) {
      const module = ROLE_ACCESS_MAP.find(m => m.id === normalizedResourceId);
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
    } else if (isPageId(normalizedResourceId)) {
      const moduleId = getModuleForResource(normalizedResourceId);
      if (moduleId) {
        const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
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
    
    const moduleId = getModuleForResource(normalizedResourceId);
    
    // When enabling a module, also clear all page and feature exclusions within it
    if (isModuleId(normalizedResourceId)) {
      const module = ROLE_ACCESS_MAP.find(m => m.id === normalizedResourceId);
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
    if (isPageId(normalizedResourceId)) {
      const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
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
    if (moduleId && normalizedExcluded.has(moduleId) && isPageId(normalizedResourceId)) {
      normalizedExcluded.delete(moduleId);
      
      const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
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
    if (!isModuleId(normalizedResourceId) && !isPageId(normalizedResourceId)) {
      const pageId = getPageForResource(normalizedResourceId);
      if (pageId && normalizedExcluded.has(pageId)) {
        normalizedExcluded.delete(pageId);
        
        const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
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
  moduleId: string
): 'all' | 'some' | 'none' {
  // Normalize excluded resources with legacy mappings
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  if (normalizedExcluded.includes(moduleId)) {
    return 'all';
  }

  const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
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
  pageId: string
): 'all' | 'some' | 'none' {
  // Normalize excluded resources with legacy mappings
  const normalizedExcluded = excludedResources.map(id => migrateLegacyFeatureId(id));
  
  if (normalizedExcluded.includes(pageId)) {
    return 'all';
  }

  const moduleId = getModuleForResource(pageId);
  if (moduleId && normalizedExcluded.includes(moduleId)) {
    return 'all';
  }

  let module = null;
  let page = null;
  for (const m of ROLE_ACCESS_MAP) {
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

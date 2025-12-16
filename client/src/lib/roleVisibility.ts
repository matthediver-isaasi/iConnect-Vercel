import { ROLE_ACCESS_MAP, getModuleForResource, getPageForResource, isModuleId, isPageId, migrateLegacyFeatureId } from './roleAccessMap';

export function isResourceExcluded(
  excludedResources: string[] | null | undefined,
  resourceId: string
): boolean {
  if (!excludedResources || !Array.isArray(excludedResources) || excludedResources.length === 0) {
    return false;
  }

  const normalizedId = migrateLegacyFeatureId(resourceId);
  
  if (excludedResources.includes(normalizedId)) {
    return true;
  }

  const pageId = getPageForResource(normalizedId);
  if (pageId && excludedResources.includes(pageId)) {
    return true;
  }

  const moduleId = getModuleForResource(normalizedId);
  if (moduleId && excludedResources.includes(moduleId)) {
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
  const newExcluded = new Set(excludedResources);

  if (exclude) {
    newExcluded.add(resourceId);
    
    if (isModuleId(resourceId)) {
      const module = ROLE_ACCESS_MAP.find(m => m.id === resourceId);
      if (module) {
        for (const page of module.pages) {
          newExcluded.delete(page.id);
          if (page.features) {
            for (const feature of page.features) {
              newExcluded.delete(feature.id);
            }
          }
        }
      }
    } else if (isPageId(resourceId)) {
      const moduleId = getModuleForResource(resourceId);
      if (moduleId) {
        const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
        if (module) {
          const page = module.pages.find(p => p.id === resourceId);
          if (page && page.features) {
            for (const feature of page.features) {
              newExcluded.delete(feature.id);
            }
          }
        }
      }
    }
  } else {
    newExcluded.delete(resourceId);
    
    const moduleId = getModuleForResource(resourceId);
    
    // When enabling a page that was blocked by module exclusion,
    // remove the module exclusion and add all OTHER pages to maintain block
    if (moduleId && newExcluded.has(moduleId) && isPageId(resourceId)) {
      newExcluded.delete(moduleId);
      
      const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
      if (module) {
        for (const page of module.pages) {
          if (page.id !== resourceId) {
            newExcluded.add(page.id);
          }
        }
      }
    }
    
    // When enabling a feature that was blocked by page exclusion,
    // remove the page exclusion and add all OTHER features to maintain block
    if (!isModuleId(resourceId) && !isPageId(resourceId)) {
      const pageId = getPageForResource(resourceId);
      if (pageId && newExcluded.has(pageId)) {
        newExcluded.delete(pageId);
        
        const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
        if (module) {
          const page = module.pages.find(p => p.id === pageId);
          if (page && page.features) {
            for (const feature of page.features) {
              if (feature.id !== resourceId) {
                newExcluded.add(feature.id);
              }
            }
          }
        }
      }
    }
  }

  return Array.from(newExcluded);
}

export function getModuleExclusionState(
  excludedResources: string[],
  moduleId: string
): 'all' | 'some' | 'none' {
  if (excludedResources.includes(moduleId)) {
    return 'all';
  }

  const module = ROLE_ACCESS_MAP.find(m => m.id === moduleId);
  if (!module) return 'none';

  let hasExcluded = false;
  let allExcluded = true;

  for (const page of module.pages) {
    if (excludedResources.includes(page.id)) {
      hasExcluded = true;
    } else {
      // Page is not directly excluded - check its features
      if (page.features && page.features.length > 0) {
        let excludedFeatureCount = 0;
        for (const feature of page.features) {
          if (excludedResources.includes(feature.id)) {
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
  if (excludedResources.includes(pageId)) {
    return 'all';
  }

  const moduleId = getModuleForResource(pageId);
  if (moduleId && excludedResources.includes(moduleId)) {
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

  let hasExcluded = false;
  let allExcluded = true;

  for (const feature of page.features) {
    if (excludedResources.includes(feature.id)) {
      hasExcluded = true;
    } else {
      allExcluded = false;
    }
  }

  if (hasExcluded && !allExcluded) return 'some';
  if (hasExcluded && allExcluded) return 'all';
  return 'none';
}

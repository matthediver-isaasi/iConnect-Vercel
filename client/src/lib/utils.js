import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

// Event Filter Tag Utilities
// Generates a stable key for event filter tags using categoryId::subcategory format
// This prevents collisions when different categories have the same subcategory names

const FILTER_TAG_DELIMITER = '::';

/**
 * Creates a stable filter tag key from category ID and subcategory name
 * @param {string} categoryId - The category UUID
 * @param {string} subcategory - The subcategory label
 * @returns {string} Composite key like "uuid::subcategoryname"
 */
export function createFilterTagKey(categoryId, subcategory) {
  return `${categoryId}${FILTER_TAG_DELIMITER}${subcategory}`;
}

/**
 * Parses a filter tag key back to its components
 * @param {string} key - The composite key
 * @returns {{ categoryId: string|null, label: string }} Parsed components
 */
export function parseFilterTagKey(key) {
  if (!key || typeof key !== 'string') {
    return { categoryId: null, label: key || '' };
  }
  const delimiterIndex = key.indexOf(FILTER_TAG_DELIMITER);
  if (delimiterIndex === -1) {
    // Legacy format - just the label
    return { categoryId: null, label: key };
  }
  return {
    categoryId: key.substring(0, delimiterIndex),
    label: key.substring(delimiterIndex + FILTER_TAG_DELIMITER.length)
  };
}

/**
 * Builds a lookup map from filter tag keys to display labels
 * @param {Array} eventCategories - Array of { id, name, subcategories: string[] }
 * @returns {Map<string, { categoryName: string, subcategory: string }>} Map of key to display info
 */
export function buildFilterTagKeyMap(eventCategories) {
  const map = new Map();
  for (const cat of eventCategories) {
    for (const sub of cat.subcategories || []) {
      const key = createFilterTagKey(cat.id, sub);
      map.set(key, { categoryName: cat.name, subcategory: sub, categoryId: cat.id });
    }
  }
  return map;
}

/**
 * Normalizes legacy filter tags (plain labels) to new key format
 * @param {string[]} filterTags - Array of filter tag values (may be legacy or new format)
 * @param {Array} eventCategories - Array of { id, name, subcategories: string[] }
 * @returns {string[]} Normalized array of filter tag keys
 */
export function normalizeFilterTags(filterTags, eventCategories) {
  if (!filterTags || !Array.isArray(filterTags)) return [];
  
  const result = [];
  for (const tag of filterTags) {
    // Check if already in new format
    if (tag.includes(FILTER_TAG_DELIMITER)) {
      result.push(tag);
      continue;
    }
    // Legacy format - find matching subcategory and convert
    let found = false;
    for (const cat of eventCategories) {
      if (cat.subcategories?.includes(tag)) {
        result.push(createFilterTagKey(cat.id, tag));
        found = true;
        break;
      }
    }
    // If no match found, keep the legacy value (could be orphaned data)
    if (!found) {
      result.push(tag);
    }
  }
  return result;
}

/**
 * Converts filter tag keys to display labels for showing in the UI
 * @param {string[]} filterTagKeys - Array of filter tag keys
 * @param {Map} keyMap - Map from buildFilterTagKeyMap
 * @returns {Array<{ key: string, label: string }>} Array with key and label
 */
export function getFilterTagLabels(filterTagKeys, keyMap) {
  return filterTagKeys.map(key => {
    const info = keyMap.get(key);
    if (info) {
      return { key, label: info.subcategory };
    }
    // Legacy or unmatched key - parse it
    const parsed = parseFilterTagKey(key);
    return { key, label: parsed.label };
  });
} 
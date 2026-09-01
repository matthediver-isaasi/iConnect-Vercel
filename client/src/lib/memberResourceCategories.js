/**
 * Convert the member-resource-category endpoint response into the shape used
 * by the category controls and save request.
 *
 * The persisted association calls its foreign key resource_category_id. Keep
 * the UI's category_id name as an internal request concern rather than
 * accepting the old response field, which can make saved rows invisible.
 */
export function normalizeMemberCategorySelections(selections) {
  if (!Array.isArray(selections)) return [];

  const seen = new Set();
  return selections.reduce((normalized, selection) => {
    const categoryId = typeof selection?.resource_category_id === 'string'
      ? selection.resource_category_id.trim()
      : '';

    if (!categoryId) return normalized;

    const subcategoryName = typeof selection.subcategory_name === 'string'
      ? selection.subcategory_name.trim() || null
      : null;
    const key = `${categoryId}|${subcategoryName || ''}`;

    if (seen.has(key)) return normalized;
    seen.add(key);
    normalized.push({
      category_id: categoryId,
      subcategory_name: subcategoryName,
    });
    return normalized;
  }, []);
}
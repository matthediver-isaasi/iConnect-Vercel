export async function loadArticleForEditing(entity, id) {
  const article = await entity.get(id);
  if (!article || article.id !== id) throw new Error('The article could not be loaded for editing.');
  if (!Object.prototype.hasOwnProperty.call(article, 'feature_image_url')) {
    throw new Error('The saved article image could not be loaded. Reload before editing.');
  }
  return article;
}

// Existing image data is not owned by unrelated text/autosave changes.
// Clearing it must be an explicit editor action, never an empty initial state.
export function articleUpdateWithImageIntent(data, imageChanged) {
  if (imageChanged) return data;
  const { feature_image_url, feature_image_focal_point, ...rest } = data;
  return rest;
}

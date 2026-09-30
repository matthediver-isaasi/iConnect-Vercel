export const isPreferencePlaceholder = name => /^(unsubscribe|communication_preferences)_(link|url)$/i.test(String(name).trim());
export function replacePlaceholders(template, entityType, entityData, context) {
  if (!template) return '';
  let result = template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
    if (isPreferencePlaceholder(path)) return match;
    const parts = path.split('.');
    if (parts[0] === entityType || parts[0] === 'record') return entityData?.[parts[1] || parts[0]] || match;
    return entityData?.[path] || match;
  });
  result = result.replace(/\[\[(\w+(?:\.\w+)?)\]\]/g, (match, path) => {
    const parts = path.split('.');
    if ([entityType, 'record', 'organization', 'member'].includes(parts[0])) {
      const fieldName = parts[1] || parts[0];
      const value = parts[0] !== entityType && parts[1]
        ? entityData?.[`${parts[0]}_${parts[1]}`] || entityData?.[fieldName] : entityData?.[fieldName];
      return value || match;
    }
    return entityData?.[path] || match;
  });
  return result;
}
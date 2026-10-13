export function validateDirectoryExpression(expression) {
  let count = 0;
  if (!expression || expression.version !== 1 || !expression.root?.op
    || Object.keys(expression).some(key => !['version', 'root'].includes(key))) throw new Error('Unsupported directory inclusion expression');
  function visit(node, depth) {
    if (++count > 100 || depth > 5) throw new Error('Directory rules exceed 100 nodes or 5 levels');
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid directory condition');
    if ('op' in node) {
      if (Object.keys(node).some(key => !['op', 'children'].includes(key))) throw new Error('Invalid directory group');
      if (!['and', 'or'].includes(node.op) || !Array.isArray(node.children) || !node.children.length) throw new Error('Each All/Any group needs at least one condition');
      node.children.forEach(child => visit(child, depth + 1));
    } else if (Object.keys(node).some(key => !['field_id', 'value'].includes(key))
      || typeof node.field_id !== 'string' || !node.field_id.trim()
      || !['string', 'boolean', 'number'].includes(typeof node.value)
      || node.value === '' || (typeof node.value === 'number' && !Number.isFinite(node.value))
      || String(node.value).length > 2000) throw new Error('Select a field and value for every condition');
  }
  visit(expression.root, 1);
  return expression;
}

export function normalizeDirectoryExpression(directory) {
  if (directory.filter_expression != null) return validateDirectoryExpression(directory.filter_expression);
  if (!directory.filter_field_id && (directory.filter_value == null || directory.filter_value === '')) return null;
  return validateDirectoryExpression({ version: 1, root: { op: 'and', children: [
    { field_id: directory.filter_field_id, value: directory.filter_value },
  ] } });
}

export function expressionFieldIds(expression) {
  const ids = new Set();
  function visit(node) {
    if (node.op) node.children.forEach(visit);
    else ids.add(node.field_id);
  }
  if (expression) visit(validateDirectoryExpression(expression).root);
  return [...ids];
}

export function directoryValueMatches(stored, expected) {
  if (stored == null) return false;
  if (Array.isArray(stored)) return stored.some(value => directoryValueMatches(value, expected));
  if (typeof stored === 'string') {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return directoryValueMatches(parsed, expected);
      if (typeof parsed === 'string' && parsed !== stored) return directoryValueMatches(parsed, expected);
    } catch {}
  }
  if (stored === expected || String(stored) === String(expected)) return true;
  const boolean = value => {
    const text = String(value).trim().toLowerCase();
    return ['true', 'yes', '1'].includes(text) ? true : ['false', 'no', '0'].includes(text) ? false : null;
  };
  const canonical = boolean(stored);
  return canonical !== null && canonical === boolean(expected);
}

export function matchesDirectoryExpression(expression, values) {
  if (!expression) return true;
  const visit = node => node.op
    ? node.children[node.op === 'and' ? 'every' : 'some'](visit)
    : (values.get(node.field_id) || []).some(value => directoryValueMatches(value, node.value));
  return visit(validateDirectoryExpression(expression).root);
}

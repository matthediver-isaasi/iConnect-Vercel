import { normalizeDirectoryExpression, validateDirectoryExpression, expressionFieldIds } from "../../../shared/directoryExpression.js";
import { getDirectoryFilterOptions } from "./directorySettings.js";

export const emptyDirectoryExpression = () => ({
  version: 1, root: { op: "and", children: [{ field_id: "", value: "" }] },
});

export async function loadDirectoryRuleFields(preferenceFieldEntity, tenantId, entityType) {
  if (!tenantId) throw new Error("Tenant identity is required to discover inclusion fields");
  const fields = [];
  let offset = 0;
  while (true) {
    const batch = await preferenceFieldEntity.list({
      filter: { tenant_id: tenantId, entity_scope: entityType, is_active: true },
      sort: { display_order: "asc", id: "asc" },
      limit: 500,
      offset,
    });
    if (!Array.isArray(batch)) throw new Error("Invalid field discovery response");
    if (!batch.length) break;
    fields.push(...batch);
    offset += batch.length;
    if (offset >= 100000) throw new Error("Field discovery exceeded the 100000-record safety limit");
  }
  return fields.filter(field =>
    (!field.tenant_id || field.tenant_id === tenantId) &&
    field.entity_scope === entityType && field.is_active !== false &&
    ["picklist", "dropdown", "boolean"].includes(field.field_type));
}

export function readDirectoryExpression(directory) {
  const expression = normalizeDirectoryExpression(directory);
  if (expression && !expression.root?.op) throw new Error("Inclusion rules must start with an All/Any group");
  return expression || emptyDirectoryExpression();
}

// The shared reader validates saved expressions. Drafts deliberately contain
// blank leaves / empty groups while editing, so collect their chosen IDs safely.
export function draftExpressionFieldIds(expression) {
  try {
    return Array.from(expressionFieldIds(expression));
  } catch {
    const ids = new Set();
    const visit = node => {
      if (node.children) node.children.forEach(visit);
      else if (node.field_id) ids.add(node.field_id);
    };
    if (expression?.root) visit(expression.root);
    return [...ids];
  }
}

export function countExpressionNodes(node) {
  return 1 + (node.children || []).reduce((total, child) => total + countExpressionNodes(child), 0);
}

export function replaceExpressionNode(node, path, replacement) {
  if (!path.length) return replacement;
  const [index, ...rest] = path;
  return { ...node, children: node.children.map((child, i) =>
    i === index ? replaceExpressionNode(child, rest, replacement) : child) };
}

export function expressionSummary(expression, fields = []) {
  const describe = node => {
    if (node.children) return `${node.op === "and" ? "All" : "Any"} of (${node.children.map(describe).join("; ")})`;
    const field = fields.find(f => f.id === node.field_id);
    const option = getDirectoryFilterOptions(field).find(o => String(o.value) === String(node.value));
    return `${field?.label || node.field_id || "Choose field"} = ${option?.label || (node.value === "" ? "Choose value" : String(node.value))}`;
  };
  return expression ? describe(expression.root) : "No inclusion rules";
}

export function directoryExpressionError(expression, fields) {
  try {
    const result = validateDirectoryExpression(expression);
    if (result === false || result?.valid === false) {
      return result?.errors?.join?.("; ") || result?.error || "Complete every condition and group.";
    }
  } catch (error) {
    return error.message || "Invalid inclusion rules.";
  }
  for (const id of expressionFieldIds(expression)) {
    if (!fields.some(field => field.id === id)) return `Field ${id} is unavailable. Replace or remove its condition.`;
  }
  // Option catalog changes must not rewrite the meaning of saved scalar values.
  // The shared validator still rejects blank or malformed conditions.
  return null;
}

export function directoryExpressionSaveFields(expression, selectedFilterFields) {
  const firstLeaf = node => node.children ? firstLeaf(node.children[0]) : node;
  const leaf = firstLeaf(expression.root);
  return {
    filter_expression: expression,
    // Older visitor-filter implementations still exclude this primary field.
    filter_field_id: leaf.field_id,
    filter_value: String(leaf.value),
    selected_filter_fields: selectedFilterFields,
  };
}

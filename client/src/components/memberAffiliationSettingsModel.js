import { validateProfileAffiliationConfig } from "../../../api/_lib/profileAffiliationPolicy.js";

export const EMPTY_CONFIG = {
  enabled: false, memberDepartmentDefinitionId: null, departmentOrganizationDefinitionId: null,
  secondaryMemberDefinitionId: null, secondaryOrganizationDefinitionId: null, secondaryLabelFieldId: null,
};

// Labels are for people; identifiers are reserved for the optional technical panel.
export function displayName(row, fallback) {
  const label = row?.plural_label || row?.label || row?.field_label || row?.name;
  return typeof label === "string" && label.trim() && !/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(label)
    ? label : fallback;
}

export function endpoint(definition, kind, metadata) {
  if (definition?.status !== "active") return null;
  const side = definition.source_kind === kind && definition.target_kind === "custom_object" ? "source"
    : definition.target_kind === kind && definition.source_kind === "custom_object" ? "target" : null;
  if (!side) return null;
  const other = side === "source" ? "target" : "source";
  const object = metadata.objects.find(item => item.id === definition[`${other}_custom_object_id`] && item.status === "active");
  if (!object) return null;
  const display = (metadata.fields[object.id] || []).find(field => field.id === object.primary_display_field_id);
  if (!display?.name || display.is_active === false || display.archived_at) return null;
  return { side, other, objectId: object.id, object };
}

const owned = (definition, end) => !!end && definition.cardinality === (end.side === "target" ? "many_to_one" : "one_to_many");
const textField = field => ["text", "textarea"].includes(field.field_type) && field.is_active !== false && !field.archived_at;
const secondarySafe = definition => !definition.configuration?.picker_scope
  && !(definition.configuration?.relationship_fields || definition.configuration?.relationshipFields || []).length;
const departmentSafe = definition => {
  const fields = definition.configuration?.relationship_fields ?? definition.configuration?.relationshipFields ?? [];
  return Array.isArray(fields) && fields.every(field => (field.type ?? field.field_type) === "boolean"
    && (field.default_value ?? field.defaultValue ?? field.default ?? false) === false);
};

// Duplicate human names get a stable, local choice number, never an identifier.
export function namedChoices(rows, makeLabel) {
  const labels = rows.map(makeLabel);
  return rows.map((row, index) => ({
    id: row.id, label: labels[index] + (labels.filter(label => label === labels[index]).length > 1
      ? ` — choice ${labels.slice(0, index + 1).filter(label => label === labels[index]).length}` : ""),
  }));
}

export function affiliationChoices(config, metadata) {
  const relationships = metadata.relationships || [];
  const find = id => relationships.find(row => row.id === id);
  const memberEnd = definition => endpoint(definition, "member", metadata);
  const orgEnd = definition => endpoint(definition, "organization", metadata);
  const departments = relationships.filter(row => memberEnd(row) && row.cardinality === "many_to_many" && departmentSafe(row));
  const department = departments.find(row => row.id === config.memberDepartmentDefinitionId);
  const departmentObject = department && memberEnd(department);
  const owners = departmentObject ? relationships.filter(row => {
    const end = orgEnd(row);
    return owned(row, end) && end.objectId === departmentObject.objectId;
  }) : [];
  const owner = owners.find(row => row.id === config.departmentOrganizationDefinitionId);
  const assignments = departmentObject && owner ? relationships.filter(row => {
    const end = memberEnd(row);
    if (!owned(row, end) || end.objectId === departmentObject.objectId || !secondarySafe(row)) return false;
    const required = (metadata.fields[end.objectId] || []).filter(field => field.is_required);
    return required.length === 0 || (required.length === 1 && textField(required[0]));
  }) : [];
  const assignment = assignments.find(row => row.id === config.secondaryMemberDefinitionId);
  const assignmentObject = assignment && memberEnd(assignment);
  const assignmentOwners = assignmentObject ? relationships.filter(row => {
    const end = orgEnd(row);
    return owned(row, end) && end.objectId === assignmentObject.objectId && secondarySafe(row);
  }) : [];
  const assignmentOwner = assignmentOwners.find(row => row.id === config.secondaryOrganizationDefinitionId);
  const fields = assignmentObject && assignmentOwner ? (metadata.fields[assignmentObject.objectId] || [])
    .filter(field => textField(field) && !(metadata.fields[assignmentObject.objectId] || []).some(other => other.is_required && other.id !== field.id)) : [];
  const relationshipLabel = kind => row => {
    const object = endpoint(row, kind, metadata)?.object;
    return `${displayName(object, "Unnamed record type")} — ${displayName(row, "Unnamed connection")}`;
  };
  return {
    memberDepartmentDefinitionId: namedChoices(departments, relationshipLabel("member")),
    departmentOrganizationDefinitionId: namedChoices(owners, relationshipLabel("organization")),
    secondaryMemberDefinitionId: namedChoices(assignments, relationshipLabel("member")),
    secondaryOrganizationDefinitionId: namedChoices(assignmentOwners, relationshipLabel("organization")),
    secondaryLabelFieldId: namedChoices(fields, row => displayName(row, "Unnamed text field")),
    departmentName: departmentObject ? displayName(departmentObject.object, "Department records") : null,
    assignmentName: assignmentObject ? displayName(assignmentObject.object, "Additional organisation records") : null,
    departmentReady: !!department, ownerReady: !!owner, assignmentReady: !!assignment, assignmentOwnerReady: !!assignmentOwner,
    requiredLabel: !!assignmentObject && (metadata.fields[assignmentObject.objectId] || []).some(field => field.is_required),
    find,
  };
}

export function affiliationValidation(config, metadata, choices) {
  if (!config.enabled) return { issues: {}, policyIssue: "", valid: true };
  const issues = {};
  const checks = [
    ["memberDepartmentDefinitionId", true, "Choose how members are linked to departments."],
    ["departmentOrganizationDefinitionId", true, "Choose which organisation owns each department."],
    ["secondaryMemberDefinitionId", !!(config.secondaryOrganizationDefinitionId || config.secondaryLabelFieldId), "Choose how additional organisations are recorded, or clear the other additional organisation settings."],
    ["secondaryOrganizationDefinitionId", !!config.secondaryMemberDefinitionId, "Choose the organisation connection for these additional records."],
    ["secondaryLabelFieldId", choices.requiredLabel, "Choose the required description field for these additional records."],
  ];
  for (const [key, required, missing] of checks) {
    if (!config[key] && required) issues[key] = missing;
    else if (config[key] && !choices[key].some(row => row.id === config[key])) {
      issues[key] = "This saved choice is not available for this step. Choose a compatible option, or turn off member updates to keep it for later review.";
    }
  }
  let policyIssue = "";
  try {
    // The same pure validator used by the API remains the final authority,
    // including picker scope, required fields, and relationship-field safety.
    validateProfileAffiliationConfig(config, metadata);
  } catch (error) {
    if (!Object.keys(issues).length) {
      policyIssue = error.message.includes("scope")
        ? "These choices do not match the department access rules. Review the connections in Technical details with your system administrator before saving."
        : "These choices cannot safely support member updates. Ask your system administrator to review the connections and required fields, or turn off member updates.";
    }
    return { issues, policyIssue, valid: false };
  }
  return { issues, policyIssue, valid: Object.keys(issues).length === 0 };
}

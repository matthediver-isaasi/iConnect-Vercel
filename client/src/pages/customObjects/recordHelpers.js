export const arrayValue = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return [value];
  }
};

export const optionValues = (field) =>
  (Array.isArray(field?.options) ? field.options : [])
    .map((option) =>
      typeof option === "string"
        ? { value: option, label: option }
        : { value: String(option.value), label: option.label || String(option.value) },
    )
    .filter((option) => option.value);

export const coerceRecordValue = (field, value) => {
  if (value === "" || value === null || value === undefined) return null;
  if (field.field_type === "boolean") return value === true || value === "true";
  if (field.field_type === "number" || field.field_type === "decimal")
    return Number(value);
  if (["picklist", "countries", "list"].includes(field.field_type))
    return arrayValue(value).map(String);
  if (field.field_type === "file" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return {
          ...parsed,
          name: parsed.name || parsed.file_name,
          url: parsed.url || parsed.file_url,
          path: parsed.path || parsed.storage_path,
        };
      }
    } catch {
      return value;
    }
  }
  return String(value).trim();
};

const blank = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const fileTypeExtensions = {
  pdf: [".pdf"],
  word: [".doc", ".docx"],
  excel: [".xls", ".xlsx", ".csv"],
  powerpoint: [".ppt", ".pptx"],
  images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"],
  text: [".txt", ".rtf"],
  zip: [".zip", ".rar", ".7z"],
  video: [".mp4", ".mov", ".avi", ".webm"],
  audio: [".mp3", ".wav", ".m4a", ".ogg"],
};

export function validateRecordValues(fields, values, { partial = false } = {}) {
  const errors = {};
  for (const field of fields.filter((item) => item.is_active !== false)) {
    if (partial && !Object.hasOwn(values, field.name)) continue;
    const value = coerceRecordValue(field, values[field.name]);
    const label = field.label || field.name;
    if (field.is_required && blank(value)) {
      errors[field.name] = `${label} is required`;
      continue;
    }
    if (blank(value)) continue;
    if (field.field_type === "number" && !Number.isInteger(value))
      errors[field.name] = `${label} must be a whole number`;
    else if (field.field_type === "decimal" && !Number.isFinite(value))
      errors[field.name] = `${label} must be a finite number`;
    else if (
      field.field_type === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      errors[field.name] = `${label} must be a valid email address`;
    else if (field.field_type === "url") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        errors[field.name] = `${label} must be a valid HTTP or HTTPS URL`;
      }
    } else if (field.field_type === "date") {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        errors[field.name] = `${label} must be a valid date`;
    } else if (
      ["text", "textarea"].includes(field.field_type) &&
      field.min_length != null &&
      value.length < field.min_length
    )
      errors[field.name] = `${label} must contain at least ${field.min_length} characters`;
    else if (
      ["text", "textarea"].includes(field.field_type) &&
      field.max_length != null &&
      value.length > field.max_length
    )
      errors[field.name] = `${label} must contain no more than ${field.max_length} characters`;
    else if (
      ["picklist", "countries", "list"].includes(field.field_type) &&
      field.min_selections != null &&
      value.length < field.min_selections
    )
      errors[field.name] = `${label} requires at least ${field.min_selections} selections`;
    else if (
      ["picklist", "countries", "list"].includes(field.field_type) &&
      field.max_selections != null &&
      value.length > field.max_selections
    )
      errors[field.name] = `${label} allows no more than ${field.max_selections} selections`;
    else if (field.field_type === "dropdown") {
      const allowed = new Set(optionValues(field).map((option) => option.value));
      if (allowed.size && !allowed.has(String(value)))
        errors[field.name] = `${label} must use an allowed option`;
    } else if (field.field_type === "picklist") {
      const allowed = new Set(optionValues(field).map((option) => option.value));
      if (allowed.size && value.some((item) => !allowed.has(String(item))))
        errors[field.name] = `${label} contains an option that is not allowed`;
    } else if (
      field.field_type === "country" &&
      field.all_countries === false &&
      !arrayValue(field.selected_countries).map(String).includes(String(value))
    )
      errors[field.name] = `${label} must use an allowed country`;
    else if (
      field.field_type === "countries" &&
      field.all_countries === false &&
      value.some(
        (item) =>
          !arrayValue(field.selected_countries)
            .map(String)
            .includes(String(item)),
      )
    )
      errors[field.name] = `${label} contains a country that is not allowed`;
    else if (field.field_type === "file") {
      const files = Array.isArray(value) ? value : [value];
      const allowedExtensions = arrayValue(field.allowed_file_types).flatMap(
        (type) => fileTypeExtensions[type] || [],
      );
      const invalidReference = files.some(
        (file) =>
          typeof file !== "string" &&
          !(
            file &&
            typeof file === "object" &&
            ["name", "url", "path", "file_name", "file_url", "storage_path"].some(
              (key) => typeof file[key] === "string",
            )
          ),
      );
      const invalidExtension =
        allowedExtensions.length > 0 &&
        files.some((file) => {
          const name =
            typeof file === "string"
              ? file
              : file.name ||
                file.file_name ||
                file.url ||
                file.file_url ||
                file.path ||
                file.storage_path ||
                "";
          const pathname = name.split(/[?#]/, 1)[0].toLowerCase();
          return !allowedExtensions.some((extension) =>
            pathname.endsWith(extension),
          );
        });
      if (invalidReference)
        errors[field.name] = `${label} must be a file reference`;
      else if (invalidExtension)
        errors[field.name] = `${label} contains a file type that is not allowed`;
    }
  }
  return errors;
}

export const buildRecordPayload = (fields, values, { partial = false } = {}) => ({
  data: Object.fromEntries(
    fields
      .filter((field) =>
        field.is_active !== false
        && (!partial || Object.hasOwn(values, field.name)))
      .map((field) => [field.name, coerceRecordValue(field, values[field.name])]),
  ),
});

export const formatRecordValue = (field, value, countryNames = {}) => {
  if (blank(value)) return "—";
  if (field?.field_type === "boolean") return value === true || value === "true" ? "Yes" : "No";
  const options = new Map(optionValues(field).map((option) => [option.value, option.label]));
  if (["picklist", "list", "countries"].includes(field?.field_type)) {
    return arrayValue(value)
      .map((item) => options.get(String(item)) || countryNames[item] || String(item))
      .join(", ");
  }
  if (field?.field_type === "dropdown")
    return options.get(String(value)) || String(value);
  if (field?.field_type === "country") return countryNames[value] || String(value);
  if (field?.field_type === "file") {
    const file = Array.isArray(value) ? value[0] : value;
    if (typeof file === "object") return file.file_name || file.name || "Uploaded file";
  }
  return String(value);
};

// Field access is deliberately tolerant of the API's compact and expanded
// metadata forms.  Absence means the legacy, backwards-compatible write access.
export const fieldAccess = (field = {}) => {
  const raw = field.access ?? field.field_access ?? field.permission?.access
    ?? field.permissions?.access ?? field.permission;
  if (raw === false || ["none", "no_access", "hidden", "deny"].includes(String(raw).toLowerCase()))
    return "none";
  if (["read", "readonly", "read_only", "view"].includes(String(raw).toLowerCase()))
    return "read";
  if (raw && typeof raw === "object") {
    if (raw.can_view === false || raw.view === false || raw.read === false) return "none";
    if (raw.can_edit === false || raw.write === false || raw.edit === false) return "read";
  }
  return "write";
};

export const readableFields = (fields = []) =>
  fields.filter((field) => field.is_active !== false && fieldAccess(field) !== "none");

export const writableFields = (fields = []) =>
  readableFields(fields).filter((field) => fieldAccess(field) === "write");

const configuredIds = (value) => (Array.isArray(value) ? value : [])
  .map((item) => typeof item === "object" ? item.field_id || item.id : item)
  .filter(Boolean)
  .map(String);

export const objectPresentation = (object = {}) =>
  object.presentation || object.view_configuration || object.view_config
  || object.configuration?.presentation || object.configuration?.views || {};

// Discard stale, archived and inaccessible configured fields; then append a
// sensible metadata-driven fallback without ever exposing hidden fields.
export const orderedPresentationFields = (fields, configured, fallback = fields) => {
  const allowed = readableFields(fields);
  const byId = new Map(allowed.map((field) => [String(field.id), field]));
  const selected = configuredIds(configured).map((id) => byId.get(id)).filter(Boolean);
  return selected.length
    ? selected
    : readableFields(fallback).filter((field) => byId.has(String(field.id)));
};

export const sharedListFields = (object, fields) => {
  const presentation = objectPresentation(object);
  return orderedPresentationFields(fields,
    presentation.list_fields || presentation.list?.fields || presentation.list?.field_ids || presentation.list?.default_field_ids,
    readableFields(fields).slice(0, 5));
};

export const detailSections = (object, fields) => {
  const presentation = objectPresentation(object);
  const sections = presentation.detail_sections || presentation.detail?.sections;
  if (!Array.isArray(sections) || !sections.length)
    return [{ id: "details", label: `${object?.singular_label || "Record"} details`, fields: readableFields(fields) }];
  return sections.map((section, index) => ({
    id: section.id || `section-${index}`,
    label: section.label || section.title || `Section ${index + 1}`,
    fields: orderedPresentationFields(fields, section.fields || section.field_ids, []),
  })).filter((section) => section.fields.length);
};

export const customObjectFieldLayoutId = (fieldId) => `custom:${fieldId}`;
export const customObjectRelationshipLayoutId = (definitionId, side) =>
  `relationship:${definitionId}:${side}`;

const clampColumns = (value) => Math.max(1, Math.min(3, Number(value) || 1));
const columnFor = (value, fallback, columns) => {
  const parsed = Number(value);
  return Math.min(columns - 1, Math.max(0, Number.isFinite(parsed) ? parsed : fallback));
};

// Normalises both the original section contract and the CRM card contract. IDs
// refer to schema IDs (never mutable field names), so renames are harmless.
export function customObjectDetailLayout(object, fields, relationshipPanels = []) {
  const readable = readableFields(fields);
  const fieldsById = new Map(readable.map((field) => [String(field.id), field]));
  const relationshipsById = new Map(
    relationshipPanels.map((panel) => [
      customObjectRelationshipLayoutId(panel.definition.id, panel.side),
      panel,
    ]),
  );
  const presentation = objectPresentation(object);
  const detail = presentation.detail || {};
  const knownFieldIds = new Set(
    configuredIds(detail.schema_field_ids || detail.available_field_ids),
  );
  const configuredCards = Array.isArray(detail.cards)
    ? detail.cards
    : Array.isArray(presentation.detail_cards)
      ? presentation.detail_cards
      : null;
  const legacySections = presentation.detail_sections || detail.sections;
  const sourceCards = configuredCards?.length
    ? configuredCards
    : Array.isArray(legacySections) && legacySections.length
      ? legacySections.map((section, index) => ({
          id: section.id || `section-${index}`,
          title: section.label || section.title,
          columns: 2,
          fields: configuredIds(section.fields || section.field_ids).map((fieldId, fieldIndex) => ({
            id: customObjectFieldLayoutId(fieldId),
            type: "custom",
            fieldId,
            columnIndex: fieldIndex % 2,
          })),
        }))
      : [{
          id: "card-details",
          title: `${object?.singular_label || "Record"} details`,
          columns: 2,
          fields: readable.map((field, index) => ({
            id: customObjectFieldLayoutId(field.id),
            type: "custom",
            fieldId: String(field.id),
            columnIndex: index % 2,
          })),
        }];

  const assigned = new Set();
  const cards = sourceCards.map((card, cardIndex) => {
    const columns = clampColumns(card.columns);
    const elements = (Array.isArray(card.fields) ? card.fields : []).flatMap((element, index) => {
      const type = element?.type === "relationship" || String(element?.id || "").startsWith("relationship:")
        ? "relationship"
        : "custom";
      if (type === "relationship") {
        const id = customObjectRelationshipLayoutId(
          element.definitionId ?? element.definition_id,
          element.side,
        );
        if (!relationshipsById.has(id) || assigned.has(id)) return [];
        assigned.add(id);
        return [{ ...element, id, type, definitionId: String(element.definitionId ?? element.definition_id), side: element.side, columnIndex: columnFor(element.columnIndex, 0, columns) }];
      }
      const fieldId = String(element.fieldId ?? element.field_id ?? element.id?.replace(/^custom:/, "") ?? "");
      const id = customObjectFieldLayoutId(fieldId);
      if (!fieldsById.has(fieldId) || assigned.has(id)) return [];
      assigned.add(id);
      return [{ ...element, id, type: "custom", fieldId, columnIndex: columnFor(element.columnIndex, index % columns, columns) }];
    });
    return {
      id: String(card.id || `card-${cardIndex + 1}`),
      title: card.title || card.label || `Card ${cardIndex + 1}`,
      columns,
      fields: elements,
    };
  });

  // A newly-created readable field is useful immediately, while removed or
  // inaccessible elements above are discarded without invalidating the page.
  const shouldReconcileNewFields = Boolean(configuredCards?.length);
  const missing = shouldReconcileNewFields
    ? readable.filter((field) =>
        !assigned.has(customObjectFieldLayoutId(field.id))
        && (!knownFieldIds.size || !knownFieldIds.has(String(field.id))))
    : [];
  if (missing.length) {
    let target = cards.find((card) => card.id === "card-details") || cards[0];
    if (!target) {
      target = { id: "card-details", title: `${object?.singular_label || "Record"} details`, columns: 2, fields: [] };
      cards.push(target);
    }
    target.fields.push(...missing.map((field, index) => ({
      id: customObjectFieldLayoutId(field.id),
      type: "custom",
      fieldId: String(field.id),
      columnIndex: (target.fields.length + index) % target.columns,
    })));
  }
  return { version: 2, cards };
}

export function unplacedRelationshipPanels(layout, relationshipPanels = []) {
  const placed = new Set(
    (layout?.cards || []).flatMap((card) => card.fields || [])
      .filter((element) => element.type === "relationship")
      .map((element) => element.id),
  );
  return relationshipPanels.filter((panel) =>
    !placed.has(customObjectRelationshipLayoutId(panel.definition.id, panel.side)));
}

const conditionMatches = (condition, record, fieldsById) => {
  const id = String(condition.field_id || condition.fieldId || "").replace(/^custom:/, "");
  const field = fieldsById.get(id);
  if (!field) return false;
  const value = record?.data?.[field.name];
  const expected = condition.value;
  switch (condition.operator) {
    case "not_equals": return String(value ?? "") !== String(expected ?? "");
    case "contains": return Array.isArray(value)
      ? value.map(String).includes(String(expected))
      : String(value ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "not_contains": return Array.isArray(value)
      ? !value.map(String).includes(String(expected))
      : !String(value ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "is_empty": return blank(value);
    case "not_empty":
    case "is_not_empty": return !blank(value);
    case "greater_than": return Number(value) > Number(expected);
    case "less_than": return Number(value) < Number(expected);
    default:
      if (field.field_type === "boolean")
        return (value === true || value === "true") === (expected === true || expected === "true");
      return String(value ?? "") === String(expected ?? "");
  }
};

export function evaluateCustomObjectVisibility(rulesConfig, record, fields = []) {
  const hiddenCards = new Set();
  const hiddenElements = new Set();
  const fieldsById = new Map(readableFields(fields).map((field) => [String(field.id), field]));
  const rules = Array.isArray(rulesConfig) ? rulesConfig : rulesConfig?.rules;
  const safeRules = Array.isArray(rules) ? rules : [];
  // "Show" rules are opt-in: their target remains hidden until one matching
  // rule reveals it. This mirrors the established CRM visibility semantics.
  for (const rule of safeRules) {
    for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
      if (action.action_type !== "show") continue;
      const target = action.target_card_id || action.target_id || action.target_field_id;
      if (target) (action.target_type === "card" ? hiddenCards : hiddenElements).add(String(target));
    }
  }
  for (const rule of safeRules) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (!conditions.length) continue;
    const matches = conditions.map((condition) => conditionMatches(condition, record, fieldsById));
    const applies = (rule.logic || "and") === "or" ? matches.some(Boolean) : matches.every(Boolean);
    if (!applies) continue;
    for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
      const target = action.target_card_id || action.target_id || action.target_field_id;
      if (!target) continue;
      const set = action.target_type === "card" ? hiddenCards : hiddenElements;
      if (action.action_type === "show") set.delete(String(target));
      else if (action.action_type === "hide") set.add(String(target));
    }
  }
  return { hiddenCards, hiddenElements };
}

export const compactPreviewFields = (definition, side, fields) => {
  const config = definition?.configuration || {};
  const preview = config.compact_preview || config.compactPreview || config.preview || {};
  // `side` is the viewed endpoint; persisted metadata is keyed by the
  // opposite endpoint because those are the fields being rendered.
  const relatedSide = side === "source" ? "target" : "source";
  return orderedPresentationFields(fields,
    preview[`${relatedSide}_field_ids`] || preview[relatedSide]?.fields || preview[relatedSide]?.field_ids
      || preview[relatedSide] || config[`${relatedSide}_compact_fields`],
    []);
};

export const compactPreviewColumns = (definition, side, projectedFields = []) => {
  const config = definition?.configuration || {};
  const preview = config.compact_preview || config.compactPreview || config.preview || {};
  const legacyPreview = config.compact_preview_fields || {};
  const relatedSide = side === "source" ? "target" : "source";
  const columns = preview[`${relatedSide}_columns`];
  if (!Array.isArray(columns)) return [];
  const normalized = columns.flatMap((column) => {
    const label = String(column?.label || "").trim();
    if (!label) return [];
    if (column.type === "field" && column.field_id)
      return [{ type: "field", field_id: String(column.field_id), label }];
    if (
      column.type === "relationship"
      && column.relationship_definition_id
      && ["source", "target"].includes(column.side)
    ) return [{
      type: "relationship",
      relationship_definition_id: String(column.relationship_definition_id),
      side: column.side,
      label,
    }];
    return [];
  });
  const configuredFieldIds = new Set(normalized
    .filter((column) => column.type === "field")
    .map((column) => column.field_id));
  const legacyIds = [...new Set([
    ...(Array.isArray(preview[`${relatedSide}_field_ids`] || preview[relatedSide])
      ? (preview[`${relatedSide}_field_ids`] || preview[relatedSide])
      : []),
    ...(Array.isArray(legacyPreview[`${relatedSide}_field_ids`] || legacyPreview[relatedSide])
      ? (legacyPreview[`${relatedSide}_field_ids`] || legacyPreview[relatedSide])
      : []),
  ].map(String))];
  const projectedById = new Map((projectedFields || [])
    .map((item) => [String(item.field_id), item]));
  const legacyColumns = (Array.isArray(legacyIds) ? legacyIds : [])
    .filter((fieldId) => !configuredFieldIds.has(fieldId))
    .map((fieldId) => ({
      type: "field",
      field_id: fieldId,
      label: projectedById.get(fieldId)?.label || "Field",
    }));
  return [...legacyColumns, ...normalized];
};

export const relationshipCardColumnLayoutClasses = {
  header: "hidden grid-cols-[minmax(10rem,1.2fr)_repeat(auto-fit,minmax(8rem,1fr))_auto] gap-4 sm:grid",
  row: "grid gap-2 sm:grid-cols-[minmax(10rem,1.2fr)_repeat(auto-fit,minmax(8rem,1fr))_auto] sm:items-center sm:gap-4",
  mobileLabel: "mr-2 text-xs font-semibold text-slate-500 sm:hidden",
};

export const RECORD_PERMISSION_KEYS = [
  "can_view_records",
  "can_create_records",
  "can_edit_records",
  "can_archive_records",
  "can_export_records",
];

const dependentRecordPermissionKeys = RECORD_PERMISSION_KEYS.filter(
  (key) => key !== "can_view_records",
);

export function normalizeRecordPermissions(permission = {}) {
  const normalized = Object.fromEntries(
    RECORD_PERMISSION_KEYS.map((key) => [key, Boolean(permission[key])]),
  );
  if (dependentRecordPermissionKeys.some((key) => normalized[key])) {
    normalized.can_view_records = true;
  }
  return normalized;
}

export function applyRecordPermissionToggle(permission, key, checked) {
  const normalized = normalizeRecordPermissions(permission);
  if (!RECORD_PERMISSION_KEYS.includes(key)) return normalized;
  normalized[key] = Boolean(checked);
  if (key === "can_view_records" && !checked) {
    for (const dependentKey of dependentRecordPermissionKeys) {
      normalized[dependentKey] = false;
    }
  } else if (key !== "can_view_records" && checked) {
    normalized.can_view_records = true;
  }
  return normalized;
}
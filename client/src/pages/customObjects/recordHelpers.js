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
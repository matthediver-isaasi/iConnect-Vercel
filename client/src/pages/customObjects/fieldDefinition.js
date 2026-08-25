export const FIELD_TYPES = [
  ["text", "Text"], ["textarea", "Multi-line text"], ["email", "Email address"], ["url", "URL / website"], ["date", "Date"], ["boolean", "Yes / no"], ["number", "Number (integer)"], ["decimal", "Decimal number"], ["picklist", "Picklist (multiple selection)"], ["dropdown", "Dropdown (single selection)"], ["country", "Country (single selection)"], ["countries", "Countries (multi-select)"], ["list", "List (user-defined values)"], ["file", "File upload"],
];

export const ALLOWED_FILE_TYPES = [
  ["pdf", "PDF documents"], ["word", "Word documents"], ["excel", "Excel spreadsheets"], ["powerpoint", "PowerPoint presentations"], ["images", "Images"], ["text", "Text files"], ["zip", "Archives"], ["video", "Videos"], ["audio", "Audio files"],
];

export const normaliseOptions = (options) => (Array.isArray(options) ? options : [])
  .map((option) => typeof option === "string" ? { value: option, label: option } : option)
  .filter((option) => option?.value);

export function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

export function validateFieldDefinition(form) {
  if (!form.name?.trim() || !form.label?.trim()) return "Provide both a field label and field key.";
  if (["picklist", "dropdown"].includes(form.field_type) && !form.options.some((option) => option.value?.trim() && option.label?.trim())) {
    return "Add at least one complete option for this selection field.";
  }
  if (form.field_type === "file" && !form.allowed_file_types.length) return "Choose at least one allowed file type.";
  if (["country", "countries"].includes(form.field_type) && !form.all_countries && !form.selected_countries.length) {
    return "Choose at least one country or include all countries.";
  }
  if (Number(form.min_selections) > Number(form.max_selections) && form.max_selections !== "") return "Minimum selections cannot exceed maximum selections.";
  if (Number(form.min_length) > Number(form.max_length) && form.max_length !== "") return "Minimum length cannot exceed maximum length.";
  return null;
}

export function createFieldPayload(form, field, order) {
  const selection = ["picklist", "dropdown"].includes(form.field_type);
  const country = ["country", "countries"].includes(form.field_type);
  const allowedCountries = form.all_countries ? null : form.selected_countries;
  const validDefaultCountry = form.default_country && (!allowedCountries || allowedCountries.includes(form.default_country))
    ? form.default_country
    : null;
  const validDefaultCountries = (form.default_countries || []).filter((code) => !allowedCountries || allowedCountries.includes(code));
  return {
    ...form,
    name: field ? field.name : form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    options: selection ? form.options.filter((option) => option.value?.trim() && option.label?.trim()) : null,
    min_selections: form.field_type === "picklist" && form.min_selections !== "" ? Number(form.min_selections) : null,
    max_selections: form.field_type === "picklist" && form.max_selections !== "" ? Number(form.max_selections) : null,
    min_length: form.field_type === "textarea" && form.min_length !== "" ? Number(form.min_length) : null,
    max_length: form.field_type === "textarea" && form.max_length !== "" ? Number(form.max_length) : null,
    allowed_file_types: form.field_type === "file" ? form.allowed_file_types : null,
    public_access: form.field_type === "file" ? form.public_access : null,
    all_countries: country ? form.all_countries : null,
    selected_countries: country && !form.all_countries ? form.selected_countries : null,
    default_country: form.field_type === "country" ? validDefaultCountry : null,
    default_countries: form.field_type === "countries" ? validDefaultCountries : null,
    display_order: field?.display_order ?? order,
  };
}

export const activationReadiness = (object, activeFields) => [
  { label: "At least one active field", done: activeFields.length > 0 },
  { label: "Primary display field selected", done: !!object.primary_display_field_id && activeFields.some((field) => field.id === object.primary_display_field_id) },
];
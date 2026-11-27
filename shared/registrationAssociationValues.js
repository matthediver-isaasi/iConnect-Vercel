// An explicit values property takes precedence, including an empty selection.
// Never stringify objects or arrays: commas may be part of a genuine option.
export function registrationAssociationValues(entry = {}) {
  entry ??= {};
  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("Enter valid custom-field filter values.");
  }
  const raw = Object.hasOwn(entry, "values") ? entry.values : entry.value;
  const values = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  if (Object.hasOwn(entry, "values") && !Array.isArray(raw)) {
    throw new TypeError("Enter valid custom-field filter values.");
  }
  if (values.some(value => !["string", "boolean", "number"].includes(typeof value)
    || (typeof value === "number" && !Number.isFinite(value)))) {
    throw new TypeError("Enter valid custom-field filter values.");
  }
  if (values.some(value => String(value).length > 1000)) {
    throw new TypeError("Custom-field filter values must be at most 1000 characters.");
  }
  return [...new Set(values.map(String).filter(value => value.trim()))];
}

import { BUILTIN_MEMBER_ALIASES } from "../../../shared/memberAliases.js";

export const EMPTY_QUERY_LIST = Object.freeze([]);

export function statesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => statesEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && statesEqual(left[key], right[key]));
  }
  return false;
}

export function preserveEqualState(previous, next) {
  return statesEqual(previous, next) ? previous : next;
}

export function preferenceValuesToState(fields = EMPTY_QUERY_LIST, values = EMPTY_QUERY_LIST) {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const next = {};
  for (const preferenceValue of values) {
    const field = fieldsById.get(preferenceValue.field_id);
    if (!field) continue;
    const isMultiValue = ["picklist", "list", "countries"].includes(field.field_type);
    if (isMultiValue && typeof preferenceValue.value === "string") {
      try {
        next[field.id] = JSON.parse(preferenceValue.value);
      } catch {
        next[field.id] = preferenceValue.value;
      }
    } else {
      next[field.id] = preferenceValue.value;
    }
  }
  return next;
}

export function memberPageForPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const root = parts[0]?.toLowerCase();
  if (!BUILTIN_MEMBER_ALIASES.includes(root)) return null;
  return parts.length >= 2 ? "MemberDetail" : "MembersList";
}

export function memberTabFromSearch(search) {
  return new URLSearchParams(search).get("tab") || "overview";
}

export function searchForMemberTab(search, tab) {
  const next = new URLSearchParams(search);
  if (!tab || tab === "overview") next.delete("tab");
  else next.set("tab", tab);
  return next;
}
import { INVOICING_ADDRESS_FIELDS } from "../../../shared/invoicingAddress.js";

export const INVOICING_CORE_FIELDS = INVOICING_ADDRESS_FIELDS.map(field => ({
  id: `core:${field.key}`,
  fieldKey: field.key,
  label: field.label,
  type: "text",
  maxLength: field.maxLength,
}));

export const invoicingAddressFormValues = (record = {}) => Object.fromEntries(
  INVOICING_CORE_FIELDS.map(field => [field.fieldKey, record?.[field.fieldKey] ?? ""]),
);

// Only submit edits. In particular, opening/saving an old record must not
// introduce empty new columns before its database migration is installed.
export const invoicingAddressChanges = (draft, record) => Object.fromEntries(
  INVOICING_CORE_FIELDS
    .filter(field => (draft?.[field.fieldKey] ?? "") !== (record?.[field.fieldKey] ?? ""))
    .map(field => [field.fieldKey, draft[field.fieldKey]]),
);

export function withInvoicingAddressChanges(draft, record) {
  const core = { ...draft };
  for (const field of INVOICING_CORE_FIELDS) delete core[field.fieldKey];
  return { ...core, ...invoicingAddressChanges(draft, record) };
}

export const DEFAULT_INVOICING_CARD = {
  id: "card-invoicing-address",
  title: "Invoicing Address",
  columns: 2,
  fields: INVOICING_CORE_FIELDS.map((field, index) => ({
    id: field.id, type: "core", fieldKey: field.fieldKey, columnIndex: index % 2,
  })),
};

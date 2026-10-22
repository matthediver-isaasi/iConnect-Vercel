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

// Structured addresses belong exclusively to the protected address endpoint.
// Keep the legacy free-text invoicing_address and invoicing_email untouched.
export function withoutInvoicingAddress(draft) {
  const core = { ...draft };
  for (const field of INVOICING_CORE_FIELDS) delete core[field.fieldKey];
  return core;
}

export const isInvoicingAddressField = key => INVOICING_CORE_FIELDS.some(field => field.fieldKey === key);

// Retain the created owner across an address failure. Reusing this reference on
// Save retries prevents a partially successful create from producing duplicates.
export async function saveNewInvoicingAddressOwner({ address, createdOwnerRef, core, createOwner, updateOwner }) {
  address.assertCurrent();
  if (createdOwnerRef.current && createdOwnerRef.current.scopeKey !== address.scopeKey) {
    throw new Error("An organisation was already created before your session changed. Reopen that organisation to finish saving; do not create another.");
  }
  let owner = createdOwnerRef.current?.scopeKey === address.scopeKey
    ? createdOwnerRef.current.organization : null;
  if (!owner) {
    owner = await createOwner(withoutInvoicingAddress(core));
    createdOwnerRef.current = { scopeKey: address.scopeKey, organization: owner };
  } else {
    await updateOwner(owner.id, withoutInvoicingAddress(core));
  }
  await address.save(owner.id);
  return owner;
}

export const DEFAULT_INVOICING_CARD = {
  id: "card-invoicing-address",
  title: "Invoicing Address",
  columns: 2,
  fields: INVOICING_CORE_FIELDS.map((field, index) => ({
    id: field.id, type: "core", fieldKey: field.fieldKey, columnIndex: index % 2,
  })),
};

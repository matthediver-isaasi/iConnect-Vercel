import { ORG_PUBLICATION_FIELDS } from "../../../../shared/organisationDirectoryCore.js";
import { DirectoryContactValue } from "@/components/directory/DirectoryContactValue";

export function organisationDirectoryCoreValue(organization, key) {
  const field = ORG_PUBLICATION_FIELDS.find(item => item.key === key);
  const value = field && organization?.[field.column];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Rows consume server-projected values, not unrestricted profile records. */
export default function OrganisationDirectoryCoreRow({ organization, fieldKey }) {
  const field = ORG_PUBLICATION_FIELDS.find(item => item.key === fieldKey);
  const value = organisationDirectoryCoreValue(organization, fieldKey);
  if (!field || value === null) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4" data-testid={`directory-core-${fieldKey}`}>
      <span className="text-sm text-slate-600 break-words">{field.label}</span>
      <div className="min-w-0 text-sm font-medium text-slate-900 text-left break-words whitespace-pre-wrap">
        <DirectoryContactValue field={field} value={value}>{value}</DirectoryContactValue>
      </div>
    </div>
  );
}

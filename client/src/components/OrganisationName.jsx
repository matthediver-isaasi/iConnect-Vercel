import { AlertTriangle } from "lucide-react";

// Presentation only: keep the original name intact for records that have one.
export default function OrganisationName({ name }) {
  if (typeof name === "string" && name.trim()) return name;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-sm font-medium text-amber-800">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Name missing
    </span>
  );
}

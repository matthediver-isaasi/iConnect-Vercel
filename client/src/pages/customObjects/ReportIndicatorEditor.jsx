import React, { useState } from "react";
import { ReportRelationshipFilters } from "./ReportRelationshipFilters";

export function ReportIndicatorEditor({ column, onChange, ...props }) {
  const [open, setOpen] = useState(() => Array.isArray(column.conditions) && !column.conditions.length);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">Edit matching conditions</summary>
    <div className="mt-3">
      <ReportRelationshipFilters {...props} indicator
        filters={[{ path: column.path, conditions: column.conditions, mode: "any" }]}
        onChange={(next) => onChange({ path: next[0].path, conditions: next[0].conditions })} />
    </div>
  </details>;
}

import React from "react";
import { Loader2 } from "lucide-react";

// The live region sits outside the busy/inert content so updates are announced
// immediately, rather than deferred until the records finish loading.
export function RelatedRecordsLoadingSurface({ active, enabled = true, children }) {
  if (!enabled) return children;
  return (
    <div className="relative isolate min-h-[180px] min-w-0 max-w-full" data-related-records-surface>
      <div
        aria-busy={active ? "true" : undefined}
        inert={active ? "" : undefined}
        aria-hidden={active ? "true" : undefined}
        className={active ? "pointer-events-none select-none" : undefined}
        data-related-records-content
      >
        {children}
      </div>
      {active && (
        <div className="absolute inset-0 z-10 flex cursor-wait items-center justify-center bg-white/60 p-4 backdrop-blur-[2px]" data-testid="related-records-loading">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex max-w-full flex-col items-center rounded-lg bg-white/95 px-4 py-3 text-center text-sm font-medium text-slate-700 shadow-sm">
            <Loader2 aria-hidden="true" className="mb-2 h-6 w-6 animate-spin text-blue-600 motion-reduce:animate-none" />
            <span>Loading records…</span>
          </div>
        </div>
      )}
    </div>
  );
}
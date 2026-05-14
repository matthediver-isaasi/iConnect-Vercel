import React from "react";
import { normalizeCanvasDesign } from "@/lib/canvasDesign";

// Phase 1 public renderer stub for Canvas Builder pages.
// Canvas pages have a `canvas_design` JSON document but no block types are
// implemented yet, so we render an empty placeholder. Subsequent phases
// will hydrate this with section/block components.
export default function CanvasPageRenderer({ page }) {
  const design = normalizeCanvasDesign(page?.canvas_design);
  const hasSections = design.root.sections.length > 0;

  return (
    <div
      className="w-full min-h-screen"
      data-testid={`canvas-page-${page?.slug || ''}`}
      data-canvas-version={design.version}
    >
      {!hasSections && (
        <div
          className="min-h-[40vh] flex items-center justify-center"
          data-testid="canvas-page-empty"
        >
          <div className="text-center px-6">
            <p className="text-slate-600">
              This page is currently being built. Please check back soon.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

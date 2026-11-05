import React, { useCallback, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Eye, Monitor, Save, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import CanvasBuilder from "@/components/canvas/CanvasBuilder";
import PopupModal from "@/components/popups/PopupModal";
import PopupUnsavedChangesDialog from "@/components/popups/PopupUnsavedChangesDialog";
import { usePopupUnsavedChanges } from "@/hooks/usePopupUnsavedChanges";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useCmsPopups } from "@/hooks/useCmsPopups";
import { normalizeCanvasDesign } from "@/lib/canvasDesign";
import { createCanvasFooterInitialDesignResolver } from "@/lib/canvasFooterEditorState";
import { popupDesignError, popupRequest } from "@/lib/cmsPopups";
import { popupEditorDimensions } from "@/lib/popupEditorDimensions";
import { createPageUrl } from "@/utils";

export default function CanvasPopupEditor() {
  const [params] = useSearchParams();
  const id = params.get("popupId");
  const navigate = useNavigate();
  const { isAccessReady, isFeatureExcluded } = useMemberAccess();
  const allowed = isAccessReady && !isFeatureExcluded("site-builder.popup-editor");
  const query = useCmsPopups(id, !!id && allowed, true);
  const canvas = useRef(null);
  const resolver = useRef(null);
  if (!resolver.current) resolver.current = createCanvasFooterInitialDesignResolver(normalizeCanvasDesign);
  const [breakpoint, setBreakpoint] = useState("desktop");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const popup = query.data?.popup;
  const dimensions = popupEditorDimensions(popup?.config, breakpoint);
  const initialDesign = resolver.current(popup);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const mutateRef = useRef(query.mutation.mutateAsync);
  mutateRef.current = query.mutation.mutateAsync;
  const persist = useCallback(async (design) => {
    const invalid = popupDesignError(design);
    if (invalid) { setError(invalid); throw new Error(invalid); }
    const record = popupRef.current;
    try {
      const result = await mutateRef.current({ id: record.id, revision: record.revision, design });
      // Keep revision current even if another save is requested before render.
      popupRef.current = result.popup;
      setDirty(false); setError(""); toast.success("Popup design saved");
      return result;
    } catch (failure) { setError(failure.message); throw failure; }
  }, []);
  const guard = usePopupUnsavedChanges({
    dirty, isDirty: () => canvas.current?.isDirty?.(),
    onSave: () => canvas.current?.saveNow?.(),
  });
  const leave = () => navigate(createPageUrl("PopupManagement"));
  const showPreview = async () => {
    setPreviewLoading(true);
    try {
      // Capability is verified server-side, never inferred from a URL flag.
      const result = await popupRequest(`id=${encodeURIComponent(id)}&preview=1`);
      if (!result.popup) throw new Error("Preview unavailable.");
      const design = canvas.current?.getDesign?.() || popup.design;
      const invalid = popupDesignError(design);
      if (invalid) throw new Error(invalid);
      setPreview({ ...result.popup, design });
    } catch (failure) { toast.error(failure.message); }
    finally { setPreviewLoading(false); }
  };
  if (!isAccessReady || query.isLoading) return <div className="space-y-4 p-6" aria-label="Loading popup editor"><div className="h-12 animate-pulse rounded bg-muted" /><div className="h-96 animate-pulse rounded bg-muted" /></div>;
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">Popup Editor permission required</h1><p className="mt-2 text-muted-foreground">Page Editor access does not grant popup editing.</p></div>;
  if (!id || !popup || query.isError) return <div className="p-8"><h1 className="text-xl font-semibold">{query.isError ? "Unable to load popup" : "No popup selected"}</h1><p role="alert" className="mt-2 text-muted-foreground">{query.error?.message || "Choose a popup from management."}</p><div className="mt-4 flex gap-2"><Button variant="outline" onClick={leave}>Back to popups</Button>{id && <Button onClick={() => query.refetch()}>Retry</Button>}</div></div>;
  return <div className="flex min-h-[100dvh] flex-col bg-slate-50" style={{ height: "100dvh" }}>
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
      <Button size="icon" variant="ghost" aria-label="Back to popups" onClick={leave}><ArrowLeft className="h-4 w-4" /></Button>
      <div className="mr-auto min-w-32"><h1 className="truncate text-sm font-semibold">{popup.name}{dirty && <span className="ml-2 text-xs text-amber-700">Unsaved</span>}</h1><p className="text-xs text-muted-foreground">Popup · {popup.microsite?.name || "Main site"} · {popup.status} · Revision {popup.revision}</p></div>
      {["desktop", "tablet", "mobile"].map((value) => {
        const Icon = value === "desktop" ? Monitor : value === "tablet" ? Tablet : Smartphone;
        return <Button key={value} size="icon" aria-label={`${value} canvas`} title={value} variant={breakpoint === value ? "default" : "outline"} onClick={() => setBreakpoint(value)}><Icon className="h-4 w-4" /></Button>;
      })}
      <Button variant="outline" disabled={previewLoading} onClick={showPreview}><Eye className="mr-2 h-4 w-4" />{previewLoading ? "Authorizing…" : "Preview"}</Button>
      <Button disabled={!dirty || query.mutation.isPending} onClick={() => canvas.current?.saveNow?.()}><Save className="mr-2 h-4 w-4" />{query.mutation.isPending ? "Saving…" : "Save"}</Button>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}<Button size="sm" variant="outline" onClick={() => {
      if (window.confirm("Reload the latest revision? Unsaved design changes will be lost.")) window.location.reload();
    }}>Reload latest</Button></div>}
    <div className="shrink-0 border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground" data-testid="popup-stage-dimensions">Popup mode · {breakpoint} viewport ({dimensions.viewportWidth}px) · {dimensions.contentWidth}px content · {dimensions.breakpoint} layout. Maximum height scrolls in preview. Save does not activate this popup.</div>
    <div className="min-h-0 flex-1"><CanvasBuilder ref={canvas} popupEditing initialDesign={initialDesign}
      breakpoint={dimensions.breakpoint} contentWidth={dimensions.contentWidth} onBreakpointChange={setBreakpoint} onSave={persist}
      isSaving={query.mutation.isPending} isDirty={dirty} onDirtyChange={setDirty}
      micrositeId={popup.microsite_id} /></div>
    {preview && <PopupModal popup={preview} preview open onClose={() => setPreview(null)}
      previewWidth={popupEditorDimensions(preview.config, breakpoint).modalWidth} />}
    <PopupUnsavedChangesDialog guard={guard} subject="popup design" />
  </div>;
}

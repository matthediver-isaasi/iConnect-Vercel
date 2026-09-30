import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, Monitor, Save, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CanvasBuilder from "@/components/canvas/CanvasBuilder";
import CanvasPageRenderer from "@/components/canvas/CanvasPageRenderer";
import { normalizeCanvasDesign } from "@/lib/canvasDesign";
import { createCanvasFooterInitialDesignResolver } from "@/lib/canvasFooterEditorState";
import { adminFetch } from "@/lib/adminFetch";
import { createPageUrl } from "@/utils";

async function request(url, options) {
  const res = await adminFetch(url, { credentials: "include", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Footer request failed");
  return body;
}

export default function CanvasFooterEditor() {
  const id = new URLSearchParams(window.location.search).get("footerId");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef(null);
  const initialDesignResolverRef = useRef(null);
  if (!initialDesignResolverRef.current) {
    initialDesignResolverRef.current = createCanvasFooterInitialDesignResolver(normalizeCanvasDesign);
  }
  const [breakpoint, setBreakpoint] = useState("desktop");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["canvas-footer", id],
    queryFn: () => request(`/api/admin/canvas-footers?id=${encodeURIComponent(id)}`),
    enabled: !!id,
  });
  const footer = data?.footer;
  const initialDesign = initialDesignResolverRef.current(footer);
  const save = useMutation({
    mutationFn: (design) => request(`/api/admin/canvas-footers?id=${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ design }),
    }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["canvas-footer", id] });
      queryClient.invalidateQueries({ queryKey: ["canvas-footers"] });
      toast.success("Footer saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const persistDesign = useCallback(
    (design) => save.mutateAsync(design),
    [save.mutateAsync],
  );
  const doSave = useCallback(
    () => canvasRef.current?.saveNow?.(),
    [],
  );
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (!id) return <div className="p-8">No footer selected.</div>;
  if (isLoading) return <div className="p-8">Loading footer…</div>;
  if (!footer) return <div className="p-8">Footer not found.</div>;
  const previewDesign = canvasRef.current?.getDesign?.() || footer.design;
  return <div className="h-screen flex flex-col bg-slate-50">
    <header className="h-14 border-b bg-white px-3 flex items-center gap-2 shrink-0">
      <Button size="icon" variant="ghost" onClick={() => navigate(createPageUrl("CanvasFooterManagement"))}><ArrowLeft className="w-4 h-4" /></Button>
      <div className="font-semibold truncate mr-auto">{footer.name}<span className="ml-2 text-xs font-normal text-slate-500">Reusable footer · {footer.microsite?.name || "Main site"}</span></div>
      {["desktop", "tablet", "mobile"].map((bp) => {
        const Icon = bp === "desktop" ? Monitor : bp === "tablet" ? Tablet : Smartphone;
        return <Button key={bp} size="icon" variant={breakpoint === bp ? "default" : "outline"} onClick={() => setBreakpoint(bp)} title={bp}><Icon className="w-4 h-4" /></Button>;
      })}
      <Button variant="outline" onClick={() => setPreview(true)}><Eye className="w-4 h-4 mr-2" />Preview</Button>
      <Button onClick={doSave} disabled={!dirty || save.isPending}><Save className="w-4 h-4 mr-2" />{save.isPending ? "Saving…" : "Save"}</Button>
    </header>
    <div className="flex-1 min-h-0">
      <CanvasBuilder ref={canvasRef} initialDesign={initialDesign} breakpoint={breakpoint} onBreakpointChange={setBreakpoint} onSave={persistDesign} isSaving={save.isPending} isDirty={dirty} onDirtyChange={setDirty} micrositeId={footer.microsite_id} />
    </div>
    <Dialog open={preview} onOpenChange={setPreview}><DialogContent className="max-w-[95vw] w-[95vw]"><DialogHeader><DialogTitle>Footer preview — {breakpoint}</DialogTitle></DialogHeader><div className="overflow-auto border bg-white"><CanvasPageRenderer embedded forceBreakpoint={breakpoint} micrositeId={footer.microsite_id} page={{ id: footer.id, canvas_design: previewDesign }} /></div></DialogContent></Dialog>
  </div>;
}
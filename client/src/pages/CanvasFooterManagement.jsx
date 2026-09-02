import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Copy, FileEdit, Loader2, PanelBottom, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CanvasPageRenderer from "@/components/canvas/CanvasPageRenderer";
import { createEmptyCanvasDesign } from "@/lib/canvasDesign";
import { MAIN_SITE_SCOPE, buildCanvasFooterCreatePayload, canvasFooterScopeId } from "@/lib/canvasFooterScope";
import { adminFetch } from "@/lib/adminFetch";
import { createPageUrl } from "@/utils";

async function request(url, options) {
  const res = await adminFetch(url, { credentials: "include", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Footer request failed");
  return body;
}

export default function CanvasFooterManagement() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState(MAIN_SITE_SCOPE);
  const { data, isLoading } = useQuery({
    queryKey: ["canvas-footers"],
    queryFn: () => request("/api/admin/canvas-footers"),
  });
  const footers = data?.footers || [];
  const microsites = data?.microsites || [];

  const mutation = useMutation({
    mutationFn: async ({ kind, footer }) => {
      if (kind === "delete") return request(`/api/admin/canvas-footers?id=${encodeURIComponent(footer.id)}`, { method: "DELETE" });
      if (kind === "rename") return request(`/api/admin/canvas-footers?id=${encodeURIComponent(footer.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      return request("/api/admin/canvas-footers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCanvasFooterCreatePayload({
          name,
          design: kind === "duplicate" ? footer.design : createEmptyCanvasDesign(),
          siteId,
          assignToMicrosite: kind === "create",
        })),
      });
    },
    onSuccess: (body, vars) => {
      queryClient.invalidateQueries({ queryKey: ["canvas-footers"] });
      queryClient.invalidateQueries({ queryKey: ["admin-microsites"] });
      setDialog(null); setName(""); setSiteId(MAIN_SITE_SCOPE);
      toast.success(vars.kind === "delete" ? "Footer deleted" : "Footer saved");
      if (vars.kind === "create" || vars.kind === "duplicate") {
        navigate(`${createPageUrl("CanvasFooterEditor")}?footerId=${body.footer.id}`);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const open = (kind, footer = null) => {
    setDialog({ kind, footer });
    setName(kind === "duplicate" ? `${footer.name} copy` : (footer?.name || ""));
    setSiteId(kind === "duplicate" ? canvasFooterScopeId(footer) : MAIN_SITE_SCOPE);
  };

  return <div className="min-h-screen p-4 md:p-8 bg-slate-50">
    <div className="flex items-center justify-between gap-3 mb-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Canvas footers</h1>
        <p className="text-slate-600">Design reusable responsive footers without creating a public page.</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => navigate(createPageUrl("IEditPageManagement"))}><FileEdit className="w-4 h-4 mr-2" />Pages</Button>
        <Button onClick={() => open("create")}><Plus className="w-4 h-4 mr-2" />New footer</Button>
      </div>
    </div>
    {isLoading ? <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div> :
      footers.length === 0 ? <Card><CardContent className="py-16 text-center text-slate-600"><PanelBottom className="w-10 h-10 mx-auto mb-3" />No Canvas footers yet.</CardContent></Card> :
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">{footers.map((footer) =>
        <Card key={footer.id} data-testid={`canvas-footer-${footer.id}`}>
          <CardHeader><CardTitle className="flex items-center justify-between gap-2"><span className="truncate">{footer.name}</span><PanelBottom className="w-5 h-5 text-slate-400" /></CardTitle>
            <Badge variant="secondary" className="w-fit">{footer.microsite?.name || "Main site"}</Badge>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-hidden bg-white h-40 mb-4 pointer-events-none">
              <div style={{ transform: "scale(.25)", transformOrigin: "top left", width: "400%" }}>
                <CanvasPageRenderer embedded forceBreakpoint="desktop" micrositeId={footer.microsite_id} page={{ id: footer.id, canvas_design: footer.design }} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => navigate(`${createPageUrl("CanvasFooterEditor")}?footerId=${footer.id}`)}><Pencil className="w-4 h-4 mr-1" />Edit</Button>
              <Button size="sm" variant="outline" onClick={() => open("rename", footer)}>Rename</Button>
              <Button size="sm" variant="outline" onClick={() => open("duplicate", footer)}><Copy className="w-4 h-4" /></Button>
              <Button size="sm" variant="outline" onClick={() => open("delete", footer)}><Trash2 className="w-4 h-4 text-red-600" /></Button>
            </div>
          </CardContent>
        </Card>)}</div>}
    <Dialog open={!!dialog} onOpenChange={(v) => !v && setDialog(null)}>
      <DialogContent><DialogHeader><DialogTitle>{dialog?.kind === "delete" ? "Delete footer?" : dialog?.kind === "rename" ? "Rename footer" : dialog?.kind === "duplicate" ? "Duplicate footer" : "Create footer"}</DialogTitle></DialogHeader>
        {dialog?.kind === "delete" ? <p className="text-sm text-slate-600">Assigned footers cannot be deleted. This action cannot be undone.</p> :
          <div className="space-y-4">
            <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
            {(dialog?.kind === "create" || dialog?.kind === "duplicate") && <div className="space-y-2">
              <Label>Site</Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger data-testid="select-canvas-footer-site"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={MAIN_SITE_SCOPE}>Main site</SelectItem>
                  {microsites.map((microsite) => <SelectItem key={microsite.id} value={String(microsite.id)}>{microsite.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                {dialog?.kind === "create" && siteId !== MAIN_SITE_SCOPE
                  ? "This footer will use the microsite's typography, CTA styles and palette, and will become its active Canvas footer."
                  : "The selected site controls which typography, CTA styles and palette are available in Canvas Builder."}
              </p>
            </div>}
          </div>}
        <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={mutation.isPending || (dialog?.kind !== "delete" && !name.trim())} variant={dialog?.kind === "delete" ? "destructive" : "default"} onClick={() => mutation.mutate(dialog)}>{mutation.isPending ? "Saving…" : "Confirm"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
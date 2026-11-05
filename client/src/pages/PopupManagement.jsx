import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, Eye, FileEdit, Plus, Settings2, Trash2, PanelsTopLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useCmsPopups, usePopupDiscovery } from "@/hooks/useCmsPopups";
import { popupRequest } from "@/lib/cmsPopups";
import PopupSettings, { PopupSelect } from "@/components/popups/PopupSettings";
import PopupModal from "@/components/popups/PopupModal";
import PopupUnsavedChangesDialog from "@/components/popups/PopupUnsavedChangesDialog";
import { usePopupUnsavedChanges } from "@/hooks/usePopupUnsavedChanges";
import { createPageUrl } from "@/utils";

export default function PopupManagement() {
  const navigate = useNavigate();
  const { isAccessReady, isFeatureExcluded } = useMemberAccess();
  const allowed = isAccessReady && !isFeatureExcluded("site-builder.popups");
  const canDesign = isAccessReady && !isFeatureExcluded("site-builder.popup-editor");
  const query = useCmsPopups(null, allowed);
  const discovery = usePopupDiscovery(allowed);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [site, setSite] = useState("all");
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("main");
  const [preview, setPreview] = useState(null);
  const [dirty, setDirty] = useState(false);
  const settings = useRef(null);
  const guard = usePopupUnsavedChanges({ dirty, onSave: () => settings.current?.save?.() });
  const [previewLoading, setPreviewLoading] = useState(null);
  const popups = query.data?.popups || [];
  const microsites = discovery.data?.microsites || [];
  const edit = (popup) => guard.request(() => { setDirty(false); setDialog({ kind: "settings", popup }); });
  const close = () => {
    if (query.mutation.isPending) return;
    guard.request(() => { setDialog(null); setDirty(false); });
  };
  const perform = async (popup, kind) => {
    if (!canDesign) { toast.error("Popup Editor permission is required to change popups."); return; }
    try {
      const result = await query.mutation.mutateAsync({ id: popup.id, revision: popup.revision, confirmed: true,
        ...(kind === "delete" ? { method: "DELETE" } : kind === "activate" ? { status: "active" } : { method: "POST", action: kind }) });
      toast.success(kind === "delete" ? "Popup deleted" : kind === "duplicate" ? "Draft copy created" : "Popup updated");
      setDialog(null);
      if (kind === "duplicate" && result.popup) edit(result.popup);
    } catch { /* mutation shows a visible error */ }
  };
  const showPreview = async (popup) => {
    setPreviewLoading(popup.id);
    try {
      const data = await popupRequest(`id=${encodeURIComponent(popup.id)}&preview=1`);
      if (data.popup) setPreview(data.popup);
    } catch (error) { toast.error(error.message); }
    finally { setPreviewLoading(null); }
  };
  if (!isAccessReady) return <div className="m-8 h-32 animate-pulse rounded-lg bg-muted" aria-label="Checking access" />;
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">Popup management is restricted</h1><p className="mt-2 text-muted-foreground">Ask your administrator for Site Builder · Popups access.</p></div>;
  return <div className="min-h-[100dvh] bg-slate-50 p-4 md:p-8">
    <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div><p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">Site Builder</p><h1 className="text-3xl font-bold text-slate-900">Canvas popups</h1><p className="mt-2 text-sm text-slate-600">Reusable announcements. The right page, audience and moment.</p></div>
      <div className="flex gap-2"><Button variant="outline" onClick={() => navigate(createPageUrl("IEditPageManagement"))}><FileEdit className="mr-2 h-4 w-4" />Pages</Button><Button disabled={!canDesign} onClick={() => { setName(""); setScope("main"); setDialog({ kind: "create" }); }}><Plus className="mr-2 h-4 w-4" />New popup</Button></div>
    </header>
    {!canDesign && <p className="mb-4 text-sm text-muted-foreground">Read-only access. Popup Editor permission is required to create, preview or change popups.</p>}
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <label className="min-w-48 flex-1 text-sm font-medium">Search<Input className="mt-1.5" placeholder="Find a popup…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <PopupSelect label="Status" value={status} onChange={setStatus} options={[["all", "All statuses"], ...["draft", "active", "paused", "archived"].map((value) => [value, value[0].toUpperCase() + value.slice(1)])]} />
      <PopupSelect label="Site" value={site} onChange={setSite} options={[["all", "All sites"], ["main", "Main site"], ...microsites.map((item) => [item.id, item.name])]} />
    </div>
    {(query.isError || discovery.isError) && <Card className="mb-4 border-destructive"><CardContent className="flex items-center justify-between gap-4 p-5"><div role="alert"><h2 className="font-medium">Popups could not be loaded</h2><p className="text-sm text-muted-foreground">{query.error?.message || discovery.error?.message}</p></div><Button variant="outline" onClick={() => { query.refetch(); discovery.refetch(); }}>Retry</Button></CardContent></Card>}
    {query.isLoading ? <div className="space-y-3" aria-label="Loading popups">{[1, 2, 3, 4].map((i) => <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />)}</div> :
      <Card><CardContent className="p-0"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead className="pl-5">Popup</TableHead><TableHead>Status</TableHead><TableHead>Eligibility</TableHead><TableHead>Trigger</TableHead><TableHead className="text-right pr-5">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{popups.filter((popup) => popup.name.toLowerCase().includes(search.toLowerCase()) && (status === "all" || popup.status === status) && (site === "all" || (popup.microsite_id || "main") === site)).map((popup) => <TableRow key={popup.id}>
          <TableCell className="pl-5"><button className="text-left font-semibold hover:underline" onClick={() => edit(popup)}>{popup.name}</button><p className="mt-1 text-xs text-muted-foreground">{microsites.find((item) => item.id === popup.microsite_id)?.name || "Main site"} · Revision {popup.revision}</p></TableCell>
          <TableCell><Badge variant={popup.status === "active" ? "default" : "secondary"}>{popup.status}</Badge>{popup.status === "active" && popup.starts_at && Date.parse(popup.starts_at) > Date.now() && <p className="mt-1 text-xs text-muted-foreground">Scheduled</p>}{popup.ends_at && Date.parse(popup.ends_at) <= Date.now() && <p className="mt-1 text-xs text-muted-foreground">Schedule ended</p>}</TableCell>
          <TableCell><span className="text-sm">{popup.config?.visibility || "public"}</span><p className="mt-1 text-xs text-muted-foreground">{popup.config?.all_pages ? "All scoped pages" : `${popup.config?.page_ids?.length || 0} pages`} · {popup.config?.groups?.length || 0} rule groups</p></TableCell>
          <TableCell className="text-sm">{popup.config?.trigger?.type?.replaceAll("_", " ") || "immediate"}<p className="mt-1 text-xs text-muted-foreground">Priority {popup.config?.priority || 0}</p></TableCell>
          <TableCell><div className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="icon" title="Settings" aria-label={`Settings for ${popup.name}`} onClick={() => edit(popup)}><Settings2 className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" title="Preview" aria-label={`Preview ${popup.name}`} disabled={!canDesign || !!previewLoading} onClick={() => showPreview(popup)}><Eye className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" title="Duplicate" aria-label={`Duplicate ${popup.name}`} disabled={!canDesign || query.mutation.isPending} onClick={() => perform(popup, "duplicate")}><Copy className="h-4 w-4" /></Button>
            {(popup.status === "draft" || popup.status === "paused") && <Button size="sm" variant="outline" disabled={!canDesign || query.mutation.isPending} onClick={() => setDialog({ kind: "activate", popup })}>Activate</Button>}
            {popup.status === "active" && <Button size="sm" variant="outline" disabled={!canDesign || query.mutation.isPending} onClick={() => perform(popup, "pause")}>Pause</Button>}
            <PopupSelect label="" value="" disabled={!canDesign || query.mutation.isPending} onChange={(kind) => kind && setDialog({ kind, popup })} options={[["", "More…"], [popup.status === "archived" ? "restore" : "archive", popup.status === "archived" ? "Restore draft" : "Archive"], ["reset-dismissals", "Reset dismissals"], ["delete", "Delete"]]} />
          </div></TableCell>
        </TableRow>)}</TableBody></Table></div>
        {!popups.some((popup) => popup.name.toLowerCase().includes(search.toLowerCase()) && (status === "all" || popup.status === status) && (site === "all" || (popup.microsite_id || "main") === site)) && <div className="px-5 py-16 text-center"><PanelsTopLeft className="mx-auto mb-4 h-9 w-9 text-slate-400" /><h2 className="font-semibold">{popups.length ? "No matching popups" : "Your first announcement starts here"}</h2><p className="mt-2 text-sm text-muted-foreground">{popups.length ? "Try a different search or filter." : "Create a draft, choose where it belongs, then design it in Canvas."}</p></div>}
      </CardContent></Card>}
    <p className="mt-4 text-xs text-muted-foreground">Lifecycle and schedule are independent. Archiving preserves visitor choices; duplicating creates a new draft without visitor state.</p>
    <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) close(); }}><DialogContent className={dialog?.kind === "settings" ? "flex max-h-[90dvh] w-[calc(100vw-24px)] max-w-4xl flex-col" : ""}>
      <DialogHeader><DialogTitle>{dialog?.kind === "create" ? "Create popup" : dialog?.kind === "settings" ? dialog.popup.name : `${({ "reset-dismissals": "Reset dismissals", delete: "Delete popup", activate: "Activate popup", archive: "Archive popup", restore: "Restore popup" })[dialog?.kind] || "Update popup"}?`}</DialogTitle><DialogDescription>{dialog?.kind === "create" ? "Start as a draft within a fixed typography and page scope." : dialog?.kind === "settings" ? "Configure delivery without changing visitor opt-outs." : dialog?.kind === "reset-dismissals" ? "This creates a new dismissal generation. Visitors who opted out may see this popup again." : dialog?.kind === "delete" ? "The popup and its visitor state will be permanently removed. This cannot be undone." : dialog?.kind === "activate" ? "Delivery begins when the schedule, page assignment and audience qualify. Save design and settings before activation." : "Visitor opt-outs are preserved."}</DialogDescription></DialogHeader>
      {dialog?.kind === "settings" ? discovery.data ? <PopupSettings ref={settings} key={`${dialog.popup.id}|${discovery.data.timezone}`} popup={dialog.popup} discovery={discovery.data} saving={query.mutation.isPending} canDesign={canDesign} onDirtyChange={setDirty} onSave={async (body) => {
        const result = await query.mutation.mutateAsync(body);
        toast.success("Popup settings saved");
        setDirty(false); setDialog(null); return result;
      }} /> : <div className="space-y-3 py-5">{discovery.isError ? <div role="alert">Unable to load site, timezone and targeting metadata.<Button className="ml-3" variant="outline" onClick={() => discovery.refetch()}>Retry</Button></div> : <div className="h-40 animate-pulse rounded bg-muted" aria-label="Loading popup metadata" />}</div> : dialog?.kind === "create" ? <form onSubmit={async (e) => {
        e.preventDefault();
        try {
          const result = await query.mutation.mutateAsync({ method: "POST", name: name.trim(), microsite_id: scope === "main" ? null : scope });
          if (result.popup) edit(result.popup);
        } catch { /* keep form for retry */ }
      }} className="space-y-5">
        <label className="block text-sm font-medium">Internal name<Input className="mt-2" autoFocus required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <PopupSelect label="Site scope" value={scope} onChange={setScope} disabled={!discovery.data} options={[["main", "Main site"], ...microsites.map((item) => [item.id, item.name])]} />
        <DialogFooter><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={!name.trim() || query.mutation.isPending || !discovery.data}>{query.mutation.isPending ? "Creating…" : "Create draft"}</Button></DialogFooter>
      </form> : <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={query.mutation.isPending} variant={dialog?.kind === "delete" ? "destructive" : "default"} onClick={() => perform(dialog.popup, dialog.kind)}>{dialog?.kind === "delete" && <Trash2 className="mr-2 h-4 w-4" />}{query.mutation.isPending ? "Updating…" : "Confirm"}</Button></DialogFooter>}
    </DialogContent></Dialog>
    {preview && <PopupModal popup={preview} preview open onClose={() => setPreview(null)} />}
    <PopupUnsavedChangesDialog guard={guard} subject="popup settings" />
  </div>;
}

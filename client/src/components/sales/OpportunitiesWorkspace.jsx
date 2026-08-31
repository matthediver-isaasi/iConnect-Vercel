import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Columns3,
  FileText, LayoutList, Loader2, Plus, RefreshCw, Search, Trash2,
  Upload, UserRound,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { getOpportunityUiCapabilities } from "@/lib/opportunityCapabilities";
import { normalizeOpportunityDetail } from "@/lib/opportunityDetail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";

const FALLBACK_STAGES = [];
const opportunityValue = (value) => value?.value ?? (value?.value_minor == null ? 0 : Number(value.value_minor) / 100);
const money = (value, currency = "GBP") => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(value || 0)); }
  catch { return `${currency} ${Number(value || 0).toLocaleString()}`; }
};
const date = (value) => value ? new Date(value).toLocaleDateString() : "—";
const arr = (value) => Array.isArray(value) ? value : value?.data || value?.items || [];
const idOf = (value) => value?.id || value?._id;
const nameOf = (value) => value?.name || value?.title || value?.display_name || [value?.first_name, value?.last_name].filter(Boolean).join(" ") || "Unknown";

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function useDelayed(value, delay = 250) {
  const [result, setResult] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setResult(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return result;
}

function LossReasonDialog({ open, onOpenChange, reasons, onConfirm }) {
  const [reasonId, setReasonId] = useState("");
  useEffect(() => { if (open) setReasonId(""); }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md">
    <DialogHeader><DialogTitle>Why was this opportunity lost?</DialogTitle><DialogDescription>Select a configured loss reason before moving it to a lost stage.</DialogDescription></DialogHeader>
    <Select value={reasonId} onValueChange={setReasonId}><SelectTrigger><SelectValue placeholder="Select loss reason" /></SelectTrigger><SelectContent>{reasons.map((reason) => <SelectItem key={idOf(reason)} value={idOf(reason)}>{nameOf(reason)}</SelectItem>)}</SelectContent></Select>
    {!reasons.length && <p className="text-sm text-rose-700">No loss reasons are configured. Add one in Sales settings first.</p>}
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!reasonId} onClick={() => onConfirm(reasonId)}>Confirm lost</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function OpportunityDialog({ open, onOpenChange, stages, onCreated }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", organizationId: "", contactId: "", contactRole: "Primary contact", stageId: "", value: "", currency: "GBP", priority: "medium", expectedCloseDate: "" });
  const [organizations, setOrganizations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoadingOptions(true);
    base44.entities.Organization.list({ sort: { name: "asc" } })
      .then((items) => setOrganizations(arr(items))).catch(() => setOrganizations([]))
      .finally(() => setLoadingOptions(false));
  }, [open]);
  useEffect(() => {
    setContacts([]);
    setForm((old) => ({ ...old, contactId: "" }));
    if (!form.organizationId) return;
    fetch(`/api/members/search?q=&limit=100&organization_id=${encodeURIComponent(form.organizationId)}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject()).then((data) => setContacts(arr(data))).catch(() => setContacts([]));
  }, [form.organizationId]);
  useEffect(() => {
    if (open && !form.stageId && stages[0]) setForm((old) => ({ ...old, stageId: idOf(stages[0]) }));
  }, [open, stages, form.stageId]);
  const create = useMutation({
    mutationFn: () => request("/api/opportunities", { method: "POST", body: JSON.stringify({
      ...form, value: form.value === "" ? null : Number(form.value),
      valueMinor: form.value === "" ? null : Math.round(Number(form.value) * 100),
      organization_id: form.organizationId, contactId: form.contactId || null, contactRole: form.contactRole, role: form.contactRole, stage_id: form.stageId, priority: form.priority,
      expected_close_date: form.expectedCloseDate || null,
    }) }),
    onSuccess: (result) => {
      toast({ title: "Opportunity created" });
      onOpenChange(false);
      setForm({ name: "", organizationId: "", contactId: "", contactRole: "Primary contact", stageId: idOf(stages[0]) || "", value: "", currency: "GBP", priority: "medium", expectedCloseDate: "" });
      onCreated(result?.opportunity || result);
    },
    onError: (error) => toast({ title: "Could not create opportunity", description: error.message, variant: "destructive" }),
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl">
    <DialogHeader><DialogTitle>New opportunity</DialogTitle><DialogDescription>Create an opportunity against an existing organisation and, optionally, one of its contacts.</DialogDescription></DialogHeader>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Label htmlFor="opp-name">Name</Label><Input id="opp-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div><Label>Organisation *</Label><Select value={form.organizationId} onValueChange={(organizationId) => setForm({ ...form, organizationId })}><SelectTrigger><SelectValue placeholder={loadingOptions ? "Loading…" : "Select organisation"} /></SelectTrigger><SelectContent>{organizations.map((item) => <SelectItem key={idOf(item)} value={idOf(item)}>{nameOf(item)}</SelectItem>)}</SelectContent></Select></div>
      <div><Label>Primary contact</Label><Select value={form.contactId || "none"} onValueChange={(contactId) => setForm({ ...form, contactId: contactId === "none" ? "" : contactId })}><SelectTrigger><SelectValue placeholder="Select contact" /></SelectTrigger><SelectContent><SelectItem value="none">No primary contact</SelectItem>{contacts.map((item) => <SelectItem key={idOf(item)} value={idOf(item)}>{nameOf(item)}</SelectItem>)}</SelectContent></Select></div>
      <div><Label>Contact role</Label><Input value={form.contactRole} onChange={(e) => setForm({ ...form, contactRole: e.target.value })} disabled={!form.contactId} /></div>
      <div><Label>Stage</Label><Select value={form.stageId} onValueChange={(stageId) => setForm({ ...form, stageId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{stages.map((stage) => <SelectItem key={idOf(stage)} value={idOf(stage)}>{nameOf(stage)}</SelectItem>)}</SelectContent></Select></div>
      <div><Label>Priority</Label><Select value={form.priority} onValueChange={(priority) => setForm({ ...form, priority })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["low", "medium", "high", "urgent"].map((p) => <SelectItem key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</SelectItem>)}</SelectContent></Select></div>
      <div><Label>Value</Label><Input type="number" min="0" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
      <div><Label>Expected close</Label><Input type="date" value={form.expectedCloseDate} onChange={(e) => setForm({ ...form, expectedCloseDate: e.target.value })} /></div>
    </div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!form.name.trim() || !form.organizationId || !form.stageId || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function OpportunityCard({ opportunity, onMove, stages }) {
  const navigate = useNavigate();
  const stageId = opportunity.stage_id || opportunity.stageId || idOf(opportunity.stage);
  return <Card draggable onDragStart={(e) => e.dataTransfer.setData("text/opportunity-id", idOf(opportunity))} className="cursor-pointer hover:border-blue-300 hover:shadow-sm" onClick={() => navigate(`/sales/opportunities/${idOf(opportunity)}`)}>
    <CardContent className="p-4">
      <div className="flex items-start justify-between gap-2"><p className="font-semibold text-slate-900">{nameOf(opportunity)}</p><Badge variant="outline" className="capitalize">{opportunity.priority || "medium"}</Badge></div>
      <p className="mt-1 truncate text-sm text-slate-500">{nameOf(opportunity.organization || { name: opportunity.organization_name })}</p>
      <p className="mt-3 text-lg font-semibold">{money(opportunityValue(opportunity), opportunity.currency)}</p>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>{opportunity.probability ?? opportunity.stage?.probability ?? stages.find((s) => idOf(s) === stageId)?.probability ?? 0}%</span><span>{date(opportunity.expected_close_date || opportunity.expectedCloseDate)}</span></div>
    </CardContent>
  </Card>;
}

function OpportunitiesList({ destination }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("all");
  const [mine, setMine] = useState(false);
  const [view, setView] = useState(destination === "pipeline" ? "kanban" : "table");
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingLossMove, setPendingLossMove] = useState(null);
  const { memberInfo } = useMemberAccess();
  const debouncedSearch = useDelayed(search);
  useEffect(() => setView(destination === "pipeline" ? "kanban" : "table"), [destination]);
  useEffect(() => setPage(1), [debouncedSearch, stageId, mine, view]);
  const query = useQuery({
    queryKey: ["opportunities", page, debouncedSearch, stageId, mine, view],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: view === "kanban" ? "100" : "20", search: debouncedSearch, view });
      if (stageId !== "all") params.set("stageId", stageId);
      if (mine) { params.set("my", "true"); params.set("mine", "true"); }
      return request(`/api/opportunities?${params}`);
    },
    keepPreviousData: true,
  });
  const stageQuery = useQuery({
    queryKey: ["opportunity-settings", "stages"],
    queryFn: () => request("/api/opportunity-settings?resource=stages"),
  });
  const lossReasonsQuery = useQuery({ queryKey: ["opportunity-settings", "loss-reasons"], queryFn: () => request("/api/opportunity-settings?resource=loss-reasons") });
  const normalized = query.data || {};
  const opportunities = arr(normalized);
  const stages = arr(normalized.stages).length ? arr(normalized.stages) : (arr(stageQuery.data).length ? arr(stageQuery.data) : FALLBACK_STAGES);
  const total = Number(normalized.total ?? opportunities.length);
  const pageSize = Number(normalized.pageSize || 20);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const move = useMutation({
    mutationFn: ({ opportunity, targetStageId, lossReasonId }) => request(`/api/opportunities/${idOf(opportunity)}`, { method: "PATCH", body: JSON.stringify({ action: "move", stageId: targetStageId, lossReasonId, expectedVersion: opportunity.version }) }),
    onMutate: async ({ opportunity, targetStageId }) => {
      await qc.cancelQueries({ queryKey: ["opportunities"] });
      const snapshots = qc.getQueriesData({ queryKey: ["opportunities"] });
      qc.setQueriesData({ queryKey: ["opportunities"] }, (old) => {
        if (!old) return old;
        const data = arr(old).map((item) => idOf(item) === idOf(opportunity) ? { ...item, stage_id: targetStageId } : item);
        return Array.isArray(old) ? data : { ...old, data };
      });
      return { snapshots };
    },
    onError: (error, _, context) => {
      context?.snapshots?.forEach(([key, value]) => qc.setQueryData(key, value));
      toast({ title: error.status === 409 || error.status === 412 ? "Opportunity changed elsewhere" : "Could not move opportunity", description: error.status === 409 || error.status === 412 ? "The latest version has been reloaded. Please try again." : error.message, variant: "destructive" });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
  });
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="pl-9" aria-label="Search opportunities" placeholder="Search opportunities…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <Select value={stageId} onValueChange={setStageId}><SelectTrigger className="w-44"><SelectValue placeholder="All stages" /></SelectTrigger><SelectContent><SelectItem value="all">All stages</SelectItem>{stages.map((stage) => <SelectItem key={idOf(stage)} value={idOf(stage)}>{nameOf(stage)}</SelectItem>)}</SelectContent></Select>
      <Button variant={mine ? "default" : "outline"} onClick={() => setMine(!mine)}><UserRound className="mr-2 h-4 w-4" />My opportunities</Button>
      <Button variant="outline" size="icon" aria-label={view === "table" ? "Kanban view" : "Table view"} onClick={() => setView(view === "table" ? "kanban" : "table")}>{view === "table" ? <Columns3 className="h-4 w-4" /> : <LayoutList className="h-4 w-4" />}</Button>
      <SavedViews state={{ search, stageId, mine, view }} onApply={(saved) => { setSearch(saved.search || ""); setStageId(saved.stageId || "all"); setMine(Boolean(saved.mine)); setView(saved.view || "table"); }} tenantId={memberInfo?.tenant_id} memberId={memberInfo?.id} />
      <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />New</Button>
    </div>
    {query.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>
      : query.error ? <Card className="border-rose-200"><CardContent className="flex items-center justify-between p-5 text-rose-700"><span><AlertTriangle className="mr-2 inline h-4 w-4" />{query.error.message}</span><Button variant="outline" onClick={() => query.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button></CardContent></Card>
        : !opportunities.length ? <Card><CardContent className="p-10 text-center text-slate-500">No opportunities match these filters.</CardContent></Card>
          : view === "kanban" ? <div className="flex snap-x gap-4 overflow-x-auto pb-4">{stages.map((stage) => {
            const rows = opportunities.filter((item) => (item.stage_id || item.stageId || idOf(item.stage)) === idOf(stage));
            return <section key={idOf(stage)} className="w-[290px] shrink-0 snap-start rounded-xl bg-slate-100 p-3" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const opportunity = opportunities.find((x) => idOf(x) === e.dataTransfer.getData("text/opportunity-id")); if (opportunity) (stage.is_lost || stage.isLost) ? setPendingLossMove({ opportunity, targetStageId: idOf(stage) }) : move.mutate({ opportunity, targetStageId: idOf(stage) }); }}>
              <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stage.color || "#64748b" }} /><h3 className="font-semibold">{nameOf(stage)}</h3></div><Badge variant="secondary">{rows.length}</Badge></div>
              <div className="space-y-3">{rows.map((item) => <OpportunityCard key={idOf(item)} opportunity={item} stages={stages} />)}</div>
            </section>;
          })}</div>
            : <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Opportunity</th><th className="px-4 py-3">Organisation</th><th className="px-4 py-3">Stage</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3 text-right">Value</th><th className="px-4 py-3">Close date</th></tr></thead><tbody>{opportunities.map((item) => <tr key={idOf(item)} tabIndex={0} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => navigate(`/sales/opportunities/${idOf(item)}`)} onKeyDown={(e) => { if (e.key === "Enter") navigate(`/sales/opportunities/${idOf(item)}`); }}><td className="px-4 py-3 font-medium">{nameOf(item)}</td><td className="px-4 py-3">{nameOf(item.organization || { name: item.organization_name })}</td><td className="px-4 py-3"><Badge variant="outline">{nameOf(item.stage || stages.find((s) => idOf(s) === (item.stage_id || item.stageId)))}</Badge></td><td className="px-4 py-3">{nameOf(item.owner || { name: item.owner_name })}</td><td className="px-4 py-3 text-right font-medium">{money(opportunityValue(item), item.currency)}</td><td className="px-4 py-3">{date(item.expected_close_date || item.expectedCloseDate)}</td></tr>)}</tbody></table></div></Card>}
    {view === "table" && pages > 1 && <div className="flex items-center justify-between text-sm text-slate-500"><span>{total} opportunities · Page {page} of {pages}</span><div className="flex gap-2"><Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
    <OpportunityDialog open={createOpen} onOpenChange={setCreateOpen} stages={stages} onCreated={(created) => { qc.invalidateQueries({ queryKey: ["opportunities"] }); if (idOf(created)) navigate(`/sales/opportunities/${idOf(created)}`); }} />
    <LossReasonDialog open={Boolean(pendingLossMove)} onOpenChange={(open) => !open && setPendingLossMove(null)} reasons={arr(lossReasonsQuery.data)} onConfirm={(lossReasonId) => { move.mutate({ ...pendingLossMove, lossReasonId }); setPendingLossMove(null); }} />
  </div>;
}

function SavedViews({ state, onApply, tenantId, memberId }) {
  const key = `opportunity_views_${tenantId || "default"}_${memberId || "anonymous"}`;
  const [views, setViews] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } });
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim()) return;
    const next = [...views.filter((item) => item.name !== name.trim()), { name: name.trim(), ...state }];
    setViews(next); localStorage.setItem(key, JSON.stringify(next)); setName("");
  };
  return <div className="flex items-center gap-1"><Select onValueChange={(value) => { const saved = views.find((item) => item.name === value); if (saved) onApply(saved); }}><SelectTrigger className="w-32"><SelectValue placeholder="Saved views" /></SelectTrigger><SelectContent>{views.map((item) => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectContent></Select><Input className="w-28" value={name} placeholder="View name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} /><Button variant="outline" size="sm" onClick={save}>Save</Button></div>;
}

function SettingsPage() {
  const { isAdmin } = useMemberAccess();
  const { toast } = useToast();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["opportunity-settings"],
    queryFn: async () => {
      const [stages, lossReasons] = await Promise.all([
        request("/api/opportunity-settings?resource=stages"),
        request("/api/opportunity-settings?resource=loss-reasons"),
      ]);
      return {
        stages: arr(stages),
        lossReasons: arr(lossReasons),
        stageOrderVersion: stages.orderVersion ?? stages.order_version ?? stages.version ?? null,
      };
    },
  });
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    const value = settings.data?.data || settings.data;
    if (value) setDraft({ stages: arr(value.stages), lossReasons: arr(value.lossReasons || value.loss_reasons) });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: async () => {
      const synchronize = async (resource, current, original, stageProperties = false) => {
        const resolved = [...current];
        // Create/delete and ordinary property changes deliberately happen before
        // reordering. Position is owned exclusively by the atomic reorder API.
        for (const removed of original.filter((item) => idOf(item) && !current.some((candidate) => idOf(candidate) === idOf(item)))) {
          await request(`/api/opportunity-settings?resource=${resource}&id=${idOf(removed)}`, { method: "DELETE" });
        }
        for (let index = 0; index < resolved.length; index += 1) {
          const item = resolved[index];
          const body = stageProperties
            ? { name: item.name, color: item.color, probability: item.probability, is_won: Boolean(item.is_won), is_lost: Boolean(item.is_lost), is_active: item.is_active !== false }
            : { name: typeof item === "string" ? item : item.name, is_active: item.is_active !== false };
          if (idOf(item)) await request(`/api/opportunity-settings?resource=${resource}&id=${idOf(item)}`, { method: "PATCH", body: JSON.stringify(body) });
          else resolved[index] = await request(`/api/opportunity-settings?resource=${resource}`, { method: "POST", body: JSON.stringify(body) });
        }
        return resolved;
      };
      const resolvedStages = await synchronize("stages", draft.stages, arr(settings.data?.stages), true);
      await synchronize("loss-reasons", draft.lossReasons, arr(settings.data?.lossReasons));
      // Refetch after structural changes so expectedOrderVersion is always based
      // on the current complete server ordering, never a stale client snapshot.
      const current = await request("/api/opportunity-settings?resource=stages");
      const expectedOrderVersion = current.orderVersion ?? current.order_version ?? current.version;
      const orderedIds = resolvedStages.map(idOf).filter(Boolean);
      await request("/api/opportunity-settings?resource=stages&action=reorder", {
        method: "POST",
        body: JSON.stringify({ stageIds: orderedIds, expectedOrderVersion }),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["opportunity-settings"] }); qc.invalidateQueries({ queryKey: ["opportunities"] }); toast({ title: "Opportunity settings saved" }); },
    onError: async (error) => {
      if (error.status === 409) {
        // Refetch rather than merely marking stale so the draft useEffect
        // receives and renders the authoritative server ordering immediately.
        await qc.refetchQueries({ queryKey: ["opportunity-settings"] });
        toast({ title: "Stage order changed elsewhere", description: "Settings were reloaded. Review the latest order and try again.", variant: "destructive" });
        return;
      }
      toast({ title: "Could not save settings", description: error.message, variant: "destructive" });
    },
  });
  if (settings.isLoading || !draft) return <div className="grid h-52 place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (settings.error) return <Card className="border-rose-200"><CardContent className="p-5 text-rose-700">{settings.error.message}</CardContent></Card>;
  const updateStage = (index, key, value) => setDraft({ ...draft, stages: draft.stages.map((row, i) => i === index ? { ...row, [key]: value } : row) });
  const updateReason = (index, value) => setDraft({ ...draft, lossReasons: draft.lossReasons.map((row, i) => i === index ? (typeof row === "string" ? value : { ...row, name: value }) : row) });
  return <div className="space-y-5">
    {!isAdmin && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Only administrators can change pipeline settings.</div>}
    <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Pipeline stages</CardTitle><p className="mt-1 text-sm text-slate-500">Stages are ordered top-to-bottom. Use the arrow controls to change order, then save.</p></div>{isAdmin && <Button variant="outline" onClick={() => setDraft({ ...draft, stages: [...draft.stages, { name: "New stage", color: "#64748b", probability: 0, is_won: false, is_lost: false }] })}><Plus className="mr-2 h-4 w-4" />Stage</Button>}</CardHeader><CardContent className="space-y-3">{draft.stages.map((stage, index) => <div key={idOf(stage) || index} className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_90px_110px_100px_100px_auto_auto]">
      <div><Label>Name</Label><Input disabled={!isAdmin} value={stage.name || stage.title || ""} onChange={(e) => updateStage(index, "name", e.target.value)} /></div>
      <div><Label>Colour</Label><Input disabled={!isAdmin} type="color" className="p-1" value={stage.color || "#64748b"} onChange={(e) => updateStage(index, "color", e.target.value)} /></div>
      <div><Label>Probability %</Label><Input disabled={!isAdmin} type="number" min="0" max="100" value={stage.probability ?? 0} onChange={(e) => updateStage(index, "probability", Number(e.target.value))} /></div>
      <Button disabled={!isAdmin} variant={stage.is_won || stage.isWon ? "default" : "outline"} size="sm" onClick={() => setDraft({ ...draft, stages: draft.stages.map((row, i) => i === index ? { ...row, is_won: !(stage.is_won || stage.isWon), is_lost: false } : row) })}>Won</Button>
      <Button disabled={!isAdmin} variant={stage.is_lost || stage.isLost ? "destructive" : "outline"} size="sm" onClick={() => setDraft({ ...draft, stages: draft.stages.map((row, i) => i === index ? { ...row, is_lost: !(stage.is_lost || stage.isLost), is_won: false } : row) })}>Lost</Button>
      <div className="flex gap-1" aria-label={`Reorder ${stage.name || "stage"}`}><Button type="button" variant="outline" size="icon" aria-label={`Move ${stage.name || "stage"} up`} title="Move up" disabled={!isAdmin || index === 0} onClick={() => { const stages = [...draft.stages]; [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]]; setDraft({ ...draft, stages }); }}><ChevronUp className="h-4 w-4" /></Button><Button type="button" variant="outline" size="icon" aria-label={`Move ${stage.name || "stage"} down`} title="Move down" disabled={!isAdmin || index === draft.stages.length - 1} onClick={() => { const stages = [...draft.stages]; [stages[index], stages[index + 1]] = [stages[index + 1], stages[index]]; setDraft({ ...draft, stages }); }}><ChevronDown className="h-4 w-4" /></Button></div>
      {isAdmin && <Button variant="ghost" size="icon" aria-label="Remove stage" onClick={() => setDraft({ ...draft, stages: draft.stages.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}
    </div>)}</CardContent></Card>
    <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Loss reasons</CardTitle><p className="mt-1 text-sm text-slate-500">Reasons available when an opportunity is marked lost.</p></div>{isAdmin && <Button variant="outline" onClick={() => setDraft({ ...draft, lossReasons: [...draft.lossReasons, { name: "New reason" }] })}><Plus className="mr-2 h-4 w-4" />Reason</Button>}</CardHeader><CardContent className="space-y-3">{draft.lossReasons.map((reason, index) => <div key={idOf(reason) || index} className="flex gap-2"><Input disabled={!isAdmin} value={typeof reason === "string" ? reason : (reason.name || reason.title || "")} onChange={(e) => updateReason(index, e.target.value)} />{isAdmin && <Button variant="ghost" size="icon" aria-label="Remove loss reason" onClick={() => setDraft({ ...draft, lossReasons: draft.lossReasons.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</div>)}</CardContent></Card>
    {isAdmin && <div className="flex justify-end"><Button disabled={save.isPending || draft.stages.some((s) => !(s.name || s.title || "").trim())} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save settings</Button></div>}
  </div>;
}

function CollectionPanel({ opportunityId, organizationId, type, items, canEdit, onChanged }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [role, setRole] = useState("");
  const [people, setPeople] = useState([]);
  const resource = type === "contacts" ? "contact-roles" : type;
  useEffect(() => {
    if (!canEdit || !["contacts", "collaborators"].includes(type)) return;
    const organization = type === "contacts" && organizationId ? `&organization_id=${encodeURIComponent(organizationId)}` : "";
    fetch(`/api/members/search?q=&limit=100${organization}`, { credentials: "include" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((result) => setPeople(arr(result)))
      .catch(() => setPeople([]));
  }, [canEdit, organizationId, type]);
  const create = useMutation({
    mutationFn: () => request(`/api/opportunities/${opportunityId}?resource=${resource}`, { method: "POST", body: JSON.stringify(type === "tasks" ? { title: text, dueAt: dueDate || null } : type === "notes" ? { body: text } : type === "collaborators" ? { principal: { kind: "member", id: text } } : { memberId: text, role }) }),
    onSuccess: () => { setText(""); setDueDate(""); setRole(""); onChanged(); },
    onError: (error) => toast({ title: `Could not add ${type.slice(0, -1)}`, description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (item) => request(`/api/opportunities/${opportunityId}?resource=${resource}&itemId=${type === "collaborators" ? item.principal_id : idOf(item)}`, { method: "DELETE" }),
    onSuccess: onChanged,
    onError: (error) => toast({ title: "Could not remove item", description: error.message, variant: "destructive" }),
  });
  const placeholder = type === "notes" ? "Write a note…" : type === "tasks" ? "Task title…" : type === "contacts" ? "Existing contact ID…" : "Existing team member ID…";
  return <Card><CardContent className="p-5">
    {canEdit && <div className="mb-5 flex flex-wrap gap-2">{type === "notes" ? <Textarea className="min-w-full" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} /> : ["contacts", "collaborators"].includes(type) ? <Select value={text} onValueChange={setText}><SelectTrigger className="min-w-[240px] flex-1"><SelectValue placeholder={people.length ? `Select existing ${type === "contacts" ? "organisation contact" : "team member"}` : "No available people"} /></SelectTrigger><SelectContent>{people.filter((person) => !items.some((item) => idOf(item.contact || item.member || item) === idOf(person))).map((person) => <SelectItem key={idOf(person)} value={idOf(person)}>{nameOf(person)}{person.email ? ` · ${person.email}` : ""}</SelectItem>)}</SelectContent></Select> : <Input className="min-w-[220px] flex-1" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />}{type === "contacts" && <Input className="w-44" value={role} placeholder="Contact role" onChange={(e) => setRole(e.target.value)} />}{type === "tasks" && <Input className="w-44" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}<Button disabled={!text.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="mr-2 h-4 w-4" />Add</Button></div>}
    {!items.length ? <p className="py-8 text-center text-sm text-slate-500">No {type} yet.</p> : <div className="divide-y">{items.map((item, index) => <div key={idOf(item) || index} className="flex items-start justify-between gap-3 py-3"><div><p className="whitespace-pre-wrap text-sm font-medium text-slate-900">{item.body || item.content || item.title || nameOf(item.contact || item.member || item)}</p>{(item.due_date || item.created_at || item.role) && <p className="mt-1 text-xs text-slate-500">{item.role || (item.due_date ? `Due ${date(item.due_date)}` : `Added ${date(item.created_at)}`)}</p>}</div>{canEdit && <Button variant="ghost" size="icon" aria-label="Remove" disabled={remove.isPending} onClick={() => { if (window.confirm("Remove this item?")) remove.mutate(item); }}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</div>)}</div>}
  </CardContent></Card>;
}

function DocumentsPanel({ opportunityId, items, canEdit, onChanged }) {
  const { toast } = useToast();
  const upload = useMutation({
    mutationFn: async (file) => {
      const signed = await request("/api/storage/signed-upload-url", { method: "POST", body: JSON.stringify({ fileName: file.name, fileSize: file.size, mimeType: file.type || "application/octet-stream", type: "opportunity-document", entityId: opportunityId, isPrivate: true }) });
      const uploadResponse = await fetch(signed.signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!uploadResponse.ok) throw new Error("The file could not be uploaded");
      return request(`/api/opportunities/${opportunityId}?resource=documents`, { method: "POST", body: JSON.stringify({ name: file.name, bucket: signed.bucket, storagePath: signed.path, mimeType: file.type, sizeBytes: file.size }) });
    },
    onSuccess: onChanged,
    onError: (error) => toast({ title: "Upload failed", description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({ mutationFn: (item) => request(`/api/opportunities/${opportunityId}?resource=documents&itemId=${idOf(item)}`, { method: "DELETE" }), onSuccess: onChanged, onError: (error) => toast({ title: "Delete failed", description: error.message, variant: "destructive" }) });
  return <Card><CardContent className="p-5">
    {canEdit && <label className="mb-5 inline-flex cursor-pointer items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Upload className="mr-2 h-4 w-4" />Upload document<input type="file" className="sr-only" onChange={(e) => { if (e.target.files?.[0]) upload.mutate(e.target.files[0]); e.target.value = ""; }} /></label>}
    {!items.length ? <p className="py-8 text-center text-sm text-slate-500">No documents yet.</p> : <div className="divide-y">{items.map((item) => <div key={idOf(item)} className="flex items-center justify-between py-3"><a className="flex items-center gap-2 text-sm font-medium text-blue-700 hover:underline" href={`/api/storage/secure-url?bucket=${encodeURIComponent(item.bucket)}&path=${encodeURIComponent(item.storage_path)}&redirect=true`} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" />{item.name || item.filename || "Document"}</a>{canEdit && <Button variant="ghost" size="icon" onClick={() => remove.mutate(item)}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</div>)}</div>}
  </CardContent></Card>;
}

function OpportunityDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const detail = useQuery({ queryKey: ["opportunity", id], queryFn: () => request(`/api/opportunities/${id}`) });
  const stageQuery = useQuery({ queryKey: ["opportunity-settings", "stages"], queryFn: () => request("/api/opportunity-settings?resource=stages") });
  const lossReasonsQuery = useQuery({ queryKey: ["opportunity-settings", "loss-reasons"], queryFn: () => request("/api/opportunity-settings?resource=loss-reasons") });
  const [lossDialogOpen, setLossDialogOpen] = useState(false);
  const normalizedDetail = normalizeOpportunityDetail(detail.data);
  const opportunity = normalizedDetail.opportunity;
  const capabilities = normalizedDetail.permissions;
  const { canEdit, canManage } = getOpportunityUiCapabilities(capabilities);
  const [form, setForm] = useState(null);
  useEffect(() => { if (opportunity) setForm({
    name: opportunity.name || opportunity.title || "",
    value: opportunityValue(opportunity),
    currency: opportunity.currency || "GBP",
    priority: opportunity.priority || "medium",
    expected_close_date: (opportunity.expected_close_date || opportunity.expectedCloseDate || "").slice(0, 10),
    description: opportunity.description || "",
    stage_id: opportunity.stage_id || opportunity.stageId || idOf(opportunity.stage) || "",
  }); }, [opportunity]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["opportunity", id] });
  const update = useMutation({
    mutationFn: async (lossReasonId) => {
      const originalStageId = opportunity.stage_id || opportunity.stageId || idOf(opportunity.stage);
      const updated = await request(`/api/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({
        name: form.name, description: form.description, valueMinor: form.value === "" ? null : Math.round(Number(form.value) * 100),
        currency: form.currency, priority: form.priority, expectedCloseDate: form.expected_close_date || null, expectedVersion: opportunity.version,
      }) });
      if (form.stage_id && form.stage_id !== originalStageId) {
        return request(`/api/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ action: "move", stageId: form.stage_id, lossReasonId, expectedVersion: updated.version }) });
      }
      return updated;
    },
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ["opportunities"] }); toast({ title: "Opportunity updated" }); },
    onError: (error) => {
      if (error.status === 409 || error.status === 412) refresh();
      toast({ title: error.status === 409 || error.status === 412 ? "Opportunity changed elsewhere" : "Update failed", description: error.status === 409 || error.status === 412 ? "Your changes were not saved. The latest version has been loaded." : error.message, variant: "destructive" });
    },
  });
  if (detail.isLoading || !form) return <div className="grid h-72 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>;
  if (detail.error) return <Card className="border-rose-200"><CardContent className="p-6 text-rose-700"><AlertTriangle className="mr-2 inline h-4 w-4" />{detail.error.message}<Button className="ml-4" variant="outline" onClick={() => detail.refetch()}>Retry</Button></CardContent></Card>;
  const stages = normalizedDetail.stages.length ? normalizedDetail.stages : arr(stageQuery.data);
  const collections = normalizedDetail.collections;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3"><Button variant="outline" size="icon" aria-label="Back to opportunities" onClick={() => navigate("/sales/opportunities")}><ArrowLeft className="h-4 w-4" /></Button><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-bold text-slate-950">{nameOf(opportunity)}</h2><Badge className="capitalize" variant="outline">{opportunity.priority || "medium"}</Badge></div><div className="mt-1 flex flex-wrap gap-x-4 text-sm text-slate-500"><span>{nameOf(opportunity.organization || { name: opportunity.organization_name })}</span><span>{money(opportunityValue(opportunity), opportunity.currency)}</span><span>Close {date(opportunity.expected_close_date || opportunity.expectedCloseDate)}</span></div></div></div>
      {opportunity.organization_id && <Button variant="outline" asChild><Link to={`/organisations/${opportunity.organization_id}`}>View organisation</Link></Button>}
    </div>
    <Tabs defaultValue="overview">
      <TabsList className="h-auto max-w-full flex-wrap justify-start">
        <TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="contacts">Contacts</TabsTrigger><TabsTrigger value="notes">Notes</TabsTrigger><TabsTrigger value="documents">Documents</TabsTrigger><TabsTrigger value="tasks">Tasks</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="quotes">Quotes</TabsTrigger><TabsTrigger value="allocations">Allocations</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="space-y-4">
        <Card><CardHeader><CardTitle>Opportunity details</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input disabled={!canEdit} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Stage</Label><Select disabled={!canEdit || !stages.length} value={form.stage_id} onValueChange={(stage_id) => setForm({ ...form, stage_id })}><SelectTrigger><SelectValue placeholder={nameOf(opportunity.stage)} /></SelectTrigger><SelectContent>{stages.map((stage) => <SelectItem key={idOf(stage)} value={idOf(stage)}>{nameOf(stage)} ({stage.probability ?? 0}%)</SelectItem>)}</SelectContent></Select></div>
          <div><Label>Priority</Label><Select disabled={!canEdit} value={form.priority} onValueChange={(priority) => setForm({ ...form, priority })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["low", "medium", "high", "urgent"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>Value</Label><Input disabled={!canEdit} type="number" min="0" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
          <div><Label>Expected close</Label><Input disabled={!canEdit} type="date" value={form.expected_close_date} onChange={(e) => setForm({ ...form, expected_close_date: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Description</Label><Textarea disabled={!canEdit} rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          {canEdit && <div className="sm:col-span-2 flex justify-end"><Button disabled={!form.name.trim() || update.isPending} onClick={() => { const target = stages.find((stage) => idOf(stage) === form.stage_id); if ((target?.is_lost || target?.isLost) && form.stage_id !== (opportunity.stage_id || opportunity.stageId)) setLossDialogOpen(true); else update.mutate(); }}>{update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save changes</Button></div>}
        </CardContent></Card>
        <div><h3 className="mb-2 text-lg font-semibold">Collaborators</h3><CollectionPanel opportunityId={id} organizationId={opportunity.organization_id} type="collaborators" items={collections.collaborators} canEdit={canManage} onChanged={refresh} /></div>
      </TabsContent>
      <TabsContent value="contacts"><CollectionPanel opportunityId={id} organizationId={opportunity.organization_id} type="contacts" items={collections.contacts} canEdit={canEdit} onChanged={refresh} /></TabsContent>
      <TabsContent value="notes"><CollectionPanel opportunityId={id} type="notes" items={collections.notes} canEdit={canEdit} onChanged={refresh} /></TabsContent>
      <TabsContent value="documents"><DocumentsPanel opportunityId={id} items={collections.documents} canEdit={canEdit} onChanged={refresh} /></TabsContent>
      <TabsContent value="tasks"><CollectionPanel opportunityId={id} type="tasks" items={collections.tasks} canEdit={canEdit} onChanged={refresh} /></TabsContent>
      <TabsContent value="activity"><div className="grid gap-4 lg:grid-cols-2"><Timeline title="Activity" items={collections.activity} /><Timeline title="Stage history" items={collections.stageHistory} /></div></TabsContent>
      <TabsContent value="quotes"><Placeholder title="Quotes" text="Quotes linked to this opportunity will appear here when quoting is enabled." /></TabsContent>
      <TabsContent value="allocations"><Placeholder title="Allocations" text="Product and service allocations will appear here when allocation management is enabled." /></TabsContent>
    </Tabs>
    <LossReasonDialog open={lossDialogOpen} onOpenChange={setLossDialogOpen} reasons={arr(lossReasonsQuery.data)} onConfirm={(lossReasonId) => { setLossDialogOpen(false); update.mutate(lossReasonId); }} />
  </div>;
}

function Timeline({ title, items }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{!items.length ? <p className="py-8 text-center text-sm text-slate-500">No {title.toLowerCase()} yet.</p> : <ol className="relative ml-2 border-l border-slate-200">{items.map((item, index) => <li key={idOf(item) || index} className="mb-5 ml-5 last:mb-0"><span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-blue-600" /><p className="text-sm font-medium">{item.description || item.message || item.action || `${nameOf(item.from_stage)} → ${nameOf(item.to_stage)}`}</p><p className="mt-1 text-xs text-slate-500">{nameOf(item.actor || item.created_by)} · {item.created_at ? new Date(item.created_at).toLocaleString() : ""}</p></li>)}</ol>}</CardContent></Card>;
}

function Placeholder({ title, text }) {
  return <Card><CardContent className="p-10 text-center"><FileText className="mx-auto h-8 w-8 text-slate-300" /><h3 className="mt-3 font-semibold">{title}</h3><p className="mt-1 text-sm text-slate-500">{text}</p></CardContent></Card>;
}

export default function OpportunitiesWorkspace({ destination }) {
  const { id } = useParams();
  if (id) return <OpportunityDetail />;
  if (destination === "settings") return <SettingsPage />;
  return <OpportunitiesList destination={destination} />;
}
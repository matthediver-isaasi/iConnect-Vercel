import { useState } from "react";
import { Plus, Pencil, Archive, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import QuoteEventSelect from "@/components/sales/QuoteEventSelect";
import { exhibitionRequest, useExhibition, useExhibitionMutation } from "@/components/sales/useExhibition";
import { exhibitionMoney } from "@/components/sales/exhibition";
import { decimalToMinor, minorToDecimal } from "./catalogueProductForm";
import { useSalesSettingsScope } from "@/components/sales/useSalesSettings";

const selectClass = "h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm disabled:opacity-50";
function Field({ label, children }) { return <label className="block space-y-1.5 text-sm"><span className="font-medium text-slate-700">{label}</span>{children}</label>; }

export default function ExhibitionInventory({ canManage }) {
  const scope = useSalesSettingsScope();
  return <Inventory key={scope.scopeKey} canManage={canManage} />;
}

function Inventory({ canManage }) {
  const [event, setEvent] = useState(null);
  const [groupId, setGroupId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState("");
  const query = useExhibition({ eventId: event?.id, eventKind: event?.kind, groupId, status, page });
  const mutation = useExhibitionMutation();
  const data = query.data || {};
  const groups = data.groups || [];
  const items = data.items || [];
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 20)));
  const patch = async body => {
    setError("");
    try { await mutation.mutateAsync({ method: "PATCH", ...body }); }
    catch (failure) { setError(failure.message || "The space could not be updated."); }
  };
  return <section className="space-y-4">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div><h3 className="text-lg font-semibold text-slate-900">Exhibition spaces</h3><p className="mt-1 max-w-2xl text-sm text-slate-600">Manage identifiable stands for each event. Proposal selections hold individual references; accepted proposals sell them.</p></div>
      {canManage && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setDialog({ type: "requirement" })}>New requirement</Button><Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => setDialog({ type: "generate" })}><Plus className="mr-2 h-4 w-4" />Generate spaces</Button></div>}
    </div>
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-3">
      <div><Label className="mb-1.5 block">Event</Label><QuoteEventSelect value={event?.id || ""} kind={event?.kind || "simple"} request={exhibitionRequest} onChange={next => { setEvent(next); setGroupId(""); setPage(1); }} /></div>
      <Field label="Inventory group"><select aria-label="Inventory group" className={selectClass} value={groupId} onChange={e => { setGroupId(e.target.value); setPage(1); }}><option value="">All groups</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.event_name}</option>)}</select></Field>
      <Field label="Space status"><select aria-label="Space status" className={selectClass} value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["available", "held", "sold", "unavailable", "archived"].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></Field>
    </div>
    <p className="text-xs leading-relaxed text-slate-500">Requirements link products to suitable inventory groups. Blocking or archiving is allowed only for available or unavailable spaces. Price changes affect future selections, not saved proposal prices.</p>
    {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b px-4 py-3 text-sm font-medium text-slate-700">{data.total ?? 0} spaces <span className="ml-2 text-xs font-normal text-slate-500">Page {data.page || page} of {totalPages}</span></div>
      {query.isPending ? <div role="status" className="space-y-3 p-5"><span className="sr-only">Loading exhibition inventory</span>{[1, 2, 3, 4].map(i => <div key={i} className="h-12 animate-pulse rounded bg-slate-100" />)}</div> : query.isError ? <div role="alert" className="p-5 text-sm text-rose-700">{query.error.message}<Button variant="outline" className="ml-3" onClick={() => query.refetch()}>Retry inventory</Button></div> : !items.length ? <div className="px-5 py-12 text-center"><MapPin className="mx-auto h-8 w-8 text-blue-400" /><h4 className="mt-3 font-semibold text-slate-800">No spaces in this view</h4><p className="mx-auto mt-2 max-w-md text-sm text-slate-500">Try another event or status, or generate a numbered group of spaces for your next exhibition.</p>{canManage && <Button className="mt-4" variant="outline" onClick={() => setDialog({ type: "generate" })}>Generate spaces</Button>}</div> :
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Space / event</th><th className="px-4 py-3">Group / requirement</th><th className="px-4 py-3">Future price</th><th className="px-4 py-3">Status / proposal</th>{canManage && <th className="px-4 py-3 text-right">Actions</th>}</tr></thead><tbody>{items.map(item => {
          const group = groups.find(group => group.id === item.group_id);
          const mutable = ["available", "unavailable"].includes(item.status);
          return <tr key={item.id} className="border-t border-slate-100"><td className="px-4 py-3"><p className="font-semibold text-slate-900">{item.reference}</p><p className="mt-1 text-xs text-slate-500">{item.event_name || "Event unavailable"}</p></td><td className="px-4 py-3"><p>{item.group_name || group?.name || "—"}</p><p className="mt-1 text-xs text-slate-500">{data.requirements?.find(row => row.id === group?.requirement_id)?.name || "—"}</p></td><td className="px-4 py-3 tabular-nums">{exhibitionMoney(item.price_minor, item.currency)}</td><td className="px-4 py-3"><Badge variant="outline" className={item.status === "available" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : item.status === "held" ? "border-amber-200 bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"}>{item.status}</Badge>{item.quote_id && <p className="mt-1 text-xs text-slate-500">{item.quote_number || "Proposal"}{item.customer_name ? ` · ${item.customer_name}` : ""}</p>}</td>{canManage && <td className="px-4 py-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" disabled={mutation.isPending} aria-label={`Change future price for ${item.reference}`} onClick={() => setDialog({ type: "price", item })}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="sm" disabled={!mutable || mutation.isPending} onClick={() => patch({ id: item.id, blocked: item.status === "available" })}>{item.status === "unavailable" ? "Unblock" : "Block"}</Button><Button variant="ghost" size="icon" disabled={!mutable || mutation.isPending} aria-label={`Archive ${item.reference}`} onClick={() => setDialog({ type: "archive", item })}><Archive className="h-4 w-4" /></Button></div></td>}</tr>;
        })}</tbody></table></div>}
    </div>
    <div className="flex items-center justify-between gap-3 text-xs text-slate-500"><span>{query.isFetching && !query.isPending ? "Refreshing inventory…" : "Inventory is checked again when a proposal selects a space."}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={query.isFetching || page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={query.isFetching || page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button></div></div>
    {canManage && dialog && <InventoryDialog config={dialog} groups={groups} requirements={data.requirements || []} initialEvent={event} onClose={() => setDialog(null)} />}
  </section>;
}

function InventoryDialog({ config, groups, requirements, initialEvent, onClose }) {
  const [form, setForm] = useState({ groupId: "", name: "", event: initialEvent, requirementId: "", requirementName: "", prefix: "", quantity: "1", price: config.item ? minorToDecimal(config.item.price_minor) : "", currency: config.item?.currency || "GBP" });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const mutation = useExhibitionMutation();
  const patch = (key, value) => setForm(old => ({ ...old, [key]: value }));
  const group = groups.find(item => item.id === form.groupId);
  const submit = async e => {
    e.preventDefault();
    if (mutation.isPending) return;
    setError("");
    try {
      let command;
      if (config.type === "requirement") command = { action: "requirement", name: form.name.trim() };
      else if (config.type === "price") command = { method: "PATCH", id: config.item.id, priceMinor: decimalToMinor(form.price, { required: true }) };
      else if (config.type === "archive") command = { method: "PATCH", id: config.item.id, archived: true };
      else {
        const eventId = group?.event_id || form.event?.id;
        if (!eventId) throw new Error("Choose the event whose spaces you are generating.");
        const quantity = Number(form.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Enter a whole number of spaces greater than zero.");
        if (!group && !form.requirementId && !form.requirementName.trim()) throw new Error("Select or name a requirement for this group.");
        command = { action: "generate", ...(group ? { groupId: group.id } : {}), name: group?.name || form.name.trim(), eventId, eventKind: group?.event_kind || form.event?.kind || "simple", ...(group?.requirement_id || form.requirementId ? { requirementId: group?.requirement_id || form.requirementId } : { requirementName: form.requirementName.trim() }), prefix: group?.prefix || form.prefix.trim(), quantity, priceMinor: decimalToMinor(form.price, { required: true }), currency: group?.currency || form.currency, idempotencyKey };
      }
      await mutation.mutateAsync(command);
      onClose();
    } catch (failure) { setError(failure.message || "Inventory could not be saved. Please retry."); }
  };
  return <Dialog open onOpenChange={open => !open && !mutation.isPending && onClose()}><DialogContent className="max-h-[90dvh] overflow-y-auto border-slate-200 bg-white sm:max-w-xl"><form onSubmit={submit}><DialogHeader><DialogTitle>{config.type === "generate" ? "Generate exhibition spaces" : config.type === "requirement" ? "New space requirement" : config.type === "archive" ? `Archive ${config.item.reference}?` : `Future price · ${config.item.reference}`}</DialogTitle><DialogDescription>{config.type === "generate" ? "Create a group or add more numbered references to an existing group. References are generated by the server." : config.type === "requirement" ? "Use a shared requirement to match catalogue products with suitable event spaces." : config.type === "archive" ? "This reference will no longer be selectable on proposals. Held and sold spaces cannot be archived." : "Only future selections use the new price. Saved proposal prices remain unchanged."}</DialogDescription></DialogHeader>
    <fieldset disabled={mutation.isPending} className="mt-5 space-y-4">
      {config.type === "requirement" && <Field label="Requirement name"><Input autoFocus required maxLength={255} value={form.name} onChange={e => patch("name", e.target.value)} /></Field>}
      {config.type === "generate" && <>
        <Field label="Inventory group"><select className={selectClass} value={form.groupId} onChange={e => patch("groupId", e.target.value)}><option value="">Create a new group</option>{groups.map(item => <option key={item.id} value={item.id}>{item.name} · {item.event_name}</option>)}</select></Field>
        {group ? <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">Adding to {group.name} for {group.event_name}. Prefix {group.prefix}; existing references are kept.</p> : <>
          <Field label="Group name"><Input required maxLength={255} value={form.name} onChange={e => patch("name", e.target.value)} /></Field>
          <div><Label className="mb-1.5 block">Event</Label><QuoteEventSelect request={exhibitionRequest} value={form.event?.id || ""} kind={form.event?.kind || "simple"} onChange={value => patch("event", value)} /></div>
          <Field label="Space requirement"><select className={selectClass} value={form.requirementId} onChange={e => patch("requirementId", e.target.value)}><option value="">Create a named requirement</option>{requirements.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          {!form.requirementId && <Field label="New requirement name"><Input required maxLength={255} value={form.requirementName} onChange={e => patch("requirementName", e.target.value)} /></Field>}
          <Field label="Reference prefix"><Input required maxLength={64} placeholder="EX-" value={form.prefix} onChange={e => patch("prefix", e.target.value)} /></Field>
        </>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Quantity to add"><Input required type="number" min="1" step="1" value={form.quantity} onChange={e => patch("quantity", e.target.value)} /></Field><Field label="Currency"><Input required pattern="[A-Z]{3}" maxLength={3} disabled={Boolean(group)} value={group?.currency || form.currency} onChange={e => patch("currency", e.target.value.toUpperCase())} /></Field></div>
      </>}
      {["generate", "price"].includes(config.type) && <Field label={`Price per space (${group?.currency || form.currency}, excl. VAT)`}><Input required inputMode="decimal" placeholder="125.00" value={form.price} onChange={e => patch("price", e.target.value)} /></Field>}
    </fieldset>
    {error && <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p>}
    <DialogFooter className="mt-6"><Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : config.type === "generate" ? "Generate spaces" : config.type === "archive" ? "Archive space" : "Save"}</Button></DialogFooter>
    </form></DialogContent></Dialog>;
}

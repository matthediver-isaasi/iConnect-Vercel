import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Boxes, ChevronDown, ChevronUp, FolderTree, Package, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCatalogue, useEventOptions } from "./useCatalogue";
import { getSalesCataloguePath } from "@/lib/salesNavigation";

const icon = { categories: FolderTree, products: Package, bundles: Boxes };
const title = { categories: "Categories", products: "Products", bundles: "Bundles" };
const singular = { categories: "category", products: "product", bundles: "bundle" };
const blank = { categories: { name: "", code: "", description: "" }, products: { name: "", code: "", sku: "", categoryId: "", currency: "GBP", standardPriceMinor: "", minimumPriceMinor: "", costMinor: "", shortDescription: "", description: "", taxTreatment: "standard", taxRateBps: "", availableFrom: "", availableTo: "", eventReference: { kind: "", eventId: "", ticketTypeId: "" }, capacityMetadata: "" }, bundles: { name: "", code: "", currency: "GBP", sellingPriceMinor: "", minimumPriceMinor: "", presentationMode: "bundle", availableFrom: "", availableTo: "", description: "", items: [] } };
const money = (minor, currency = "GBP") => minor === null || minor === undefined || minor === "" ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(minor) / 100);
const asList = (data) => Array.isArray(data) ? data : data?.items || data?.results || [];

function Field({ label, children, wide = false }) { return <div className={wide ? "sm:col-span-2" : ""}><Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</Label>{children}</div>; }

export default function Catalogue({ section = "categories" }) {
  const navigate = useNavigate();
  const tab = section;
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    setSearch("");
    setDialog(null);
  }, [section]);
  const catalogue = useCatalogue(tab, search);
  const categories = useCatalogue("categories");
  const products = useCatalogue("products");
  const events = useEventOptions();
  const rows = asList(catalogue.data);
  const onSaved = () => { setDialog(null); toast({ title: `${singular[tab][0].toUpperCase() + singular[tab].slice(1)} saved`, description: "Catalogue changes are now available to your sales team." }); };
  const onMutationError = (error) => toast({ variant: "destructive", title: "Catalogue change failed", description: error?.message || "Please try again." });
  const changeTab = (next) => {
    const path = getSalesCataloguePath(next);
    if (path) navigate(path);
  };
  const move = (index, direction) => {
    const reordered = [...rows]; [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
    catalogue.reorder.mutate(reordered.map((row) => row.id), { onError: (error) => toast({ variant: "destructive", title: "Could not reorder", description: error.message }) });
  };
  return <div className="min-w-0">
    <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <p className="max-w-xl text-sm text-slate-600">Manage the categories, products, pricing and packaged offers available to your sales team.</p>
      <Button onClick={() => setDialog({ type: tab })} className="shrink-0 bg-blue-600 text-white hover:bg-blue-700"><Plus className="mr-2 h-4 w-4" />New {singular[tab]}</Button>
    </div>
    <Tabs value={tab} onValueChange={changeTab} className="mb-5">
      <TabsList className="h-auto w-full justify-start gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 sm:w-auto">
        {["categories", "products", "bundles"].map((key) => { const Icon = icon[key]; return <TabsTrigger key={key} value={key} className="min-w-0 flex-1 gap-1.5 rounded-lg px-2 py-2 text-xs data-[state=active]:bg-blue-600 data-[state=active]:text-white sm:flex-none sm:px-3"><Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{title[key]}</span></TabsTrigger>; })}
      </TabsList>
    </Tabs>
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-medium text-slate-800">{rows.length} {rows.length === 1 ? singular[tab] : title[tab].toLowerCase()} <span className="ml-2 text-xs font-normal text-slate-500">including archived records</span></div>
        {tab !== "categories" && <div className="relative w-full sm:w-72"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${title[tab].toLowerCase()}`} className="h-9 border-slate-200 bg-white pl-9 text-sm" /></div>}
      </div>
      {catalogue.isLoading ? <Skeleton /> : catalogue.isError ? <Failure onRetry={() => catalogue.refetch()} /> : rows.length === 0 ? <Empty type={tab} onCreate={() => setDialog({ type: tab })} /> : <div className="overflow-x-auto"><CatalogueTable rows={rows} type={tab} categories={asList(categories.data)} products={asList(products.data)} onEdit={(row) => setDialog({ type: tab, row })} onArchive={(row) => { const action = row.isActive === false || row.archivedAt ? catalogue.restore : catalogue.archive; action.mutate(row.id, { onError: onMutationError }); }} onMove={move} /></div>}
    </section>
    <EditDialog config={dialog} categories={asList(categories.data)} products={asList(products.data)} events={events.data || {}} onClose={() => setDialog(null)} onSave={(data) => dialog?.row ? catalogue.update.mutate({ id: dialog.row.id, data }, { onSuccess: onSaved, onError: onMutationError }) : catalogue.create.mutate(data, { onSuccess: onSaved, onError: onMutationError })} saving={catalogue.create.isPending || catalogue.update.isPending} />
  </div>;
}

function CatalogueTable({ rows, type, categories, products, onEdit, onArchive, onMove }) {
  const categoryName = (id) => categories.find((item) => String(item.id) === String(id))?.name || "Uncategorised";
  const productName = (id) => products.find((item) => String(item.id) === String(id))?.name || "Unavailable product";
  return <Table className="min-w-[680px]"><TableHeader><TableRow className="bg-slate-50 hover:bg-slate-50"><TableHead>{type === "categories" ? "Category" : type === "products" ? "Product" : "Bundle"}</TableHead><TableHead>{type === "categories" ? "Description" : type === "products" ? "Category / code" : "Included items"}</TableHead><TableHead>{type === "products" || type === "bundles" ? "Price / capacity" : "Status"}</TableHead><TableHead className="w-28 text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{rows.map((row, index) => { const archived = row.isActive === false || row.archivedAt; const reference = row.eventReference || {}; return <TableRow key={row.id} className={archived ? "bg-slate-50/70 text-slate-500" : ""}><TableCell><div className="font-semibold text-slate-900">{row.name}</div>{row.code && <div className="mt-0.5 font-mono text-[11px] text-slate-500">{row.code}</div>}</TableCell><TableCell className="max-w-[280px] text-xs text-slate-600">{type === "products" ? <><span className="font-medium text-blue-700">{categoryName(row.categoryId)}</span>{row.sku && <span className="ml-2 font-mono text-slate-500">SKU {row.sku}</span>}</> : type === "bundles" ? <span>{(row.items || []).map((item) => `${item.quantity} × ${productName(item.productId)}`).join(" · ") || "No products selected"}</span> : row.description || "—"}</TableCell><TableCell>{type === "products" ? <><div className="font-medium text-slate-800">{money(row.standardPriceMinor, row.currency)}</div><div className="text-[11px] text-slate-500">minimum {money(row.minimumPriceMinor, row.currency)}{reference.eventId ? ` · ${row.delegateCapacity ?? "Unavailable"} delegate${row.delegateCapacity === 1 ? "" : "s"}` : " · general"}</div></> : type === "bundles" ? <><div className="font-medium text-slate-800">{money(row.sellingPriceMinor, row.currency)}</div><div className="text-[11px] text-slate-500">{(row.items || []).length} products</div></> : <Badge variant="outline" className={archived ? "border-slate-300 bg-slate-100 text-slate-600" : "border-blue-200 bg-blue-50 text-blue-700"}>{archived ? "Archived" : "Active"}</Badge>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" aria-label={`Edit ${row.name}`} onClick={() => onEdit(row)} className="h-8 w-8 text-slate-600 hover:bg-blue-50 hover:text-blue-700"><Pencil className="h-3.5 w-3.5" /></Button>{type === "categories" && <div className="hidden sm:flex"><Button variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove(index, -1)} className="h-8 w-6"><ChevronUp className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" disabled={index === rows.length - 1} onClick={() => onMove(index, 1)} className="h-8 w-6"><ChevronDown className="h-3.5 w-3.5" /></Button></div>}<Button variant="ghost" size="icon" aria-label={`${archived ? "Restore" : "Archive"} ${row.name}`} onClick={() => onArchive(row)} className="h-8 w-8 text-slate-500 hover:bg-amber-50 hover:text-amber-700">{archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}</Button></div></TableCell></TableRow>; })}</TableBody></Table>;
}

function EditDialog({ config, categories, products, events, onClose, onSave, saving }) {
  const type = config?.type; const [form, setForm] = useState(blank[type] || blank.categories);
  useEffect(() => { if (config) setForm({ ...blank[config.type], ...config.row, items: config.row?.items || [] }); }, [config]);
  if (!config) return null;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    const numeric = ["standardPriceMinor", "minimumPriceMinor", "costMinor", "taxRateBps", "sellingPriceMinor"];
    const allowed = type === "categories" ? ["name", "code", "description"] : type === "products" ? ["name", "code", "sku", "categoryId", "currency", "standardPriceMinor", "minimumPriceMinor", "costMinor", "shortDescription", "description", "taxTreatment", "taxRateBps", "availableFrom", "availableTo", "eventReference", "capacityMetadata"] : ["name", "code", "currency", "sellingPriceMinor", "minimumPriceMinor", "presentationMode", "availableFrom", "availableTo", "description", "items"];
    const data = Object.fromEntries(allowed.map((key) => [key, numeric.includes(key) && form[key] !== "" ? Number(form[key]) : form[key] === "" ? null : form[key]]));
    if (type === "products") {
      const reference = form.eventReference || {};
      const hasReference = reference.kind && reference.eventId && reference.ticketTypeId;
      data.eventReference = hasReference ? reference : null;
      try { data.capacityMetadata = form.capacityMetadata ? (typeof form.capacityMetadata === "string" ? JSON.parse(form.capacityMetadata) : form.capacityMetadata) : {}; } catch { toast({ variant: "destructive", title: "Invalid capacity metadata", description: "Enter valid JSON before saving this product." }); return; }
    }
    if (type === "bundles") data.items = (form.items || []).filter((item) => item.productId).map((item) => ({ productId: item.productId, quantity: Number(item.quantity) }));
    onSave(data);
  };
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto border-slate-200 bg-white"><form onSubmit={submit}><DialogHeader><DialogTitle className="text-2xl font-semibold text-slate-950">{config.row ? "Edit" : "Add"} {singular[type]}</DialogTitle><DialogDescription>{type === "products" ? "Prices are stored as minor currency units; £125.00 is entered as 12500." : type === "bundles" ? "Set the included products and their display order." : "Organise how your sales catalogue is browsed."}</DialogDescription></DialogHeader><div className="mt-6 grid gap-4 sm:grid-cols-2">
    <Field label="Name"><Input required value={form.name || ""} onChange={(e) => update("name", e.target.value)} /></Field>
     {type !== "categories" && <Field label="Internal code"><Input required value={form.code || ""} onChange={(e) => update("code", e.target.value)} /></Field>}
     {type === "categories" && <><Field label="Category code"><Input required value={form.code || ""} onChange={(e) => update("code", e.target.value)} /></Field><Field label="Description" wide><Textarea value={form.description || ""} onChange={(e) => update("description", e.target.value)} /></Field></>}
    {type === "products" && <ProductFields form={form} update={update} categories={categories} events={events} />}
     {type === "bundles" && <BundleFields form={form} update={update} />}
     {type === "bundles" && <BundleItems form={form} update={update} products={products} />}
    {type === "bundles" && <Field label="Description" wide><Textarea value={form.description || ""} onChange={(e) => update("description", e.target.value)} /></Field>}
  </div><DialogFooter className="mt-7"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={saving} type="submit" className="bg-blue-600 text-white hover:bg-blue-700">{saving ? "Saving…" : "Save catalogue item"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ProductFields({ form, update, categories, events }) {
  const eventList = Array.isArray(events.items) ? events.items : [];
  const ref = form.eventReference || {};
  const selected = eventList.find((item) => String(item.id) === String(ref.eventId));
  const patchEvent = (eventId) => {
    const event = eventList.find((item) => String(item.id) === String(eventId));
    update("eventReference", { kind: event?.kind || "", eventId, ticketTypeId: "" });
  };
  const patchRef = (key, value) => update("eventReference", { ...ref, [key]: value });
  return <>
    <Field label="Category"><Select value={String(form.categoryId || "")} onValueChange={(v) => update("categoryId", v)}><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger><SelectContent>{categories.filter((item) => item.isActive !== false).map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent></Select></Field>
    <Field label="SKU"><Input value={form.sku || ""} onChange={(e) => update("sku", e.target.value)} /></Field>
    <Field label="Currency"><Input required maxLength="3" value={form.currency || "GBP"} onChange={(e) => update("currency", e.target.value.toUpperCase())} /></Field>
    <Field label="Standard price (minor units)"><Input required type="number" min="0" value={form.standardPriceMinor ?? ""} onChange={(e) => update("standardPriceMinor", e.target.value)} /></Field>
    <Field label="Minimum price (minor units)"><Input type="number" min="0" value={form.minimumPriceMinor ?? ""} onChange={(e) => update("minimumPriceMinor", e.target.value)} /></Field>
    <Field label="Cost (minor units)"><Input type="number" min="0" value={form.costMinor ?? ""} onChange={(e) => update("costMinor", e.target.value)} /></Field>
    <Field label="Tax treatment"><Select value={form.taxTreatment || "standard"} onValueChange={(v) => update("taxTreatment", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="zero_rated">Zero rated</SelectItem><SelectItem value="exempt">Exempt</SelectItem><SelectItem value="outside_scope">Outside scope</SelectItem></SelectContent></Select></Field>
    <Field label="Tax rate (basis points)"><Input type="number" min="0" value={form.taxRateBps ?? ""} onChange={(e) => update("taxRateBps", e.target.value)} /></Field>
    <Field label="Available from"><Input type="date" value={form.availableFrom || ""} onChange={(e) => update("availableFrom", e.target.value)} /></Field>
    <Field label="Available to"><Input type="date" value={form.availableTo || ""} onChange={(e) => update("availableTo", e.target.value)} /></Field>
    <Field label="Event"><Select value={String(ref.eventId || "")} onValueChange={patchEvent}><SelectTrigger><SelectValue placeholder="Optional event" /></SelectTrigger><SelectContent>{eventList.map((event) => <SelectItem key={event.id} value={String(event.id)}>{event.name}</SelectItem>)}</SelectContent></Select>{ref.eventId && <Button type="button" variant="link" className="h-auto px-0 pt-1 text-xs" onClick={() => update("eventReference", null)}>Remove event link</Button>}</Field>
    <Field label="Event kind"><Input readOnly value={ref.kind || ""} /></Field>
    <Field label="Ticket type"><Select value={String(ref.ticketTypeId || "")} onValueChange={(v) => patchRef("ticketTypeId", v)} disabled={!selected}><SelectTrigger><SelectValue placeholder="Optional ticket type" /></SelectTrigger><SelectContent>{(selected?.ticketOptions || []).map((ticket) => <SelectItem key={ticket.id} value={String(ticket.id)}>{ticket.name} ({ticket.delegateCapacity} delegate{ticket.delegateCapacity === 1 ? "" : "s"})</SelectItem>)}</SelectContent></Select></Field>
    <Field label="Short description" wide><Input value={form.shortDescription || ""} onChange={(e) => update("shortDescription", e.target.value)} /></Field>
    <Field label="Description" wide><Textarea value={form.description || ""} onChange={(e) => update("description", e.target.value)} /></Field>
    <Field label="Capacity metadata" wide><Textarea placeholder='e.g. {"venueZone":"Hall A"}' value={typeof form.capacityMetadata === "string" ? form.capacityMetadata : JSON.stringify(form.capacityMetadata || {})} onChange={(e) => update("capacityMetadata", e.target.value)} />{form.delegateCapacity && <p className="mt-1 text-xs text-blue-700">Delegate capacity is derived from the linked ticket: {form.delegateCapacity}</p>}</Field>
  </>;
}

function BundleFields({ form, update }) { return <><Field label="Currency"><Input required maxLength="3" value={form.currency || "GBP"} onChange={(e) => update("currency", e.target.value.toUpperCase())} /></Field><Field label="Selling price (minor units)"><Input required type="number" min="0" value={form.sellingPriceMinor ?? ""} onChange={(e) => update("sellingPriceMinor", e.target.value)} /></Field><Field label="Minimum price (minor units)"><Input type="number" min="0" value={form.minimumPriceMinor ?? ""} onChange={(e) => update("minimumPriceMinor", e.target.value)} /></Field><Field label="Presentation mode"><Select value={form.presentationMode || "bundle"} onValueChange={(v) => update("presentationMode", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bundle">Single bundle line</SelectItem><SelectItem value="itemised">Itemised products</SelectItem></SelectContent></Select></Field><Field label="Available from"><Input type="date" value={form.availableFrom || ""} onChange={(e) => update("availableFrom", e.target.value)} /></Field><Field label="Available to"><Input type="date" value={form.availableTo || ""} onChange={(e) => update("availableTo", e.target.value)} /></Field></>; }
function BundleItems({ form, update, products }) { const items = form.items || []; const add = () => update("items", [...items, { productId: "", quantity: 1 }]); const patch = (index, key, value) => update("items", items.map((item, i) => i === index ? { ...item, [key]: key === "quantity" ? Number(value) : value } : item)); return <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="mb-2 flex items-center justify-between"><Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Included products</Label><Button type="button" variant="outline" size="sm" onClick={add}><Plus className="mr-1 h-3.5 w-3.5" />Add item</Button></div>{items.map((item, index) => <div key={index} className="mb-2 flex gap-2"><Select value={String(item.productId || "")} onValueChange={(v) => patch(index, "productId", v)}><SelectTrigger className="flex-1 bg-white"><SelectValue placeholder="Choose product" /></SelectTrigger><SelectContent>{products.filter((product) => product.isActive !== false).map((product) => <SelectItem key={product.id} value={String(product.id)}>{product.name}</SelectItem>)}</SelectContent></Select><Input className="w-20 bg-white" type="number" min="1" value={item.quantity} onChange={(e) => patch(index, "quantity", e.target.value)} /><Button type="button" variant="ghost" size="icon" onClick={() => update("items", items.filter((_, i) => i !== index))}><X className="h-4 w-4" /></Button></div>)}{items.length === 0 && <p className="py-3 text-sm text-slate-500">No products included yet.</p>}</div>; }
function Empty({ type, onCreate }) { const Icon = icon[type]; return <div className="flex min-h-72 flex-col items-center justify-center px-5 text-center"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-700"><Icon className="h-6 w-6" /></div><h2 className="mt-4 text-xl font-semibold text-slate-900">A clean catalogue begins here</h2><p className="mt-2 max-w-sm text-sm text-slate-600">Add your first {singular[type]} to give your sales team a well-organised starting point.</p><Button className="mt-5 bg-blue-600 text-white hover:bg-blue-700" onClick={onCreate}><Plus className="mr-2 h-4 w-4" />Add {singular[type]}</Button></div>; }
function Skeleton() { return <div className="space-y-3 p-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-12 animate-pulse rounded-lg bg-slate-100" />)}</div>; }
function Failure({ onRetry }) { return <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center"><p className="font-semibold text-slate-800">The catalogue could not be loaded.</p><p className="mt-1 text-sm text-slate-500">Check your connection and try again.</p><Button variant="outline" onClick={onRetry} className="mt-4">Try again</Button></div>; }
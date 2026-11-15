import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Handshake, X, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { useSponsorTenant } from "@/lib/useSponsorTenant";

export default function EventSponsorSelector({
  eventId, eventType = "simple", selectedSponsorIds = [], onSelectedSponsorIdsChange,
  sponsorDetails = {}, onSponsorDetailsChange, sponsorCategories = {}, onSponsorCategoryChange,
  assignmentsLoading = false, assignmentsError = false,
}) {
  const tenantId = useSponsorTenant();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [tempSelected, setTempSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [categoryEditor, setCategoryEditor] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [saving, setSaving] = useState(false);
  const scope = { event_id: eventId, event_type: eventType };
  const categoryKey = ['/api/entities/EventSponsorCategory', tenantId, eventType, eventId];
  const sponsorsQuery = useQuery({
    queryKey: ['/api/entities/EventSponsor', tenantId],
    queryFn: () => base44.entities.EventSponsor.listAll({ sort: { name: 'asc' } }),
  });
  const categoriesQuery = useQuery({
    queryKey: categoryKey,
    queryFn: () => base44.entities.EventSponsorCategory.listAll({ filter: scope, sort: { display_order: 'asc' } }),
    enabled: !!eventId,
  });
  const sponsors = sponsorsQuery.data || [];
  const categories = categoriesQuery.data || [];
  const sponsorMap = useMemo(() => Object.fromEntries(sponsors.map(s => [s.id, s])), [sponsors]);
  const locked = assignmentsLoading || assignmentsError;
  const categoriesLocked = !eventId || categoriesQuery.isLoading || categoriesQuery.isError || saving || locked;

  const saveCategory = async () => {
    if (!categoryEditor?.name.trim() || categoriesLocked) return;
    setSaving(true);
    try {
      const data = { ...scope, name: categoryEditor.name.trim(), display_order: Number(categoryEditor.display_order) || 0 };
      if (categoryEditor.id) {
        if (!categories.some(c => c.id === categoryEditor.id)) throw new Error("Category does not belong to this event.");
        await base44.entities.EventSponsorCategory.update(categoryEditor.id, data);
      } else {
        await base44.entities.EventSponsorCategory.create(data);
      }
      await queryClient.invalidateQueries({ queryKey: categoryKey });
      setCategoryEditor(null);
      toast.success("Event sponsor category saved");
    } catch (err) {
      toast.error(err.message || "Could not save category");
    } finally {
      setSaving(false);
    }
  };

  const deleteCategory = async () => {
    if (!deletingCategory || categoriesLocked) return;
    setSaving(true);
    try {
      if (!categories.some(c => c.id === deletingCategory.id)) throw new Error("Category does not belong to this event.");
      await base44.entities.EventSponsorCategory.delete(deletingCategory.id);
      // Only clear this event's local selections after a successful deletion.
      Object.entries(sponsorCategories).forEach(([id, categoryId]) => {
        if (categoryId === deletingCategory.id) onSponsorCategoryChange?.(id, null);
      });
      await queryClient.invalidateQueries({ queryKey: categoryKey });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorAssignment'] });
      setDeletingCategory(null);
      toast.success("Category deleted from this event");
    } catch (err) {
      toast.error(err.message || "Could not delete category");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="flex items-center gap-2"><Handshake className="h-4 w-4 text-slate-500" />Sponsors</Label>
      <p className="text-xs text-slate-500">Choose sponsors and categories for this event only. Sponsor details remain independent of other events.</p>
      {assignmentsLoading && <div role="status" className="rounded-md bg-slate-100 p-3 text-sm text-slate-600 animate-pulse">Loading existing sponsor assignments...</div>}
      {assignmentsError && <p role="alert" className="text-sm text-red-600">Existing assignments could not be loaded. They will not be changed on save. Reload this page to try again.</p>}
      {sponsorsQuery.isLoading ? <div role="status" className="h-12 rounded-md bg-slate-100 animate-pulse" aria-label="Loading sponsors" /> :
        sponsorsQuery.isError ? <div role="alert" className="text-sm text-red-600">Could not load sponsors. <Button type="button" variant="outline" size="sm" onClick={() => sponsorsQuery.refetch()}>Retry</Button></div> :
          <Button type="button" variant="outline" className="w-full justify-start" disabled={locked} onClick={() => { setTempSelected([...selectedSponsorIds]); setSearch(""); setModalOpen(true); }} data-testid="button-select-sponsors">
            <Handshake className="h-4 w-4 mr-2 text-blue-600" />{selectedSponsorIds.length ? `${selectedSponsorIds.length} sponsors selected` : "Select sponsors"}
          </Button>}
      {!sponsorsQuery.isLoading && !sponsorsQuery.isError && !sponsors.length && <p className="text-sm text-slate-600">No sponsors yet. <a href="/SponsorManagement" className="text-blue-600 hover:underline">Add sponsors</a> to make them available here.</p>}
      {selectedSponsorIds.map(id => {
        const sponsor = sponsorMap[id];
        const categoryId = sponsorCategories[id];
        return <div key={id} className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {sponsor?.logo_url && <img src={sponsor.logo_url} alt="" className="h-8 w-8 object-contain" />}
            <span className="flex-1 text-sm font-medium text-slate-900">{sponsor?.name || "Assigned sponsor"}</span>
            <Button type="button" variant="ghost" size="icon" disabled={locked} aria-label={`Remove ${sponsor?.name || 'sponsor'}`} onClick={() => onSelectedSponsorIdsChange(selectedSponsorIds.filter(s => s !== id))} data-testid={`button-remove-sponsor-chip-${id}`}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`sponsor-category-${id}`} className="text-xs">Category for this event</Label>
              <Select value={categoryId || "none"} disabled={categoriesLocked || !onSponsorCategoryChange} onValueChange={value => onSponsorCategoryChange(id, value === "none" ? null : value)}>
                <SelectTrigger id={`sponsor-category-${id}`} data-testid={`select-sponsor-category-${id}`}><SelectValue placeholder="Uncategorised" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorised</SelectItem>
                  {categoryId && !categories.some(c => c.id === categoryId) && <SelectItem value={categoryId} disabled>Assigned category (unavailable)</SelectItem>}
                  {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {onSponsorDetailsChange && <div className="space-y-1">
              <Label htmlFor={`sponsor-detail-${id}`} className="text-xs">Sponsorship detail</Label>
              <Input id={`sponsor-detail-${id}`} disabled={locked} value={sponsorDetails[id] || ""} onChange={e => onSponsorDetailsChange(id, e.target.value)} placeholder="e.g. Lunch (optional)" data-testid={`input-sponsor-detail-${id}`} />
            </div>}
          </div>
        </div>;
      })}
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <span className="text-sm font-medium text-slate-700">This event's sponsor categories</span>
          <Button type="button" variant="outline" size="sm" disabled={categoriesLocked} onClick={() => setCategoryEditor({ name: "", display_order: categories.length })} data-testid="button-create-category"><Plus className="h-3.5 w-3.5 mr-1" />Add category</Button>
        </div>
        {!eventId ? <p className="text-xs text-slate-500">Save this event first to create sponsor categories. You can select sponsors now without a category.</p> :
          categoriesQuery.isLoading ? <div role="status" className="h-8 rounded bg-slate-100 animate-pulse" aria-label="Loading categories" /> :
            categoriesQuery.isError ? <div role="alert" className="text-sm text-red-600">Could not load categories. Existing selections are preserved. <Button type="button" size="sm" variant="outline" onClick={() => categoriesQuery.refetch()}>Retry</Button></div> :
              !categories.length ? <p className="text-xs text-slate-500">No categories yet. Sponsors can stay uncategorised.</p> :
                categories.map(c => <div key={c.id} className="flex items-center gap-2 border-t pt-2">
                  <span className="flex-1 text-sm text-slate-700">{c.name}</span>
                  <span className="text-xs text-slate-500">Order {c.display_order || 0}</span>
                  <Button type="button" size="icon" variant="ghost" disabled={categoriesLocked} aria-label={`Edit ${c.name}`} onClick={() => setCategoryEditor({ ...c })}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button type="button" size="icon" variant="ghost" disabled={categoriesLocked} aria-label={`Delete ${c.name}`} onClick={() => setDeletingCategory(c)}><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
                </div>)}
      </div>
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md max-h-[80dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Select Sponsors</DialogTitle><DialogDescription>Choose sponsors for this event. Set their categories after selecting.</DialogDescription></DialogHeader>
          <Input aria-label="Search sponsors" placeholder="Search sponsors..." value={search} onChange={e => setSearch(e.target.value)} />
          <div className="space-y-1">
            {sponsors.filter(s => s.name?.toLowerCase().includes(search.toLowerCase())).map(s => <label key={s.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-slate-50 cursor-pointer">
              <Checkbox checked={tempSelected.includes(s.id)} onCheckedChange={() => setTempSelected(prev => prev.includes(s.id) ? prev.filter(id => id !== s.id) : [...prev, s.id])} />
              {s.logo_url && <img src={s.logo_url} alt="" className="w-8 h-8 object-contain" />}<span className="text-sm">{s.name}</span>
            </label>)}
            {!sponsors.some(s => s.name?.toLowerCase().includes(search.toLowerCase())) && <p className="p-3 text-sm text-slate-500">No matching sponsors.</p>}
          </div>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="button" disabled={locked} onClick={() => { onSelectedSponsorIdsChange(tempSelected); setModalOpen(false); }} data-testid="button-confirm-sponsor-modal">Confirm ({tempSelected.length})</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!categoryEditor} onOpenChange={open => { if (!open && !saving) setCategoryEditor(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{categoryEditor?.id ? "Edit" : "Add"} sponsor category</DialogTitle><DialogDescription>Only this event will use this category.</DialogDescription></DialogHeader>
          <Label htmlFor="event-sponsor-category-name">Name *</Label>
          <Input id="event-sponsor-category-name" value={categoryEditor?.name || ""} disabled={saving} onChange={e => setCategoryEditor(prev => ({ ...prev, name: e.target.value }))} data-testid="input-category-name" />
          <Label htmlFor="event-sponsor-category-order">Display order</Label>
          <Input id="event-sponsor-category-order" type="number" value={categoryEditor?.display_order ?? 0} disabled={saving} onChange={e => setCategoryEditor(prev => ({ ...prev, display_order: e.target.value }))} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={() => setCategoryEditor(null)}>Cancel</Button><Button type="button" disabled={categoriesLocked || !categoryEditor?.name.trim()} onClick={saveCategory} data-testid="button-save-category">{saving ? "Saving..." : "Save category"}</Button></div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deletingCategory} onOpenChange={open => { if (!open && !saving) setDeletingCategory(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deletingCategory?.name}?</AlertDialogTitle><AlertDialogDescription>Sponsors in this category will become uncategorised for this event only. Other events will not change.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><AlertDialogAction disabled={categoriesLocked} onClick={e => { e.preventDefault(); deleteCategory(); }} className="bg-red-600 hover:bg-red-700">{saving ? "Deleting..." : "Delete category"}</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

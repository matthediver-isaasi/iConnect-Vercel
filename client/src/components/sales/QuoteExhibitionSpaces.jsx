import { useState } from "react";
import { Button } from "@/components/ui/button";
import { exhibitionMoney, exhibitionOf, selectionsOf } from "./exhibition";
import { useExhibition } from "./useExhibition";

function SpaceSlot({ slot, line, quoteId, disabled, onSelect }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const selected = selectionsOf(line).find(item => item.slotKey === slot.key);
  const spaces = useExhibition({ resource: "spaces", quoteId, lineId: line.persistedLineId, slotKey: slot.key }, open && !disabled);
  const incomplete = Number(spaces.data?.total || 0) > (spaces.data?.items?.length || 0);
  const choose = async spaceId => {
    setError("");
    try { await onSelect(slot.key, spaceId); setOpen(false); }
    catch (failure) { setError(failure.message || "Space could not be saved. The previous selection is still shown. Retry after refreshing availability."); }
  };
  return <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs text-slate-500">Space · line unit {slot.lineUnit ?? 1}{slot.componentUnit != null ? ` · component unit ${slot.componentUnit}` : ""}{slot.requirementUnit != null ? ` · requirement unit ${slot.requirementUnit}` : ""}</p>
        <p className="mt-1 text-sm font-semibold text-slate-800">{selected ? <>{selected.reference} <span className="ml-2 font-normal tabular-nums">{exhibitionMoney(selected.priceMinor, selected.currency)}</span></> : "No space selected"}</p>
      </div>
      <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setOpen(!open); setError(""); }}>{open ? "Close spaces" : selected ? "Replace space" : "Choose space"}</Button>
        {selected && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => choose(null)}>Release</Button>}
      </div>
    </div>
    {open && !disabled && <div className="mt-3 border-t pt-3">
      {spaces.isPending || spaces.isFetching ? <div role="status" className="animate-pulse rounded bg-slate-100 p-4 text-xs">Loading available spaces…</div> : spaces.isError ? <p role="alert" className="text-sm text-rose-700">{spaces.error.message} <Button type="button" variant="link" onClick={() => spaces.refetch()}>Retry spaces</Button></p> : incomplete ? <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><p>Availability results are incomplete: {spaces.data.items?.length || 0} of {spaces.data.total} spaces returned. Choosing a space is disabled to avoid presenting a partial list as complete. Contact your administrator; complete availability must be returned before selecting.</p><Button type="button" variant="link" className="px-0" onClick={() => spaces.refetch()}>Retry spaces</Button></div> : <>
        <label className="block text-xs font-medium text-slate-600">Available for this saved proposal event
          <select aria-label={`Space for slot ${slot.key}`} className="mt-1 h-10 w-full rounded-md border bg-white px-2 text-sm" value={selected?.spaceId || ""} onChange={event => event.target.value && choose(event.target.value)}>
            <option value="">Select a reference and price</option>
            {selected && !spaces.data?.items?.some(item => item.id === selected.spaceId) && <option value={selected.spaceId}>{selected.reference} · current selection</option>}
            {(spaces.data?.items || []).map(item => <option key={item.id} value={item.id} disabled={item.status !== "available" && item.id !== selected?.spaceId}>{item.reference} · {exhibitionMoney(item.price_minor, item.currency)} · {item.status}</option>)}
          </select>
        </label>
        {!spaces.data?.items?.length && <p className="mt-2 text-xs text-slate-500">No matching spaces are available. Ask a catalogue manager to check this event’s inventory.</p>}
        <Button type="button" variant="link" size="sm" className="px-0" onClick={() => spaces.refetch()}>Refresh availability</Button>
      </>}
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-rose-700">{error}</p>}
  </div>;
}

export default function QuoteExhibitionSpaces({ line, quoteId, eventId, readOnly, disabled, onSelect }) {
  const slots = exhibitionOf(line)?.slots || [];
  const selected = selectionsOf(line);
  return <section className="mt-3 space-y-2 rounded-lg border border-blue-100 bg-blue-50/40 p-3" aria-label="Exhibition spaces">
    <h4 className="text-sm font-semibold text-slate-800">Exhibition spaces</h4>
    <p className="text-xs leading-relaxed text-slate-600">{line.type === "bundle" ? "Bundle prices stay fixed. Choose a space independently for every included unit." : "One space per product unit. Saving a quantity greater than one creates separate, individually priced lines."} Selections save immediately. Releasing a selection or saving a line deletion releases its hold.</p>
    {!eventId && <p className="text-sm font-medium text-amber-800">Choose an Event in the proposal details above, then save the draft to select spaces.</p>}
    {readOnly ? selected.length ? <ul className="space-y-1 text-sm">{selected.map(item => <li key={item.slotKey} className="flex justify-between gap-3 rounded border bg-white p-2"><strong>{item.reference}</strong><span>{exhibitionMoney(item.priceMinor, item.currency)}</span></li>)}</ul> : <p className="text-sm text-slate-500">No spaces selected on this version.</p> : <>
      {eventId && (!quoteId || !line.persistedLineId || !slots.length) && <p className="text-sm font-medium text-blue-800">Save draft first to receive space slots for this line.</p>}
      {eventId && disabled && slots.length > 0 && <p className="text-xs font-medium text-amber-800">Save your edits before choosing, replacing or releasing spaces. Space controls are locked while saving or reloading.</p>}
      {slots.map(slot => <SpaceSlot key={slot.key} slot={slot} line={line} quoteId={quoteId} disabled={disabled || !eventId || !quoteId || !line.persistedLineId} onSelect={onSelect} />)}
    </>}
  </section>;
}

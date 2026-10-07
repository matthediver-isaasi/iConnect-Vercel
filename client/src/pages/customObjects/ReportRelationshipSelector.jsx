import React, { useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveRelationshipPickerPath, relationshipEndpoint } from "./relationshipHelpers";
import { endpointLabel, reportPathLabel } from "./reportHelpers.mjs";

const safePath = (value) => Array.isArray(value) && value.every((hop) =>
  hop && typeof hop === "object" && ["source", "target"].includes(hop.from_side)
  && hop.relationship_definition_id != null) ? value : [];

export function ReportRelationshipSelector({
  value, onChange, start, definitions = [], objects = [], object,
  disabled = false, metadataLoading = false, allowRoot = true, label = "Related records",
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [search, setSearch] = useState("");
  const searchRef = useRef(null);
  const triggerRef = useRef(null);
  const resolve = (path) => resolveRelationshipPickerPath({ definitions, start, path, maxHops: 6 });
  const saved = resolve(safePath(value));
  const current = resolve(draft);
  const name = endpointLabel(current.endpoint, objects, object);
  const validSaved = Array.isArray(value) && !saved.error && value.length <= 6
    && (allowRoot || value.length > 0) && safePath(value).length === value.length;
  const options = current.options.map(({ definition, from_side }) => {
    const destination = relationshipEndpoint(definition, from_side === "source" ? "target" : "source");
    return {
      definition, from_side,
      name: endpointLabel(destination, objects, object),
      relationship: (from_side === "source" ? definition.source_label : definition.target_label)
        || definition.relationship_key || "Related records",
    };
  });
  const filtered = options.filter((option) =>
    `${option.name} ${option.relationship} ${option.definition.relationship_key || ""} ${option.definition.id}`
      .toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const navigate = (path) => {
    setDraft(path);
    setSearch("");
    searchRef.current?.focus();
  };
  return <div className="min-w-0 space-y-1">
    <Button ref={triggerRef} type="button" variant="outline" className="h-auto min-h-10 w-full justify-between gap-2 whitespace-normal text-left"
      disabled={disabled || metadataLoading} aria-label={label} onClick={() => {
        setDraft(validSaved ? safePath(value) : []); setSearch(""); setOpen(true);
      }}>
      <span className="min-w-0 break-words line-clamp-2 [overflow-wrap:anywhere]">{metadataLoading ? "Loading relationships…" : validSaved
        ? `${endpointLabel(saved.endpoint, objects, object)}${value.length ? ` · ${value.length === 1 ? "direct relationship" : `${value.length} relationship steps`}` : " · starting records"}`
        : "Choose related records — saved selection unavailable"}</span><ChevronRight className="h-4 w-4 shrink-0" />
    </Button>
    {validSaved && value.length > 0 && <p className="break-words text-xs text-slate-500 line-clamp-2 [overflow-wrap:anywhere]">
      {value.map((hop) => {
        const definition = definitions.find((item) => String(item.id) === String(hop.relationship_definition_id));
        return (hop.from_side === "source" ? definition?.source_label : definition?.target_label)
          || definition?.relationship_key || "Relationship";
      }).join(" / ")}
    </p>}
    <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical path details</summary>
      <p className="mt-1 break-words [overflow-wrap:anywhere]">{reportPathLabel(safePath(value), definitions, objects, object, start)}</p>
      {!validSaved && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(value)}</pre>}
    </details>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto"
      onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}
      onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
      <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>
        Choose one relationship at a time. Use the current records, or continue to another related record type.
      </DialogDescription></DialogHeader>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!draft.length} onClick={() => navigate(draft.slice(0, -1))}>
            <ArrowLeft className="mr-1 h-4 w-4" />Back
          </Button>
          <p aria-live="polite" title={name} className="min-w-0 break-words text-sm line-clamp-2 [overflow-wrap:anywhere]">{name} · step {draft.length} of 6</p>
        </div>
        <Input ref={searchRef} aria-label="Search relationships" placeholder="Search records or relationships"
          value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {filtered.map(({ definition, from_side, name: destination, relationship }) => <Button
            type="button" variant="outline" key={`${definition.id}:${from_side}`}
            className="h-auto w-full justify-between gap-2 whitespace-normal py-3 text-left"
            onClick={() => navigate([...draft, { relationship_definition_id: String(definition.id), from_side }])}>
            <span className="min-w-0 break-words [overflow-wrap:anywhere]"><span title={destination} className="font-medium line-clamp-2">{destination}</span>
              <span title={relationship} className="text-xs font-normal text-slate-500 line-clamp-2">{relationship}</span>
              <span title={`${definition.relationship_key || definition.id} · ${from_side}`} className="text-xs font-normal text-slate-500 line-clamp-2">{definition.relationship_key || definition.id} · {from_side}</span>
            </span><ChevronRight className="h-4 w-4 shrink-0" />
          </Button>)}
          {!filtered.length && <p role="status" className="rounded border border-dashed p-3 text-sm text-slate-500">
            {draft.length === 6 ? "Six-step limit reached. Use these records or go back." : search ? "No relationships match your search." : "No further authorised relationships. Use these records or go back."}
          </p>}
        </div>
        <Button type="button" className="h-auto w-full whitespace-normal break-words [overflow-wrap:anywhere]"
          disabled={Boolean(current.error) || (!allowRoot && !draft.length)}
          onClick={() => { onChange(draft); setOpen(false); }}><span title={name} className="min-w-0 line-clamp-2">Use {name}</span></Button>
      </div>
    </DialogContent></Dialog>
  </div>;
}

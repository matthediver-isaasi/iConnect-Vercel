import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Building2 } from "lucide-react";
import { useFormAlertTenant } from "@/hooks/useFormAlerts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { loadAffiliationReview, saveAffiliationResolution } from "./memberAffiliationApi";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validOptions = records => Array.isArray(records)
  && records.every(record => idPattern.test(record?.id || "") && typeof record.label === "string" && record.label.trim())
  && new Set(records.map(record => record.id)).size === records.length;
export function hasLinkedAffiliationReview(marker, config, submissionId) {
  return config?.affiliation_review?.enabled === true && marker?.active === true
    && idPattern.test(marker.review_id || "")
    && marker.due_diligence_submission_id === submissionId;
}
export function normalizeAffiliationResolution(value) {
  if (!value || (value.primary !== null && !idPattern.test(value.primary || ""))
    || !Array.isArray(value.departments) || !Array.isArray(value.secondary)
    || [...value.departments, ...value.secondary].some(id => !idPattern.test(id))) {
    throw new Error("The proposed affiliation set is incomplete. Reload this review before continuing.");
  }
  return { primary: value.primary, departments: [...new Set(value.departments)].sort(),
    secondary: [...new Set(value.secondary)].sort() };
}

function OrganizationPicker({ id, value, records, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" id={id} role="combobox" aria-expanded={open} disabled={disabled}
        variant="outline" className="w-full justify-between font-normal">
        {records.find(record => record.id === value)?.label || (value ? "Unavailable saved organisation" : "No primary organisation")}
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
      <Command>
        <CommandInput placeholder="Search existing organisations…" />
        <CommandList>
          <CommandEmpty>No matching organisations.</CommandEmpty>
          <CommandItem onSelect={() => { onChange(null); setOpen(false); }}>No primary organisation</CommandItem>
          {records.map(record => <CommandItem key={record.id} value={`${record.label} ${record.id}`}
            onSelect={() => { onChange(record.id); setOpen(false); }}>
            <Check className={`mr-2 h-4 w-4 ${value === record.id ? "opacity-100" : "opacity-0"}`} />
            {record.label}
          </CommandItem>)}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

function RecordSetPicker({ label, records, value, onChange, disabled }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const filtered = records.filter(record => record.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const unavailable = value.filter(selected => !records.some(record => record.id === selected));
  return <fieldset disabled={disabled} className="space-y-2 rounded-md border border-slate-200 p-3">
    <legend className="px-1 text-sm font-medium">{label} · {value.length} selected</legend>
    <Label htmlFor={`${id}-search`} className="sr-only">Search {label.toLowerCase()}</Label>
    <Input id={`${id}-search`} placeholder={`Search ${label.toLowerCase()}…`} value={search}
      onChange={event => setSearch(event.target.value)} />
    <div className="max-h-48 space-y-2 overflow-y-auto py-1">
      {filtered.map(record => <div key={record.id} className="flex items-start gap-2">
        <Checkbox id={`${id}-${record.id}`} checked={value.includes(record.id)}
          onCheckedChange={checked => onChange(checked === true ? [...value, record.id] : value.filter(item => item !== record.id))} />
        <Label htmlFor={`${id}-${record.id}`} className="text-sm font-normal leading-4">{record.label}</Label>
      </div>)}
      {!filtered.length && <p className="py-2 text-xs text-slate-500">No matching records. Create missing records through the normal admin process, then reload this review.</p>}
      {unavailable.map(selected => <div key={selected} className="flex items-center justify-between gap-2 text-xs text-amber-800">
        <span>Unavailable selection retained</span>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(value.filter(item => item !== selected))}>Remove mapping</Button>
      </div>)}
    </div>
  </fieldset>;
}

export default function MemberAffiliationReview(props) {
  const context = useFormAlertTenant("page_ReviewSubmission");
  return <MemberAffiliationReviewPanel {...props} context={context} />;
}

// Export the actual panel for isolated mounted tests without an auth bypass.
export function MemberAffiliationReviewPanel({ submissionId, context, onApprovalReadyChange, refreshKey }) {
  const callback = useRef(onApprovalReadyChange);
  callback.current = onApprovalReadyChange;
  const ready = context?.status === "ready";
  return <ReviewSession key={`${submissionId}:${context?.scopeKey || "unverified"}`} submissionId={submissionId}
    context={context} ready={ready} onApprovalReadyChange={value => callback.current?.(value)} refreshKey={refreshKey} />;
}

function ReviewSession({ submissionId, context, ready, onApprovalReadyChange, refreshKey }) {
  const id = useId();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const busy = useRef(false);
  const contextRef = useRef(context);
  contextRef.current = context;
  const callback = useRef(onApprovalReadyChange);
  callback.current = onApprovalReadyChange;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; callback.current?.(false); };
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    setLoading(true); setError(""); setMessage(""); setConfirmed(false);
    loadAffiliationReview(submissionId, { context: contextRef.current, signal: controller.signal })
      .then(result => {
        if (result.active !== true || !result.review || !Number.isInteger(result.review.version)
          || !["pending", "approved", "rejected"].includes(result.review.status)
          || !Array.isArray(result.review.details)
          || result.review.details.some(detail => !["organization", "department"].includes(detail?.kind)
            || typeof detail.requestedName !== "string")
          || !validOptions(result.options?.organizations) || !validOptions(result.options?.departments)
          || result.options.complete !== true) {
          throw new Error("This protected affiliation review could not be verified. Reload before approving.");
        }
        const initial = normalizeAffiliationResolution(result.review.resolution || result.review.proposal);
        if (!controller.signal.aborted) {
          setData(result); setDraft(initial);
          setSaved(result.review.resolution ? normalizeAffiliationResolution(result.review.resolution) : null);
        }
      }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [submissionId, ready, attempt, refreshKey]);
  const dirty = !same(draft, saved);
  const editable = data?.review.status === "pending";
  const organizations = data?.options.organizations || [];
  const departments = data?.options.departments || [];
  const eligibleDepartments = useMemo(() => {
    const finalOrganizations = new Set([draft?.primary, ...(draft?.secondary || [])].filter(Boolean));
    return departments.filter(record => (Array.isArray(record.organizationIds) ? record.organizationIds : [record.organizationId])
      .some(organizationId => finalOrganizations.has(organizationId)));
  }, [departments, draft?.primary, draft?.secondary]);
  const invalid = !!draft && (
    (draft.primary && !organizations.some(record => record.id === draft.primary))
    || draft.secondary.some(value => value === draft.primary || !organizations.some(record => record.id === value))
    || draft.departments.some(value => !eligibleDepartments.some(record => record.id === value))
  );
  const canApprove = ready && !loading && !saving && !error && editable && !!saved && !dirty && !invalid;
  useEffect(() => { callback.current?.(canApprove); }, [canApprove]);

  async function save() {
    if (!confirmed || invalid || busy.current) return;
    busy.current = true; setSaving(true); setError(""); setMessage("");
    try {
      const result = await saveAffiliationResolution(submissionId, normalizeAffiliationResolution(draft), data.review.version,
        { context: contextRef.current });
      if (!active.current) return;
      const resolution = normalizeAffiliationResolution(result.review?.resolution);
      if (!Number.isInteger(result.review.version) || result.review.version <= data.review.version) {
        throw new Error("The saved resolution was not confirmed. Reload before approving.");
      }
      setData(current => ({ ...current, ...result }));
      setDraft(resolution); setSaved(resolution); setConfirmed(false);
      setMessage("Resolution saved. Affiliations have not changed. Use the Status control to approve or reject.");
    } catch (failure) {
      if (active.current) setError(failure.message || "Resolution could not be saved. Your choices have been kept.");
    } finally {
      busy.current = false;
      if (active.current) setSaving(false);
    }
  }
  const edit = patch => { setDraft(current => ({ ...current, ...patch })); setConfirmed(false); setMessage(""); };
  return <Card className="border-slate-200" data-testid="member-affiliation-review">
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-lg"><Building2 className="h-5 w-5 text-blue-600" />Affiliation renewal review</CardTitle>
      <p className="text-sm text-muted-foreground">Resolve requested names to existing records before approval. No shared records are created here.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-slate-700">
        Renewal and normal payment checks continue independently. Existing affiliations remain unchanged until
        this review is approved atomically. Join actions are not part of this workflow.
      </div>
      {!ready ? <p role="status" className="text-sm">Verifying reviewer access…</p>
        : loading ? <div role="status" aria-label="Loading affiliation review" className="space-y-2">
          <div className="h-5 w-2/3 rounded bg-slate-100" /><div className="h-20 rounded bg-slate-100" />
        </div> : data && draft ? <>
          <div className="rounded-md border border-slate-200 p-3">
            <h3 className="mb-2 text-sm font-medium">Names submitted for review</h3>
            <ul className="space-y-2 text-sm text-slate-700">{data.review.details.map((detail, index) => <li key={index}>
              <span className="text-xs text-slate-500">{detail.kind === "organization" ? "Organisation" : "Department"}
                {detail.rowKey ? ` · Additional site ${index + 1}` : ""}</span>
              <p className="break-words font-medium">{detail.requestedName}</p>
            </li>)}</ul>
          </div>
          <fieldset disabled={!editable || saving} className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor={`${id}-primary`}>Final primary organisation</Label>
              <OrganizationPicker id={`${id}-primary`} records={organizations} value={draft.primary}
                disabled={!editable || saving} onChange={primary => edit({ primary })} />
            </div>
            <RecordSetPicker label="Additional organisations" records={organizations} value={draft.secondary}
              disabled={!editable || saving} onChange={secondary => edit({ secondary })} />
            <RecordSetPicker label="Departments" records={eligibleDepartments} value={draft.departments}
              disabled={!editable || saving} onChange={departments => edit({ departments })} />
            <p className="text-xs text-slate-500">These are the complete final sets. Removing a selection requests its removal on approval.
              Changing organisations never silently clears department selections.</p>
            {invalid && <p role="alert" className="text-sm text-amber-800">
              Review unavailable selections, duplicate primary/additional organisations, and departments outside the final organisations.
            </p>}
            {editable && <div className="flex items-start gap-2">
              <Checkbox id={`${id}-confirmed`} checked={confirmed} onCheckedChange={checked => setConfirmed(checked === true)} />
              <Label htmlFor={`${id}-confirmed`} className="text-sm font-normal leading-5">
                I have matched every requested name to an existing record and checked the complete final affiliation set.
              </Label>
            </div>}
          </fieldset>
          {editable ? <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={save} disabled={saving || !confirmed || invalid || !dirty}>
              {saving ? "Saving resolution…" : "Save resolution"}
            </Button>
            <Button type="button" variant="outline" disabled={saving || !dirty || !saved}
              onClick={() => { setDraft(saved); setConfirmed(false); setError(""); setMessage(""); }}>Discard changes</Button>
          </div> : <p role="status" className="text-sm">This review is {data.review.status}. Resolution editing is closed.</p>}
          {canApprove && <p className="text-sm text-slate-700">Saved resolution ready. Choose the approval stage in Status to apply it, or the rejection stage to keep existing affiliations.</p>}
        </> : null}
      {error && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{error}</p>
        <p className="text-xs text-slate-500">Approval is paused. Reloading discards unsaved resolution choices and fetches the current saved review.</p>
        <Button type="button" variant="outline" disabled={saving} onClick={() => setAttempt(value => value + 1)}>Reload review</Button>
      </div>}
      {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
    </CardContent>
  </Card>;
}

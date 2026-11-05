import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import FormMemberAffiliations from "./FormMemberAffiliations";

async function request(method, body, signal) {
  const response = await fetch("/api/member-affiliations", {
    method, credentials: "include", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || data?.message || (typeof data?.error === "string" && data.error) || `Unable to ${method === "GET" ? "load" : "update"} affiliations (${response.status}).`);
  if (!data) throw new Error("The affiliation service returned an invalid response.");
  return data;
}

function ChoicePicker({ label, kind, snapshot, draft, onSelect, disabled }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setFilter(search); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["member-affiliation-choices", snapshot.token, kind, filter, page, draft.primary?.id ?? null, draft.secondary.map(item => item.id)],
    queryFn: ({ signal }) => request("POST", {
      action: "choices", token: snapshot.token, kind, search: filter, page,
      primary: draft.primary?.id ?? null, secondary: draft.secondary.map(item => item.id),
    }, signal),
    retry: false,
    staleTime: 0,
  });
  const selected = item => kind === "department"
    ? draft.departments.some(value => value.id === item.id)
    : draft.primary?.id === item.id || draft.secondary.some(value => value.id === item.id);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <label className="block text-sm font-medium">
        {label}
        <Input className="mt-2" value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${kind === "department" ? "departments" : "organisations"}`} disabled={disabled} maxLength={100} />
      </label>
      <div aria-live="polite" aria-busy={isFetching}>
        {isLoading ? <Skeleton className="h-16 w-full" /> : error ? (
          <div role="alert" className="text-sm text-red-700">{error.message} <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>Retry choices</Button></div>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {(data?.items || []).map(item => (
              <li key={item.id} className="flex items-center justify-between gap-2 rounded p-2 text-sm bg-slate-50">
                <span>{item.label}{item.organizationLabel && <span className="block text-xs text-slate-500">{item.organizationLabel}</span>}</span>
                <Button type="button" variant="outline" size="sm" disabled={disabled || selected(item) || isFetching} onClick={() => onSelect(item)}>{selected(item) ? "Selected" : "Select"}</Button>
              </li>
            ))}
            {!data?.items?.length && <li className="p-2 text-sm text-slate-500">No available choices on this page. Existing links below are retained even if unavailable here.</li>}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <Button type="button" variant="ghost" size="sm" disabled={disabled || isFetching || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button>
        <span>Page {page}</span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || isFetching || !data?.hasMore || !!error} onClick={() => setPage(value => value + 1)}>Next</Button>
      </div>
    </div>
  );
}

const fromSnapshot = snapshot => ({
  primary: snapshot.primary, secondary: [...snapshot.secondary], departments: [...snapshot.departments],
});
const payload = draft => ({
  primary: draft.primary?.id ?? null,
  secondary: draft.secondary.map(item => item.id),
  departments: draft.departments.map(item => item.id),
});

export default function MemberAffiliations({ onSaved }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const triggerRef = useRef(null);
  const stageRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [discard, setDiscard] = useState(null);
  const [committed, setCommitted] = useState(false);
  const [snapshotError, setSnapshotError] = useState(false);
  async function load(signal) {
    setLoading(true);
    setError("");
    try {
      const data = await request("GET", null, signal);
      if (signal?.aborted) return;
      if (data.mode !== "forms" && data.active !== false && (data.active !== true || !data.token || !Object.prototype.hasOwnProperty.call(data, "primary") || !Array.isArray(data.secondary) || !Array.isArray(data.departments) || typeof data.secondaryEnabled !== "boolean")) throw new Error("The affiliation snapshot is incomplete. Editing is unavailable.");
      setSnapshot(data);
      setDraft(data.active && data.mode !== "forms" ? fromSnapshot(data) : null);
      setCommitted(false);
      setSnapshotError(false);
      return true;
    } catch (err) {
      if (!signal?.aborted) { setError(err.message); setSnapshotError(true); }
      return false;
    } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (editorOpen) stageRef.current?.focus();
  }, [editorOpen, review, discard]);
  const dirty = !!draft && JSON.stringify(payload(draft)) !== JSON.stringify(payload(fromSnapshot(snapshot)));
  const removals = draft ? [
    ...(snapshot.primary && snapshot.primary.id !== draft.primary?.id ? [`Primary organisation: ${snapshot.primary.label}`] : []),
    ...snapshot.secondary.filter(item => !draft.secondary.some(value => value.id === item.id)).map(item => `Secondary organisation: ${item.label}`),
    ...snapshot.departments.filter(item => !draft.departments.some(value => value.id === item.id)).map(item => `Department: ${item.label}`),
  ] : [];
  function update(next) { setDraft(next); setReview(false); setConfirmed(false); setMessage(""); }
  function dismiss() {
    if (saving || loading) return;
    if (discard) return;
    if (dirty && !committed) setDiscard("close");
    else setEditorOpen(false);
  }
  async function reload() {
    const wasCommitted = committed;
    const fresh = await load();
    if (fresh && wasCommitted) setEditorOpen(false);
  }
  async function save() {
    if (!review || !dirty || saving || committed || (removals.length && !confirmed)) return;
    setSaving(true);
    setError("");
    try {
      const result = await request("PATCH", { token: snapshot.token, ...payload(draft) });
      if (result.committed !== true) throw new Error("The server did not confirm the save. Your draft has been retained.");
      setCommitted(true);
      setReview(false);
      setMessage("Affiliations saved.");
      const fresh = await load();
      try { await onSaved?.(); } catch { setError("Affiliations were saved, but profile information could not be refreshed. Please refresh the page after saving any other edits."); }
      if (fresh) setEditorOpen(false);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  if (snapshot?.active === false && !error) return null;
  if (snapshot?.mode === "forms") return <FormMemberAffiliations affiliation={snapshot} />;
  const blocked = saving || loading || committed || snapshotError;
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5 text-blue-600" />My affiliations</CardTitle>
        <CardDescription>Manage your organisations and departments. These changes are saved separately from your profile.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!editorOpen && error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {!editorOpen && message && <p role="status" className="text-sm text-green-700">{message}</p>}
        {loading && !snapshot && <div role="status"><span className="sr-only">Loading affiliations</span><Skeleton className="h-24 w-full" /></div>}
        {snapshot?.active && <dl data-testid="saved-affiliations" className="grid gap-3 text-sm sm:grid-cols-3 [overflow-wrap:anywhere]">
          <div><dt className="font-medium">Primary organisation</dt><dd>{snapshot.primary?.label || "No primary organisation"}</dd></div>
          {(snapshot.secondaryEnabled || snapshot.secondary.length > 0) && <div><dt className="font-medium">Secondary organisations</dt><dd>{snapshot.secondary.map(item => item.label).join(", ") || "No secondary organisations"}</dd></div>}
          <div><dt className="font-medium">Departments</dt><dd>{snapshot.departments.length ? <ul>{snapshot.departments.map(item => <li key={item.id}>{item.label}{item.organizationLabel && <span className="text-slate-500"> — {item.organizationLabel}</span>}{item.protected && <span className="text-xs text-slate-500"> (Protected link)</span>}</li>)}</ul> : "No departments linked."}</dd></div>
        </dl>}
        <div className="flex flex-wrap gap-2">
          {snapshot?.active && <Button ref={triggerRef} type="button" disabled={loading || saving || snapshotError || committed} onClick={() => { setDraft(fromSnapshot(snapshot)); setReview(false); setDiscard(null); setConfirmed(false); setError(""); setMessage(""); setEditorOpen(true); }}>Update my affiliations</Button>}
          {snapshotError && <Button type="button" variant="outline" disabled={loading || saving} onClick={reload}>Reload affiliation snapshot</Button>}
        </div>
        <Dialog open={editorOpen} onOpenChange={open => { if (!open) dismiss(); }}>
          <DialogContent hideCloseButton className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden p-4 sm:p-6 [overflow-wrap:anywhere]" onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}>
            <DialogHeader className="shrink-0">
              <DialogTitle ref={stageRef} tabIndex={-1}>{discard ? (discard === "reload" ? "Reload affiliation snapshot?" : "Discard affiliation edits?") : review ? "Review affiliation changes" : "Update my affiliations"}</DialogTitle>
              <DialogDescription>Your other profile edits are not included in this save and will be left untouched.</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto overscroll-contain space-y-4 pr-1" data-testid="affiliation-dialog-body">
            {discard ? <p className="text-sm">{discard === "reload" ? "Reloading discards your affiliation draft and reads the latest saved links. It makes no changes on the server." : "Your affiliation draft will be discarded without saving."}</p> : <>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {committed && <p role="status" className="text-sm">Your affiliations were saved. Reload the snapshot to see the latest saved links; do not submit again.</p>}
            {loading ? <Skeleton aria-label="Loading affiliations" className="h-24 w-full" /> : draft && !review && !committed && !snapshotError && (
          <fieldset disabled={blocked || review} className="min-w-0 space-y-5">
            <div className="space-y-2">
              <h3 className="font-medium text-sm">Primary organisation</h3>
              <div className="flex items-center justify-between gap-2 text-sm"><span>{draft.primary?.label || "No primary organisation"}</span>{draft.primary && <Button type="button" variant="ghost" size="sm" onClick={() => update({ ...draft, primary: null })}>Clear primary</Button>}</div>
              <ChoicePicker key={`primary-${draft.primary?.id}-${draft.secondary.map(item => item.id).join(",")}`} label="Choose primary organisation" kind="organization" snapshot={snapshot} draft={draft} disabled={blocked || review} onSelect={item => update({ ...draft, primary: item })} />
            </div>
            {(snapshot.secondaryEnabled || draft.secondary.length > 0) && <div className="space-y-2">
              <h3 className="font-medium text-sm">Secondary organisations</h3>
              {!snapshot.secondaryEnabled && <p className="text-xs text-slate-500">Secondary editing is disabled. Existing links are retained.</p>}
              {draft.secondary.map(item => <div key={item.id} className="flex items-center justify-between gap-2 text-sm"><span>{item.label}</span>{snapshot.secondaryEnabled && <Button type="button" variant="ghost" size="sm" onClick={() => update({ ...draft, secondary: draft.secondary.filter(value => value.id !== item.id) })}>Remove<span className="sr-only"> {item.label}</span></Button>}</div>)}
              {snapshot.secondaryEnabled && <ChoicePicker key={`secondary-${draft.primary?.id}-${draft.secondary.map(item => item.id).join(",")}`} label="Add secondary organisation" kind="organization" snapshot={snapshot} draft={draft} disabled={blocked || review} onSelect={item => update({ ...draft, secondary: [...draft.secondary, item] })} />}
            </div>}
            <div className="space-y-2">
              <h3 className="font-medium text-sm">Departments</h3>
              <p className="text-xs text-slate-500">Changing organisations never removes departments automatically. Existing links are retained, including those unavailable in search.</p>
              {!draft.departments.length && <p className="text-sm text-slate-500">No departments linked.</p>}
              {draft.departments.map(item => <div key={item.id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm"><span>{item.label}{item.organizationLabel && <span className="block text-xs text-slate-500">{item.organizationLabel}</span>}</span>{item.protected ? <span className="flex items-center gap-1 text-xs text-slate-500"><Lock className="h-3 w-3" />Protected link</span> : <Button type="button" variant="ghost" size="sm" onClick={() => update({ ...draft, departments: draft.departments.filter(value => value.id !== item.id) })}>Remove<span className="sr-only"> {item.label}</span></Button>}</div>)}
              <ChoicePicker key={`department-${draft.primary?.id}-${draft.secondary.map(item => item.id).join(",")}`} label="Add department" kind="department" snapshot={snapshot} draft={draft} disabled={blocked || review} onSelect={item => update({ ...draft, departments: [...draft.departments, item] })} />
            </div>
          </fieldset>
            )}
            {review && draft && <div className="space-y-3 text-sm">
              <p><strong>Primary:</strong> {draft.primary?.label || "None (cleared)"}</p>
              <p><strong>Secondary:</strong> {draft.secondary.map(item => item.label).join(", ") || "None"}</p>
              <p><strong>Departments:</strong> {draft.departments.map(item => item.label).join(", ") || "None"}</p>
              {removals.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 p-3"><p className="font-medium">Links to remove</p><ul className="list-disc pl-5">{removals.map(item => <li key={item}>{item}</li>)}</ul><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={saving} /><span>I explicitly confirm these removals, including any cleared selections.</span></label></div>}
            </div>}
            </>}
            </div>
            <DialogFooter className="shrink-0 gap-2 sm:space-x-0 sm:flex-wrap">
            {discard ? <>
              <Button type="button" variant="outline" onClick={() => setDiscard(null)}>Keep editing</Button>
              <Button type="button" onClick={() => { const action = discard; setDiscard(null); setReview(false); setConfirmed(false); if (action === "reload") reload(); else { setDraft(fromSnapshot(snapshot)); setError(""); setMessage(""); if (action === "close") setEditorOpen(false); } }}>Discard{discard === "reload" ? " and reload" : " affiliation draft"}</Button>
            </> : review ? <>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setReview(false)}>Back to editing</Button>
              <Button type="button" disabled={blocked || (removals.length > 0 && !confirmed)} onClick={save}>{saving ? "Saving affiliations…" : "Confirm and save affiliations"}</Button>
            </> : <>
          {draft && <><Button type="button" disabled={!dirty || blocked} onClick={() => { setConfirmed(false); setReview(true); }}>Review affiliation changes</Button><Button type="button" variant="outline" disabled={!dirty || blocked} onClick={() => setDiscard("cancel")}>Cancel affiliation edits</Button></>}
          <Button type="button" variant="outline" disabled={loading || saving} onClick={() => committed ? reload() : setDiscard("reload")}>Reload affiliation snapshot</Button>
            </>}
            {!discard && <Button type="button" variant="outline" disabled={loading || saving} onClick={dismiss}>Close</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

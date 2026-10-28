import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadMemberChangeFormSettings, saveMemberChangeFormSettings } from "@/lib/memberChangeFormSettings";

const selection = data => ({
  enabled: data.enabled === true,
  targetConfigIds: [...(data.targetConfigIds || [])],
});
const matches = (a, b) => a && b && a.enabled === b.enabled
  && a.targetConfigIds.length === b.targetConfigIds.length
  && a.targetConfigIds.every(id => b.targetConfigIds.includes(id));
const denied = error => [401, 403].includes(error?.status);

// A keyed session keeps drafts and responses isolated across form/tenant changes.
export default function MemberChangeFormSettings({ formId, tenantContext, persistedAuthentication }) {
  return (
    <Card className="mt-6 border-slate-200" data-testid="member-change-form-settings">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5 text-blue-600" aria-hidden="true" />
          Membership-change settings
        </CardTitle>
        <p className="text-sm text-muted-foreground">Protected configuration, saved separately from the form.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-slate-700">
          These settings enable a separate member request and administrator review journey. Ordinary form submission is unchanged.
          Saving settings, submitting requests and approving review do not automatically change membership or run payments, refunds or credits.
        </div>
        {!formId ? (
          <p className="text-sm text-muted-foreground">Save this form first to configure membership changes.</p>
        ) : tenantContext?.status !== "ready" ? (
          <p role={tenantContext?.status === "loading" ? "status" : "alert"} className="text-sm text-muted-foreground">
            {tenantContext?.status === "loading"
              ? "Verifying your tenant and access…"
              : tenantContext?.error || "Your tenant or access could not be verified. Reload the page before continuing."}
          </p>
        ) : (
          <SettingsSession
            key={JSON.stringify([formId, tenantContext.scopeKey, tenantContext.tenantId])}
            formId={formId}
            tenantContext={tenantContext}
            persistedAuthentication={persistedAuthentication}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SettingsSession({ formId, tenantContext, persistedAuthentication }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const context = useRef(tenantContext);
  context.current = tenantContext;
  const active = useRef(false);
  const requestId = useRef(0);
  const controller = useRef(null);
  const busy = useRef(false);
  const draftRef = useRef(null);
  const loadRef = useRef(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestId.current += 1;
      controller.current?.abort();
    };
  }, []);

  const current = id => {
    if (!active.current || requestId.current !== id) return false;
    try { context.current.assertCurrent(); return true; } catch { return false; }
  };

  async function load(preserve = true) {
    controller.current?.abort();
    const abortController = new AbortController();
    controller.current = abortController;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setMessage("");
    try {
      context.current.assertCurrent();
      const data = await loadMemberChangeFormSettings(formId, abortController.signal);
      if (!current(id)) return;
      if (String(data.formId) !== String(formId)) throw new Error("Settings did not match this form. Retry loading.");
      setSaved(data);
      if (!preserve || !draftRef.current) {
        draftRef.current = selection(data);
        setDraft(draftRef.current);
      } else {
        setMessage("Latest settings loaded. Your unsaved choices have been kept; review them before saving.");
      }
      setConflict(false);
    } catch (failure) {
      if (active.current && requestId.current === id && failure.name !== "AbortError") setError(failure);
    } finally {
      if (active.current && requestId.current === id) setLoading(false);
    }
  }
  loadRef.current = load;
  useEffect(() => {
    // A concurrent generic form save may update persisted authentication.
    // Do not interrupt a protected save; its readback refreshes prerequisites.
    if (!busy.current) loadRef.current(true);
  }, [persistedAuthentication]);

  function edit(next) {
    draftRef.current = next;
    setDraft(next);
    setMessage("");
  }

  const options = saved?.targetOptions || [];
  const activeIds = new Set(options.map(option => option.id));
  const missingIds = draft?.targetConfigIds.filter(id => !activeIds.has(id)) || [];
  const hasActiveTarget = draft?.targetConfigIds.some(id => activeIds.has(id));
  const authenticationRequired = draft?.enabled && saved?.requiresAuthentication !== true;
  const targetRequired = draft?.enabled && !hasActiveTarget;
  const unavailableTargets = draft?.enabled && missingIds.length > 0;
  const dirty = saved && !matches(draft, selection(saved));
  const blocked = loading || saving || denied(error);

  async function save() {
    if (busy.current || blocked || conflict || !dirty || authenticationRequired || targetRequired || unavailableTargets) return;
    busy.current = true;
    const id = ++requestId.current;
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      context.current.assertCurrent();
      // The protected save helper has no signal parameter. Never invent a
      // transport; suppress late POST results after a scope change instead.
      await saveMemberChangeFormSettings({
        formId, enabled: draft.enabled,
        targetConfigIds: [...draft.targetConfigIds], revision: saved.revision,
      });
      if (!current(id)) return;
      // Read back authoritative revision and prerequisites, not local formData.
      controller.current?.abort();
      const abortController = new AbortController();
      controller.current = abortController;
      const data = await loadMemberChangeFormSettings(formId, abortController.signal);
      if (!current(id)) return;
      if (String(data.formId) !== String(formId)) throw new Error("Settings did not match this form. Reload settings to verify the save.");
      setSaved(data);
      draftRef.current = selection(data);
      setDraft(draftRef.current);
      setConflict(false);
      setMessage("Membership-change settings saved. Share the separate member review link below. No automatic membership changes or financial transactions will run.");
    } catch (failure) {
      if (!current(id) || failure.name === "AbortError") return;
      setError(failure);
      if (failure.status === 409) setConflict(true);
    } finally {
      busy.current = false;
      if (active.current && requestId.current === id) setSaving(false);
    }
  }

  return (
    <div className="space-y-4" aria-busy={loading || saving}>
      {loading && (
        <div role="status" aria-label="Loading membership-change settings" className="space-y-3">
          <span className="text-sm text-muted-foreground">Loading protected settings…</span>
          <div className="h-9 rounded-md bg-slate-100 motion-safe:animate-pulse" />
          <div className="h-16 rounded-md bg-slate-100 motion-safe:animate-pulse" />
        </div>
      )}
      {error && (
        <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-slate-800">
          <p>{denied(error)
            ? "Permission denied. You do not have access to manage these protected settings. Check your session or ask a tenant administrator."
            : conflict
              ? "These settings changed elsewhere. Reload the latest revision before saving. Your unsaved choices will be kept."
              : error.message || "Settings could not be loaded or saved."}</p>
          <Button type="button" variant="outline" size="sm" disabled={loading || saving} onClick={() => load(true)}>
            {conflict ? "Reload latest settings" : "Retry loading settings"}
          </Button>
        </div>
      )}
      {draft && saved && (
        <>
          <fieldset disabled={blocked} className="space-y-4">
            <label className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-blue-600" checked={draft.enabled}
                onChange={event => edit({ ...draft, enabled: event.target.checked })} />
              <span className="text-sm"><span className="font-medium">Enable membership-change configuration</span>
                  <span className="mt-1 block text-muted-foreground">Allows authenticated members to preview an eligible membership change and request administrator review through the separate link. Upfront and monthly availability depends on server eligibility and financial evidence checks. You can disable it without clearing selections.</span>
              </span>
            </label>
            <div className="space-y-2">
              <p className="text-sm font-medium">Active member structures</p>
              <p className="text-xs text-muted-foreground">Select at least one active structure when enabling this configuration.</p>
              {options.length === 0 && <p className="rounded-md bg-slate-50 p-3 text-sm text-muted-foreground">No active member structures are available. You can still disable the configuration.</p>}
              {options.map(option => (
                <label key={option.id} className="flex items-center gap-3 rounded-md border border-slate-200 p-3 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-blue-600"
                    checked={draft.targetConfigIds.includes(option.id)}
                    onChange={event => edit({ ...draft, targetConfigIds: event.target.checked
                      ? [...draft.targetConfigIds, option.id]
                      : draft.targetConfigIds.filter(id => id !== option.id) })} />
                  {option.name}
                </label>
              ))}
              {missingIds.map(id => (
                <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">Unavailable saved target</p>
                    <p className="break-all text-xs">{id}</p>
                    <p className="mt-1 text-xs">No longer in active discovery. Kept until you remove it.</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" aria-label={`Remove unavailable target ${id}`}
                    onClick={() => edit({ ...draft, targetConfigIds: draft.targetConfigIds.filter(value => value !== id) })}>Remove</Button>
                </div>
              ))}
            </div>
          </fieldset>
          {authenticationRequired && <p className="text-sm text-amber-800">Form authentication must already be saved. Enable “Require authentication” in the form settings, save the form, then reload these settings.</p>}
          {targetRequired && <p className="text-sm text-amber-800">Select at least one active member structure before saving an enabled configuration.</p>}
          {unavailableTargets && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>Remove all unavailable targets before saving an enabled configuration, even when an active structure is selected. Alternatively, disable the configuration to keep these selections.</p>
              <Button type="button" variant="outline" size="sm" disabled={blocked}
                onClick={() => edit({ ...draft, targetConfigIds: draft.targetConfigIds.filter(id => activeIds.has(id)) })}>
                Remove unavailable targets
              </Button>
            </div>
          )}
          {saved.formActive === false && <p className="text-sm text-muted-foreground">This form is inactive. Saving this configuration does not activate it.</p>}
          <div className="space-y-2 rounded-md border bg-muted/30 p-4 text-sm">
            <p className="font-medium">Separate membership review link</p>
            <p className="text-muted-foreground">Share this link with members, not the ordinary form link. Ordinary form submission is unchanged. Members must sign in and the saved form must be active, require authentication and have membership changes enabled. Approval does not execute any financial operation.</p>
            <a className="block break-all font-medium underline underline-offset-4" target="_blank" rel="noopener noreferrer" href={`/MembershipChange?formId=${encodeURIComponent(formId)}`}>Open member review journey</a>
            <label className="block text-xs text-muted-foreground" htmlFor={`member-change-link-${formId}`}>Copy and share this link</label>
            <input id={`member-change-link-${formId}`} className="w-full rounded-md border bg-background p-2 text-xs" readOnly
              onFocus={event => event.target.select()}
              value={`${window.location.origin}/MembershipChange?formId=${encodeURIComponent(formId)}`} />
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <Button type="button" onClick={save} disabled={blocked || conflict || !dirty || authenticationRequired || targetRequired || unavailableTargets}>
              {saving ? "Saving settings…" : "Save membership-change settings"}
            </Button>
            <Button type="button" variant="outline" disabled={loading || saving} onClick={() => load(true)}>Reload settings</Button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved membership-change settings</span>}
          </div>
        </>
      )}
      {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
    </div>
  );
}

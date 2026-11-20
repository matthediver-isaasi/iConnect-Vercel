import React, { useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, LockKeyhole, RotateCw, ShieldAlert, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const endpoint = (objectId) => `/api/custom-objects/${encodeURIComponent(objectId)}/report-sharing`;

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Sharing settings could not be updated.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function ReportSharingControls({ objectId, report, dirty }) {
  const [settings, setSettings] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [ackPublic, setAckPublic] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setHidden(false);
    setError("");
    setNotice("");
    setPassword("");
    setNeedsPassword(false);
    setAckPublic(false);
    if (!report?.id) return undefined;
    setLoading(true);
    request(`${endpoint(objectId)}?report_id=${encodeURIComponent(report.id)}`)
      .then((data) => { if (active) { setSettings(data); setHidden(data.can_manage === false); } })
      .catch((err) => {
        if (!active) return;
        if (err.status === 403) setHidden(true);
        else setError(err.message);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [objectId, report?.id]);

  if (hidden || !report?.id) return null;

  const mutate = async (action, extra = {}) => {
    if (pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await request(endpoint(objectId), {
        method: "POST",
        body: JSON.stringify({ report_id: report.id, action, expected_revision: settings?.revision, ...extra }),
      });
      setSettings(next);
      setPassword("");
      setNeedsPassword(false);
      setAckPublic(false);
      setNotice(action === "revoke" ? "The previous link has been disabled."
        : action === "rotate" ? "A new private link is ready."
        : action === "sync" ? "The saved report is up to date."
        : "Sharing settings saved.");
    } catch (err) {
      if (err.status === 403) setHidden(true);
      else setError(err.message);
    } finally { setPending(false); }
  };

  const copyLink = async () => {
    if (!settings?.url) return;
    try {
      await navigator.clipboard.writeText(settings.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setError("Could not copy the link. Select and copy it manually."); }
  };
  const shareEnabled = settings?.enabled === true;
  const passwordRequired = settings?.password_required !== false;

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5" aria-label="External report sharing">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-800"><Link2 className="h-4 w-4" /></span>
          <div>
            <h3 className="font-semibold text-slate-900">External link</h3>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-600">Readers see only this saved report, not the iConnect CRM. Unsaved report edits are not included.</p>
          </div>
        </div>
        {loading && <span role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading sharing settings</span>}
      </div>
      {dirty && <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Save your report changes before sharing. The external view uses the last saved version.</p>}
      {settings && <div className="mt-4 space-y-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-teal-700" checked={shareEnabled} disabled={pending || dirty}
            onChange={(event) => {
              if (event.target.checked && passwordRequired && settings.enabled !== true) setNeedsPassword(true);
              if (!event.target.checked) setNeedsPassword(false);
              setSettings((current) => ({ ...current, enabled: event.target.checked }));
            }} />
          <span><span className="font-medium text-slate-900">Enable external access</span><span className="mt-0.5 block text-slate-600">Only people with this capability link can open the report.</span></span>
        </label>
        <div className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={passwordRequired} disabled={pending}
              onChange={(event) => {
                if (event.target.checked && settings.password_required === false && shareEnabled) setNeedsPassword(true);
                if (!event.target.checked) setNeedsPassword(false);
                setSettings((current) => ({ ...current, password_required: event.target.checked }));
              }} />
            Require a password
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={settings.allow_csv === true} disabled={pending}
              onChange={(event) => setSettings((current) => ({ ...current, allow_csv: event.target.checked }))} />
            Allow CSV download
          </label>
          {passwordRequired && <div className="sm:col-span-2">
            <Label htmlFor={`share-password-${report.id}`}>Set or change password <span className="font-normal text-slate-500">(12–128 characters)</span></Label>
            <Input id={`share-password-${report.id}`} type="password" autoComplete="new-password" maxLength={128} minLength={12}
              value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 max-w-md"
              placeholder={shareEnabled ? "Leave blank to keep the current password" : "Enter a password"} />
          </div>}
        </div>
        {!passwordRequired && <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <div className="flex gap-2 text-sm font-semibold text-amber-950"><ShieldAlert className="h-4 w-4 shrink-0" />Anyone with the link can view this report without a password.</div>
          <label className="mt-2 flex items-start gap-2 text-sm text-amber-900">
            <input type="checkbox" checked={ackPublic} onChange={(event) => setAckPublic(event.target.checked)} />
            I understand this link grants public access to the saved report.
          </label>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={pending || dirty || (!passwordRequired && !ackPublic)
            || (passwordRequired && shareEnabled && needsPassword && !password)
            || (password.length > 0 && password.length < 12)}
            onClick={() => mutate("save", { enabled: shareEnabled, password_required: passwordRequired,
              allow_csv: settings.allow_csv === true, ...(password ? { password } : {}),
              ...(!passwordRequired ? { acknowledge_public: ackPublic } : {}) })}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save sharing
          </Button>
          {shareEnabled && settings.url && <>
            <Button type="button" variant="outline" size="sm" onClick={copyLink}><Copy className="mr-2 h-4 w-4" />{copied ? "Copied" : "Copy external link"}</Button>
            <Button type="button" variant="outline" size="sm" disabled={pending || dirty} onClick={() => mutate("rotate")}><RotateCw className="mr-2 h-4 w-4" />Rotate link</Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => {
              if (window.confirm("Disable this link now? Anyone using the old link will lose access.")) mutate("revoke");
            }}><Unlink className="mr-2 h-4 w-4" />Revoke
            </Button>
          </>}
        </div>
        {shareEnabled && settings.url && <div className="rounded-md border border-slate-200 bg-white p-3">
          <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500"><LockKeyhole className="h-3.5 w-3.5" />Capability link · keep it private</p>
          <p className="break-all font-mono text-xs text-slate-700">{settings.url}</p>
        </div>}
      </div>}
      {!settings && !loading && !error && <p className="mt-4 text-sm text-slate-500">Choose a saved report to configure external access.</p>}
      {notice && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-teal-800"><Check className="h-4 w-4" />{notice}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    </section>
  );
}

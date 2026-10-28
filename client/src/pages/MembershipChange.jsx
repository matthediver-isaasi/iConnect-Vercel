import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MemberChangeRequestSummary, MemberChangeRequestRecord } from "@/components/MemberChangeRequestSummary";
import { useMemberChangeSession } from "@/hooks/useMemberChangeSession";
import { memberChangeRequest, requestDate } from "@/lib/memberChangeRequests";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const denied = error => [401, 403].includes(error?.status);
const validRecord = record => record?.id && ["pending", "approved", "rejected", "withdrawn"].includes(record.state);
function readAttempt(storageKey) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey) || "null");
    if (saved?.payload?.key && /^[a-f0-9]{64}$/.test(saved.payload.fingerprint || "")
      && saved.payload.selection?.configId && saved.preview?.summary) return saved;
  } catch { /* Submission will fail closed if recovery storage is unavailable. */ }
  return null;
}

export default function MembershipChange() {
  const location = useLocation();
  const session = useMemberChangeSession();
  const formId = new URLSearchParams(location.search).get("formId") || "";
  const loginHref = `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  return <main className="mx-auto min-h-[100dvh] max-w-3xl space-y-6 px-4 py-8 sm:py-12">
    <header className="space-y-3">
      <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Membership review</p>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Request a membership change</h1>
      <p className="text-sm text-muted-foreground">Preview an eligible membership change and ask an administrator to review it. Submitting a request does not change your membership; processing remains a separate administrator action.</p>
    </header>
    {!uuid.test(formId) ? <p role="alert" className="rounded-md border p-4 text-sm">This link does not contain a valid membership-change form. Ask your administrator for the complete link.</p>
      : session.status === "loading" ? <Loading />
        : session.status !== "ready" ? <Access loginHref={loginHref} />
          : <MembershipChangeSession key={`${formId}:${session.scopeKey}`} formId={formId} scope={session} loginHref={loginHref} />}
  </main>;
}

function Loading() {
  return <div role="status" aria-label="Loading membership review" className="space-y-3"><div className="h-9 rounded-md bg-muted motion-safe:animate-pulse" /><div className="h-32 rounded-md bg-muted motion-safe:animate-pulse" /></div>;
}
function Access({ loginHref, message }) {
  return <div role="alert" className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-slate-800">
    <p>{message || "Sign in with your member account to continue. If you are already signed in, your session or access could not be verified. This form may not be available to your account."}</p>
    <a className="font-medium underline underline-offset-4" href={loginHref}>Sign in with your member account</a>
  </div>;
}

export function MembershipChangeSession({ formId, scope, loginHref }) {
  const storageKey = `member-change-request:${scope.scopeKey}:${formId}`;
  const [restored] = useState(() => readAttempt(storageKey));
  const [data, setData] = useState(null);
  const [selection, setSelection] = useState(restored?.payload.selection
    ? { ...restored.payload.selection, bandId: restored.payload.selection.bandId || "" }
    : { configId: "", bandId: "", reason: "" });
  const [preview, setPreview] = useState(restored?.preview || null);
  const [consent, setConsent] = useState(!!restored);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(!!restored);
  const [notFound, setNotFound] = useState(false);
  const [historyStale, setHistoryStale] = useState(false);
  const [withdrawId, setWithdrawId] = useState(null);
  const attempt = useRef(restored?.payload || null);
  const active = useRef(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; lock.current = false; };
  }, []);
  function current(token) {
    if (!active.current || generation.current !== token) return false;
    try { scopeRef.current.assertCurrent(); return true; } catch { return false; }
  }
  async function run(action, payload = {}) {
    if (lock.current) return;
    lock.current = true;
    const token = ++generation.current;
    setBusy(action); setError(null); setMessage("");
    try {
      scopeRef.current.assertCurrent();
      const result = await memberChangeRequest(action, formId, payload);
      if (!current(token)) return;
      if (action === "member_change_context") {
        if (result?.form?.id !== formId || !Array.isArray(result.requests) || !Array.isArray(result.structures)) throw new Error("The server did not return this form's membership context.");
        setData(result); setWithdrawId(null); setHistoryStale(false);
        if (!attempt.current) { setPreview(null); setConsent(false); }
      } else if (action === "member_change_preview") {
        if (!result?.summary || !/^[a-f0-9]{64}$/.test(result.fingerprint || "")) throw new Error("A valid preview was not returned. Preview again.");
        setPreview(result);
      } else if (action === "member_change_recover" && result?.record === null) {
        // No new key, and no blind POST retry. Explicit continuation retains
        // the exact selection, consent, key and fingerprint of this attempt.
        setUncertain(false);
        setNotFound(true);
        setMessage("No saved request was found. You may submit the same reviewed request with its existing request key.");
      } else {
        const record = action === "member_change_recover" ? result?.record : result;
        if (!validRecord(record)) throw new Error("The request outcome was not confirmed. Reload or recover before continuing.");
        if (action === "member_change_withdraw" && (record.id !== payload.id || record.state !== "withdrawn")) throw new Error("Withdrawal was not confirmed. Reload request history.");
        setData(old => ({ ...old, requests: [record, ...old.requests.filter(item => item.id !== record.id)] }));
        try { window.sessionStorage.removeItem(storageKey); } catch { /* Confirmed server record remains authoritative. */ }
        attempt.current = null; setUncertain(false); setPreview(null); setConsent(false); setWithdrawId(null);
        setNotFound(false);
        setMessage(action === "member_change_withdraw" ? "Request withdrawn." : "Request recorded for administrator review. No membership change or transaction has been executed.");
      }
    } catch (failure) {
      if (!current(token)) return;
      setError(failure);
      if (action === "member_change_context") setHistoryStale(true);
      if (action === "member_change_submit" || action === "member_change_recover") setUncertain(true);
      if (action === "member_change_withdraw") setWithdrawId("reload");
    } finally {
      if (current(token)) { lock.current = false; setBusy(""); }
    }
  }
  useEffect(() => { void run("member_change_context"); }, []);
  const selected = data?.structures.find(item => item.id === selection.configId);
  const flat = selected?.pricingModel === "flat";
  const blockers = data?.blockers || [];
  const pending = data?.requests.some(item => item.state === "pending");
  const locked = !!busy || !!attempt.current || denied(error) || historyStale || withdrawId === "reload";
  const valid = !!selected && (flat || !!selection.bandId) && !!selection.reason.trim();
  function edit(field, value) {
    if (locked) return;
    generation.current += 1;
    setSelection(old => ({ ...old, [field]: value, ...(field === "configId" ? { bandId: "" } : {}) }));
    setPreview(null); setConsent(false); setError(null); setMessage("");
  }
  function submit() {
    if (lock.current || uncertain || historyStale || !consent || !preview || pending || blockers.length || denied(error)) return;
    if (!attempt.current) {
      const payload = {
        key: crypto.randomUUID(), fingerprint: preview.fingerprint,
        selection: { ...selection, bandId: flat ? null : selection.bandId, reason: selection.reason.trim() },
      };
      // Save BEFORE sending. A refresh or navigation must recover this attempt,
      // never manufacture a second key after a lost response.
      try { window.sessionStorage.setItem(storageKey, JSON.stringify({ payload, preview })); }
      catch { setError(new Error("Request recovery storage is unavailable in this browser. No request was sent. Enable session storage before submitting.")); return; }
      attempt.current = payload;
    }
    setNotFound(false);
    void run("member_change_submit", attempt.current);
  }
  return <div className="space-y-6" aria-busy={!!busy}>
    <div className="rounded-md border border-blue-100 bg-blue-50 p-4 text-sm text-slate-700">Administrator review is required. Submitting a request does not collect payment, issue credits or refunds, or change your membership. Approval alone is not evidence of application. Available upfront and monthly previews depend on your membership, financial evidence and server eligibility checks; not every change is supported.</div>
    {denied(error) ? <Access loginHref={loginHref} message={`${error.message} Sign in with your member account or ask an administrator to check your access.`} /> : error && <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-slate-800">{error.message}</div>}
    {message && <p role="status" className="rounded-md border p-3 text-sm">{message}</p>}
    {historyStale && data && <p role="alert" className="text-sm">Request history could not be refreshed. Reload request history before submitting or withdrawing a request.</p>}
    {!data && (busy ? <Loading /> : !denied(error) && <Button variant="outline" onClick={() => run("member_change_context")}>Retry loading membership review</Button>)}
    {data && <>
      <Card><CardHeader><CardTitle className="text-lg">{data.form.name || "Membership change"}</CardTitle></CardHeader><CardContent className="space-y-4">
        {data.current && <p className="text-sm text-muted-foreground">Current term started: {requestDate(data.current.startDate)} · Renewal: {requestDate(data.current.renewalDate)}</p>}
        {!!blockers.length && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-amber-800">{blockers.map((item, i) => <li key={i}>{typeof item === "string" ? item : item.message || item.code || "This request is blocked by server validation."}</li>)}</ul>}
        {pending && <p className="text-sm text-muted-foreground">You already have a pending request. Wait for review or withdraw it before requesting another change.</p>}
        {!data.structures.length && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No eligible membership structures are available on this form. Contact your administrator.</p>}
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && !locked && !pending && !blockers.length) { setPreview(null); setConsent(false); void run("member_change_preview", { selection: { ...selection, bandId: flat ? null : selection.bandId, reason: selection.reason.trim() } }); } }}>
          <fieldset disabled={locked || pending || !!blockers.length} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="request-structure">Target membership structure</Label>
              <select id="request-structure" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={selection.configId} onChange={event => edit("configId", event.target.value)} required>
                <option value="">Choose a structure</option>{data.structures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></div>
            <div className="space-y-2"><Label htmlFor="request-band">Pricing band</Label>
              <select id="request-band" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={selection.bandId} onChange={event => edit("bandId", event.target.value)} disabled={!selected || flat} required={!flat}>
                <option value="">{flat ? "Flat price — no band" : "Choose a band"}</option>{selected?.bands?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select></div>
            <div className="space-y-2"><Label htmlFor="request-reason">Reason for change</Label><Textarea id="request-reason" maxLength={2000} value={selection.reason} required onChange={event => edit("reason", event.target.value)} /></div>
          </fieldset>
          {!attempt.current && <Button type="submit" variant="outline" disabled={!valid || locked || pending || !!blockers.length}>{busy === "member_change_preview" ? "Preparing preview…" : "Preview request"}</Button>}
        </form>
        {preview && <section aria-label="Request preview" className="space-y-4 rounded-md border bg-muted/30 p-4">
          <h2 className="font-medium">Preview for review — no change applied</h2>
          <MemberChangeRequestSummary summary={preview.summary} />
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={consent} disabled={locked} onChange={event => setConsent(event.target.checked)} />I request administrator review of this preview. I understand this does not execute payment or change my membership.</label>
          {!uncertain && <Button onClick={submit} disabled={!consent || !!busy || pending || historyStale || !!blockers.length || denied(error)}>{busy === "member_change_submit" ? "Submitting request…" : attempt.current ? "Submit same request" : "Submit for review"}</Button>}
        </section>}
        {attempt.current && uncertain && <section className="space-y-3 rounded-md border border-amber-200 p-4 text-sm">
          <p>The submission outcome is unknown. Do not create another request. Check the saved outcome using the same request key.</p>
          <Button variant="outline" disabled={!!busy || denied(error)} onClick={() => run("member_change_recover", { key: attempt.current.key, fingerprint: attempt.current.fingerprint })}>Recover request outcome</Button>
        </section>}
        {attempt.current && notFound && <Button variant="outline" disabled={!!busy || denied(error)} onClick={() => {
          try { window.sessionStorage.removeItem(storageKey); }
          catch { setError(new Error("The saved recovery key could not be cleared. Keep this request and contact your administrator.")); return; }
          attempt.current = null; setNotFound(false); setPreview(null); setConsent(false); setError(null);
          setMessage("No saved request was found. The old preview has been discarded. Review a fresh preview before submitting.");
        }}>Discard unsubmitted preview</Button>}
      </CardContent></Card>
      <section className="space-y-3" aria-label="Your membership requests">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Your requests</h2>
          <Button variant="outline" size="sm" disabled={!!busy || !!attempt.current} onClick={() => run("member_change_context")}>Reload request history</Button></div>
        {!data.requests.length && <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No review requests yet. Preview your selection above before submitting.</p>}
        {data.requests.map(record => <MemberChangeRequestRecord key={record.id} record={record}>
          {record.state === "pending" && (withdrawId === record.id ? <div className="space-y-2 text-sm"><p>Withdraw this pending request? It will no longer be available for approval.</p><div className="flex flex-wrap gap-2"><Button variant="destructive" disabled={locked} onClick={() => run("member_change_withdraw", { id: record.id })}>Confirm withdrawal</Button><Button variant="outline" disabled={locked} onClick={() => setWithdrawId(null)}>Keep request</Button></div></div>
            : <Button variant="outline" size="sm" disabled={locked} onClick={() => setWithdrawId(record.id)}>Withdraw request</Button>)}
        </MemberChangeRequestRecord>)}
        {withdrawId === "reload" && <p role="alert" className="text-sm">Withdrawal outcome is unknown. Reload request history before trying another withdrawal.</p>}
      </section>
    </>}
  </div>;
}

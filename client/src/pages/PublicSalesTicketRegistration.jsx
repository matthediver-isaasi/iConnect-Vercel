import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Ticket, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const endpoint = "/api/public/sales-ticket-registration";
const emptyDetails = () => ({
  first_name: "", last_name: "", email: "", phone: "", organization: "", job_title: "",
  dietary_selections: [], allergy_selections: [], accessibility_selections: [],
});

// Only normal public event routes may receive attendee invitation links.
export function safeRegistrationUrl(value, origin = window.location.origin) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    const allowed = /^\/(?:events|session-events)\/[^/]+$/.test(url.pathname)
      || ["/EventDetails", "/ComplexEventDetail"].includes(url.pathname);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password || !allowed) return null;
    return url.href;
  } catch { return null; }
}

async function request(body, signal) {
  const response = await fetch(endpoint, {
    method: "POST", credentials: "include", signal,
    headers: { "Content-Type": "application/json" },
    referrerPolicy: "no-referrer", body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("The request could not be completed.");
    error.status = response.status;
    error.code = String(payload?.code || payload?.status || payload?.outcome || "").toLowerCase();
    throw error;
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid response");
  return payload;
}

function isExpired(error) {
  return error?.status === 410 || /expired|revoked|invalid_token/.test(error?.code || "");
}

// Render policy content as inert text, never as HTML or executable markup.
function policyText(html) {
  if (!html) return "";
  const doc = new window.DOMParser().parseFromString(String(html), "text/html");
  doc.querySelectorAll("script,style,iframe,object").forEach(node => node.remove());
  doc.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  doc.querySelectorAll("p,div,li,h1,h2,h3").forEach(node => node.append("\n"));
  return doc.body.textContent || "";
}

function deadlineText(value, timezone) {
  try {
    return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone || "UTC" });
  } catch { return new Date(value).toISOString(); }
}

function countdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m ${seconds % 60}s remaining`;
}

function AttendeeEditor({ slot, allocation, settings, token, closed, onSaved, onExpired }) {
  const [record, setRecord] = useState(slot);
  const [details, setDetails] = useState(() => ({ ...emptyDetails(), ...slot.details }));
  const [dirty, setDirty] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [codeAccepted, setCodeAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const attempt = useRef(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const policySignature = JSON.stringify([settings.terms, settings.codeOfConduct]);
  const acceptedPolicy = useRef(policySignature);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (acceptedPolicy.current !== policySignature) {
      acceptedPolicy.current = policySignature;
      setTermsAccepted(false);
      setCodeAccepted(false);
      attempt.current = null;
    }
  }, [policySignature]);
  useEffect(() => {
    // Background refreshes must not replace a purchaser's unsaved work, nor
    // roll a just-saved record back to an older context snapshot.
    if (!dirty && !busy.current && Number(slot.version) > Number(record.version)) {
      setRecord(slot);
      setDetails({ ...emptyDetails(), ...slot.details });
      setTermsAccepted(false);
      setCodeAccepted(false);
      attempt.current = null;
    }
  }, [slot, dirty, record.version]);

  const changed = () => {
    setDirty(true); setError(null); setNotice(""); attempt.current = null;
  };
  const patch = (key, value) => {
    changed();
    setDetails(current => ({ ...current, [key]: value }));
  };
  const toggle = (key, value) => {
    const current = details[key] || [];
    patch(key, current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  };
  const registered = record.status === "registered";
  const needsTerms = Boolean(settings.terms);
  const needsCode = Boolean(settings.codeOfConduct?.required);
  const acknowledged = (!needsTerms || termsAccepted) && (!needsCode || codeAccepted);

  async function save(complete) {
    if (busy.current || closed || (registered && !complete)) return;
    const deadline = Date.parse(allocation.closesAt);
    if (allocation.closed || (Number.isFinite(deadline) && allocation.serverTime() >= deadline)) return;
    if (complete && !acknowledged) return;
    const body = {
      action: "saveSlot", token, allocationId: allocation.id, slotId: record.id,
      expectedVersion: record.version, details, complete,
      termsAccepted, termsContent: settings.terms || "",
      codeOfConductAccepted: codeAccepted, codeOfConductContent: settings.codeOfConduct?.content || "",
    };
    const signature = JSON.stringify(body);
    if (!attempt.current || attempt.current.signature !== signature) {
      attempt.current = { signature, body: { ...body, commandId: crypto.randomUUID() } };
    }
    busy.current = true; setPending(true); setError(null); setNotice("");
    try {
      const result = await request(attempt.current.body);
      const saved = result.slot || result;
      if (!saved.id || !Number.isFinite(Number(saved.version)) || !["draft", "registered"].includes(saved.status)) throw new Error("Invalid response");
      if (!mounted.current) return;
      setRecord(saved);
      setDetails({ ...emptyDetails(), ...saved.details });
      setDirty(false);
      attempt.current = null;
      setNotice(saved.status === "registered" ? "Registration saved." : "Draft saved. Complete registration when the details are ready.");
      onSaved(allocation.id, saved);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason);
      if (isExpired(reason)) onExpired(reason);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const prefix = `attendee-${slot.id}`;
  return <Card className="border-slate-200">
    <CardHeader className="pb-3">
      <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-lg">
        <span>{[record.details?.first_name, record.details?.last_name].filter(Boolean).join(" ") || "New attendee"}</span>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${registered ? "bg-teal-50 text-teal-800" : "bg-slate-100 text-slate-600"}`}>{registered ? "Registered" : record.version ? "Draft" : "Not saved"}</span>
      </CardTitle>
      {dirty && <p className="text-xs text-amber-800">Unsaved changes — keep this tab open until saved.</p>}
    </CardHeader>
    <CardContent>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) save(true); }}>
        <fieldset disabled={pending || closed} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["first_name", "First name", "given-name", true],
              ["last_name", "Last name", "family-name", true],
              ["email", "Attendee email", "email", true],
              ["phone", "Phone", "tel", false],
              ["organization", "Organisation", "organization", false],
              ["job_title", "Job title", "organization-title", settings.requireJobTitle],
            ].map(([key, label, autoComplete, required]) => <div key={key}>
              <Label htmlFor={`${prefix}-${key}`}>{label}{required ? " *" : ""}</Label>
              <Input id={`${prefix}-${key}`} className="mt-1.5" type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} autoComplete={autoComplete} required={Boolean(required)} maxLength={key === "email" ? 254 : 200} value={details[key] || ""} onChange={event => patch(key, event.target.value)} />
            </div>)}
          </div>
          {settings.collectOptions && <>
            {[["dietary_options", "dietary_selections", "Dietary requirements"], ["accessibility_options", "accessibility_selections", "Accessibility requirements"]].map(([optionKey, detailKey, title]) => <fieldset key={optionKey} className="rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-medium">{title}</legend>
              {(allocation.options?.[optionKey] || []).length ? <div className="flex flex-wrap gap-x-5 gap-y-3">{allocation.options[optionKey].map(option => <label key={option} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(details[detailKey] || []).includes(option)} onChange={() => toggle(detailKey, option)} />{option}</label>)}</div> : <p className="text-sm text-slate-500">No options offered for this ticket.</p>}
            </fieldset>)}
            <fieldset className="space-y-3 rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-medium">Allergies</legend>
              {(allocation.options?.allergy_options || []).length ? allocation.options.allergy_options.map(option => {
                const selection = (details.allergy_selections || []).find(item => item.name === option);
                return <div key={option} className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(selection)} onChange={() => patch("allergy_selections", selection ? details.allergy_selections.filter(item => item.name !== option) : [...(details.allergy_selections || []), { name: option, severity: "mild" }])} />{option}</label>
                  {selection && <label className="flex items-center gap-2 text-xs text-slate-600">Severity for {option}<select aria-label={`Severity for ${option}`} className="rounded-md border border-slate-300 bg-slate-50 p-2 text-sm" value={selection.severity} onChange={event => patch("allergy_selections", details.allergy_selections.map(item => item.name === option ? { ...item, severity: event.target.value } : item))}>
                    <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
                  </select></label>}
                </div>;
              }) : <p className="text-sm text-slate-500">No allergy options offered for this ticket.</p>}
            </fieldset>
          </>}
          {needsTerms && <div className="rounded-lg bg-slate-100 p-4">
            <details><summary className="cursor-pointer text-sm font-semibold">Registration terms</summary><div className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{policyText(settings.terms)}</div></details>
            <label className="mt-4 flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={termsAccepted} onChange={event => { changed(); setTermsAccepted(event.target.checked); }} />I accept the registration terms for this attendee.</label>
          </div>}
          {settings.codeOfConduct && <div className="rounded-lg bg-slate-100 p-4">
            <details><summary className="cursor-pointer text-sm font-semibold">Code of conduct</summary><div className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{policyText(settings.codeOfConduct.content)}</div></details>
            <label className="mt-4 flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={codeAccepted} onChange={event => { changed(); setCodeAccepted(event.target.checked); }} />I accept the code of conduct for this attendee.{!needsCode && " (optional)"}</label>
          </div>}
        </fieldset>
        {error && <div role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">{error.status === 409 ? "This place changed or is no longer available. Your edits are retained. Refresh places to check the latest status; contact the organiser if there is a conflict." : "We couldn’t confirm your save. Retry unchanged details safely using the same request."}</div>}
        {notice && <p role="status" className="flex items-start gap-2 text-sm text-teal-800"><CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />{notice}</p>}
        {!closed && <div className="flex flex-wrap gap-3">
          {!registered && <Button type="button" variant="outline" disabled={pending} onClick={() => save(false)}>{pending ? "Saving…" : "Save draft"}</Button>}
          <Button type="submit" className="bg-teal-800 hover:bg-teal-900" disabled={pending || !acknowledged}>{pending ? "Saving…" : registered ? "Save registration changes" : "Complete registration"}</Button>
        </div>}
        {!closed && <p className="text-xs leading-relaxed text-slate-500">{registered ? "Changes update this attendee’s existing registration." : "Drafts can be saved with incomplete details. Required fields (*) and acknowledgements are needed to complete registration."}</p>}
      </form>
    </CardContent>
  </Card>;
}

function SelfRegistrationInvitation({ allocation, token, closed, serverTime, onRefresh, onExpired }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");
  const attempt = useRef(null);
  const activeRequest = useRef(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const capacity = Number(allocation.availableToAdd ?? allocation.remaining ?? 0);
  const disabled = closed || capacity <= 0 || pending;
  const patch = (key, value) => {
    setForm(current => ({ ...current, [key]: value }));
    attempt.current = null;
    setError(null);
  };
  async function submit(event) {
    event.preventDefault();
    const deadline = Date.parse(allocation.closesAt);
    if (activeRequest.current || disabled || result || (Number.isFinite(deadline) && serverTime() >= deadline) || !event.currentTarget.reportValidity()) return;
    const fields = { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim() };
    if (!fields.firstName || !fields.lastName || !fields.email) return;
    if (!attempt.current) attempt.current = { action: "register", token, allocationId: allocation.id, ...fields, idempotencyKey: crypto.randomUUID() };
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true); setError(null);
    try {
      const data = await request(attempt.current, controller.signal);
      const url = safeRegistrationUrl(data.registrationUrl);
      // A delegate link must never expose the purchaser's private credential.
      if (!url || decodeURIComponent(url).includes(token)) throw Object.assign(new Error("Invalid destination"), { code: "unsafe_url" });
      if (controller.signal.aborted) return;
      setResult({ url, name: `${fields.firstName} ${fields.lastName}`, email: fields.email });
      onRefresh();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason);
      if (isExpired(reason)) onExpired(reason);
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied("Attendee registration link copied.");
    } catch {
      setCopied("Copy is unavailable. Select and copy the attendee link below.");
    }
  }
  return <Card className="border-slate-200">
    <CardHeader><CardTitle className="text-lg">Attendee self-registration</CardTitle></CardHeader>
    <CardContent className="space-y-5">
      <p className="text-sm leading-relaxed text-slate-600">Group rules require attendees to register themselves. Create a private link for one attendee and share it with them so they can complete their own registration.</p>
      {result ? <div className="space-y-4">
        <div role="status" className="rounded-lg bg-teal-50 p-4 text-sm"><p className="font-semibold">{result.name}</p><p className="mt-1 text-slate-600">{result.email}</p><p className="mt-3">This link is for this attendee only. Their registration is not complete until they use it.</p></div>
        <Label htmlFor={`invite-link-${allocation.id}`}>Share this attendee’s registration link</Label>
        <Input id={`invite-link-${allocation.id}`} value={result.url} readOnly onFocus={event => event.target.select()} />
        <Button type="button" className="w-full bg-teal-800 hover:bg-teal-900" onClick={copyLink}>Copy attendee registration link</Button>
        {copied && <p role="status" className="text-sm text-slate-600">{copied}</p>}
        <Button type="button" variant="outline" disabled={disabled} onClick={() => {
          setResult(null); setForm({ firstName: "", lastName: "", email: "" }); setCopied(""); setError(null); attempt.current = null;
        }}>Invite another attendee</Button>
      </div> : <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={disabled} className="space-y-4">
          {[["firstName", "First name", "given-name"], ["lastName", "Last name", "family-name"], ["email", "Attendee email", "email"]].map(([key, label, autoComplete]) => <div key={key}>
            <Label htmlFor={`invite-${allocation.id}-${key}`}>{label}</Label>
            <Input className="mt-1.5" id={`invite-${allocation.id}-${key}`} type={key === "email" ? "email" : "text"} autoComplete={autoComplete} required maxLength={key === "email" ? 254 : 200} value={form[key]} onChange={event => patch(key, event.target.value)} />
          </div>)}
        </fieldset>
        {error && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">{error.code === "unsafe_url" ? "The attendee link could not be verified. Retry unchanged details or contact the organiser." : "We couldn’t confirm the attendee link. Retry unchanged details safely; the same request will be used."}</p>}
        <Button type="submit" className="w-full bg-teal-800 hover:bg-teal-900" disabled={disabled || !form.firstName.trim() || !form.lastName.trim() || !form.email.trim()}>{pending ? "Creating attendee link…" : error ? "Retry attendee link" : "Create attendee registration link"}</Button>
      </form>}
      {!closed && capacity <= 0 && <p className="text-sm text-slate-600">No places available to invite another attendee. Contact the organiser for help.</p>}
    </CardContent>
  </Card>;
}

function Allocation({ allocation, settings, token, now, serverTime, onSaved, onExpired, onRefresh }) {
  const [localSlots, setLocalSlots] = useState([]);
  const serverSlots = allocation.slots || [];
  const serverIds = new Set(serverSlots.map(slot => slot.id));
  const localOnly = localSlots.filter(slot => !serverIds.has(slot.id));
  const slots = [...serverSlots, ...localOnly];
  const deadline = Date.parse(allocation.closesAt);
  const closed = allocation.closed || (Number.isFinite(deadline) && now >= deadline);
  const remaining = allocation.requiresSelfRegistration
    ? Math.max(0, Number(allocation.availableToAdd ?? allocation.remaining ?? 0))
    : Math.max(0, Number(allocation.availableToAdd
      ?? Math.max(0, Number(allocation.remaining || 0) - serverSlots.filter(slot => slot.status !== "registered").length)) - localOnly.length);
  const legacyCount = Math.max(0, Number(allocation.registered || 0) - serverSlots.filter(slot => slot.status === "registered").length);
  return <section aria-label={`${allocation.eventName} — ${allocation.ticketName}`} className="space-y-4">
    <div className={`rounded-xl border p-5 ${closed ? "border-slate-200 bg-slate-100" : "border-teal-700 bg-teal-50"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{allocation.eventKind ? String(allocation.eventKind).replace(/[_-]/g, " ") : "Event"}</p>
      <h2 className="mt-2 text-xl font-semibold">{allocation.eventName}</h2>
      <p className="mt-1 text-sm text-slate-600">{allocation.ticketName}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-sm"><span>{allocation.allocated} purchased · {allocation.registered} registered</span><span className="font-semibold text-teal-800">{remaining} remaining</span></div>
      {allocation.closesAt && Number.isFinite(deadline) && <p className="mt-3 text-xs text-slate-600">Registration closes {deadlineText(allocation.closesAt, allocation.timezone)} ({allocation.timezone || "UTC"}).{!closed && <span className="ml-1 font-semibold" role="timer">{countdown(deadline - now)}</span>}</p>}
      {closed && <p className="mt-3 text-sm font-medium text-amber-900">Registration closed — read-only.{allocation.reason ? ` ${allocation.reason}` : " Contact the organiser for help with changes."}</p>}
    </div>
    {legacyCount > 0 && <p className="rounded-lg bg-slate-100 p-4 text-sm text-slate-600">{legacyCount} existing registration{legacyCount === 1 ? " is" : "s are"} not available to edit in this workspace. Contact the organiser to change those attendees.</p>}
    {allocation.requiresSelfRegistration ? <SelfRegistrationInvitation allocation={allocation} token={token} closed={closed} serverTime={serverTime} onRefresh={onRefresh} onExpired={onExpired} /> : <>
    {!slots.length && <Card><CardContent className="p-6"><Users className="mb-3 h-6 w-6 text-teal-800" aria-hidden="true" /><h3 className="font-semibold">{remaining ? "Your roster is ready to begin" : "All places have been assigned"}</h3><p className="mt-2 text-sm text-slate-600">{remaining ? "Add an attendee below. Save a draft now, or complete their registration when you have their details." : "Contact the organiser for help with registrations not shown here."}</p></CardContent></Card>}
    {slots.map(slot => <AttendeeEditor key={slot.id} slot={slot} allocation={{ ...allocation, serverTime }} settings={settings} token={token} closed={closed} onSaved={onSaved} onExpired={onExpired} />)}
    {!closed && remaining > 0 && <Button type="button" variant="outline" className="w-full border-teal-700 text-teal-800" onClick={() => setLocalSlots(current => [...current, { id: crypto.randomUUID(), version: 0, status: "draft", details: emptyDetails() }])}>Add attendee</Button>}
    </>}
  </section>;
}

export default function PublicSalesTicketRegistration() {
  // Keep the secure fragment in this tab only; never put it in storage, links,
  // query keys, analytics, or error messages.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [contextError, setContextError] = useState(null);
  const [fatalError, setFatalError] = useState(null);
  const [renewalStatus, setRenewalStatus] = useState("");
  const renewalRequest = useRef(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const serverTime = () => Date.now() + offset.current;

  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer"; meta.content = "no-referrer";
    document.head.prepend(meta);
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => { meta.remove(); clearInterval(timer); renewalRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true); setContextError(null);
    request({ token, action: "context" }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.allocations)) throw new Error("Invalid response");
      const serverNow = Date.parse(data.serverNow);
      if (Number.isFinite(serverNow)) offset.current = serverNow - Date.now();
      setNow(Date.now() + offset.current);
      setContext(data);
    }).catch(reason => {
      if (!controller.signal.aborted) setContextError(reason);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token, reload]);

  const expiry = Date.parse(context?.expiresAt);
  const expired = isExpired(contextError) || isExpired(fatalError) || (Number.isFinite(expiry) && now >= expiry);
  const unavailable = !token || expired || (!context && contextError);
  const canRenew = Boolean(token) && contextError?.code === "invalid_token";
  async function renewLink() {
    if (!canRenew || renewalRequest.current) return;
    const controller = new AbortController();
    renewalRequest.current = controller;
    setRenewalStatus("pending");
    try {
      await request({ action: "renew", token }, controller.signal);
      if (!controller.signal.aborted) setRenewalStatus("success");
    } catch {
      if (!controller.signal.aborted) setRenewalStatus("error");
    } finally {
      if (renewalRequest.current === controller) renewalRequest.current = null;
    }
  }
  const saved = (allocationId, slot) => {
    setContext(current => ({ ...current, allocations: current.allocations.map(allocation => allocation.id === allocationId ? { ...allocation, slots: [...(allocation.slots || []).filter(item => item.id !== slot.id), slot] } : allocation) }));
    setReload(value => value + 1);
  };

  return <main className="min-h-[100dvh] bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-slate-100">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-5 sm:px-6">
        <span className="rounded-lg bg-teal-800 p-2.5 text-slate-50"><Ticket className="h-5 w-5" aria-hidden="true" /></span>
        {context?.branding?.logoUrl && /^(https?:\/\/|\/(?!\/))/.test(context.branding.logoUrl)
          && <img src={context.branding.logoUrl} referrerPolicy="no-referrer" alt={context.branding.name || "Organisation"}
            className="h-10 max-w-40 object-contain" />}
        <span className="font-semibold" style={/^#[0-9a-f]{3,8}$/i.test(context?.branding?.primaryColor || "")
          ? { color: context.branding.primaryColor } : undefined}>{context?.branding?.name || "Your purchased places"}</span>
        <span className="ml-auto text-xs text-slate-500">Secure registration</span>
      </div>
    </header>
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      {unavailable ? <Card className="mx-auto max-w-xl"><CardContent className="p-8 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-600" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-bold">{!token ? "Open your secure invitation" : expired ? "This link is no longer available" : "We couldn’t load your places"}</h1>
        <p className="mt-3 text-sm text-slate-600">{!token ? "Use the complete registration link supplied with your purchase. No sign-in is needed." : expired ? "Your registration link has expired or been withdrawn. Contact the sender for a new link." : "Your places have not been changed. Please try again."}</p>
        {token && !expired && <Button className="mt-6" onClick={() => setReload(value => value + 1)}>Try again</Button>}
        {canRenew && <div className="mt-6">
          <Button disabled={renewalStatus === "pending"} onClick={renewLink}>{renewalStatus === "pending" ? "Requesting new link…" : "Request a new link"}</Button>
          {renewalStatus === "success" && <p role="status" className="mt-4 text-sm text-slate-600">If this expired link can be renewed, a new link will be emailed to the original purchaser.</p>}
          {renewalStatus === "error" && <p role="alert" className="mt-4 text-sm text-amber-900">We couldn’t request a new link. Please try again.</p>}
        </div>}
      </CardContent></Card> : <>
        <div className="mb-8 max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-800">Purchaser workspace</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Make room for your team.</h1>
          <p className="mt-3 text-slate-600">{context?.customerName ? `Manage purchased places for ${context.customerName}. ` : ""}Add attendees, save unfinished details, and manage completed registrations here. These places are prepaid — no payment is taken.</p>
          {Number.isFinite(expiry) && <p className="mt-3 text-xs text-slate-500">Link available until {new Date(expiry).toLocaleDateString(undefined, { dateStyle: "long" })}. Each ticket may have an earlier registration deadline.</p>}
        </div>
        {contextError && <div role="alert" className="mb-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">Places could not be refreshed. Your edits are retained. <button type="button" className="underline" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
        {loading && !context ? <div role="status" aria-label="Loading purchased places" className="grid gap-5 md:grid-cols-2">{[1, 2].map(item => <div key={item} className="h-64 animate-pulse rounded-xl border border-slate-200 bg-slate-100" />)}<span className="sr-only">Loading purchased places…</span></div> : <>
          <div className="mb-4 flex items-center justify-between gap-4"><h2 className="flex items-center gap-2 text-lg font-semibold"><Users className="h-5 w-5 text-teal-800" aria-hidden="true" />Purchased places</h2><Button variant="outline" disabled={loading} onClick={() => setReload(value => value + 1)}>{loading ? "Refreshing…" : "Refresh places"}</Button></div>
          {!context?.allocations.length ? <Card><CardContent className="p-6"><h3 className="font-semibold">No ticket allocations yet</h3><p className="mt-2 text-sm text-slate-600">Contact the organiser if you expected purchased event places here.</p></CardContent></Card> : <div className="grid items-start gap-6 md:grid-cols-2">{context.allocations.map(allocation => <Allocation key={allocation.id} allocation={allocation} settings={context.settings || {}} token={token} now={now} serverTime={serverTime} onSaved={saved} onExpired={setFatalError} onRefresh={() => setReload(value => value + 1)} />)}</div>}
          <p className="mt-6 text-xs leading-relaxed text-slate-500">This private link gives access to attendee details. Keep it secure and save your work before closing this tab.</p>
        </>}
      </>}
    </div>
  </main>;
}

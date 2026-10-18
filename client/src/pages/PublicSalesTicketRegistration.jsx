import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Copy, Ticket, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const endpoint = "/api/public/sales-ticket-registration";
const emptyForm = { firstName: "", lastName: "", email: "" };

// Only normal, public event registration surfaces may receive a returned link.
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
    referrerPolicy: "no-referrer",
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // Do not echo server text: it could include sensitive request values.
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

export default function PublicSalesTicketRegistration() {
  // Fragment stays in this tab for refresh/back continuity; never put it in storage,
  // query keys, analytics, error messages, or navigation links.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [contextError, setContextError] = useState(null);
  const [reload, setReload] = useState(0);
  const [allocationId, setAllocationId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");
  const pendingRef = useRef(false);
  const attempt = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.prepend(meta);
    return () => { mounted.current = false; meta.remove(); };
  }, []);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    setContextError(null);
    request({ token, action: "context" }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.allocations)) throw new Error("Invalid response");
      setContext(data);
      setAllocationId(current => current || String(data.allocations.find(item => Number(item.remaining) > 0)?.id || ""));
    }).catch(reason => {
      if (!controller.signal.aborted) setContextError(reason);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token, reload]);

  const allocations = context?.allocations || [];
  const selected = allocations.find(item => String(item.id) === allocationId);
  const expiry = context?.expiresAt ? new Date(context.expiresAt).getTime() : NaN;
  const expired = isExpired(contextError) || isExpired(error) || (Number.isFinite(expiry) && expiry <= Date.now());
  const unavailable = !token || expired || (!context && contextError);
  const available = allocations.some(item => Number(item.remaining) > 0);
  const patch = (key, value) => {
    setForm(current => ({ ...current, [key]: value }));
    // Once input changes, a new logical registration gets a new key, even if
    // the user later changes it back.
    attempt.current = null;
    setError(null);
  };

  async function submit(event) {
    event.preventDefault();
    if (pendingRef.current || expired || (Number.isFinite(expiry) && expiry <= Date.now()) || !selected || Number(selected.remaining) <= 0 || result) return;
    const fields = { allocationId: selected.id, firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim() };
    if (!fields.firstName || !fields.lastName || !fields.email) return;
    if (!attempt.current) attempt.current = { ...fields, idempotencyKey: crypto.randomUUID() };
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const data = await request({ token, action: "register", ...attempt.current });
      const url = safeRegistrationUrl(data.registrationUrl);
      if (!url) throw Object.assign(new Error("Unsafe registration destination"), { code: "unsafe_url" });
      if (!mounted.current) return;
      setResult({ url, name: `${fields.firstName} ${fields.lastName}` });
      attempt.current = null;
      // Refresh actual capacity; never assume creating a link completes attendance.
      setReload(value => value + 1);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason);
      if (reason.status === 409 || /sold_out|capacity|exhausted/.test(reason.code || "")) setReload(value => value + 1);
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied("Link copied.");
    } catch {
      setCopied("Copy is unavailable. Select and copy the link below instead.");
    }
  }

  return <main className="min-h-[100dvh] bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-slate-100">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-5 sm:px-6">
        <span className="rounded-lg bg-teal-800 p-2.5 text-slate-50"><Ticket className="h-5 w-5" aria-hidden="true" /></span>
        <span className="font-semibold">Your purchased places</span>
        <span className="ml-auto text-xs text-slate-500">Secure registration</span>
      </div>
    </header>
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      {unavailable ? <Card className="mx-auto max-w-xl"><CardContent className="p-8 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-600" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-bold">{!token ? "Open your secure invitation" : expired ? "This link is no longer available" : "We couldn’t load your places"}</h1>
        <p className="mt-3 text-sm text-slate-600">{!token ? "Use the complete registration link supplied with your purchase. No sign-in is needed." : expired ? "Your registration link has expired or been withdrawn. Contact the sender for a new link." : "Your places have not been changed. Please try again."}</p>
        {token && !expired && <Button className="mt-6" onClick={() => setReload(value => value + 1)}>Try again</Button>}
      </CardContent></Card> : <>
        <div className="mb-8 max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-800">Colleague registration</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Make room for your team.</h1>
          <p className="mt-3 text-slate-600">{context?.customerName ? `Manage purchased places for ${context.customerName}. ` : ""}Choose a ticket, add a colleague, then complete their event registration. No sign-in needed here.</p>
          {Number.isFinite(expiry) && <p className="mt-3 text-xs text-slate-500">Link available until {new Date(expiry).toLocaleDateString(undefined, { dateStyle: "long" })}.</p>}
        </div>
        {loading && !context ? <div role="status" aria-label="Loading purchased places" className="grid gap-5 md:grid-cols-2">{[1, 2].map(item => <div key={item} className="h-64 animate-pulse rounded-xl border border-slate-200 bg-slate-100" />)}<span className="sr-only">Loading purchased places…</span></div> : <div className="grid items-start gap-6 md:grid-cols-[1.05fr_1fr]">
          <section aria-labelledby="places-heading">
            <h2 id="places-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold"><Users className="h-5 w-5 text-teal-800" aria-hidden="true" />Purchased places</h2>
            {allocations.length === 0 ? <Card><CardContent className="p-6"><h3 className="font-semibold">No ticket allocations yet</h3><p className="mt-2 text-sm text-slate-600">Contact the sender if you expected purchased event places here.</p></CardContent></Card> : <div className="space-y-3">{allocations.map(item => {
              const active = allocationId === String(item.id);
              const soldOut = Number(item.remaining) <= 0;
              return <button key={item.id} type="button" aria-pressed={active} disabled={soldOut || pending || Boolean(result)} onClick={() => { setAllocationId(String(item.id)); attempt.current = null; setError(null); }} className={`w-full rounded-xl border p-5 text-left transition-colors disabled:cursor-default ${active ? "border-teal-700 bg-teal-50" : "border-slate-200 bg-slate-100 hover:border-teal-600"}`}>
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">{item.eventKind ? String(item.eventKind).replace(/[_-]/g, " ") : "Event"}</span>
                <span className="mt-2 block text-lg font-semibold">{item.eventName}</span>
                <span className="mt-1 block text-sm text-slate-600">{item.ticketName}</span>
                <span className="mt-5 flex items-end justify-between gap-3 border-t border-slate-200 pt-3"><span className="text-xs text-slate-500">{item.allocated} purchased · {item.registered} registered</span><span className={`text-sm font-semibold ${soldOut ? "text-slate-500" : "text-teal-800"}`}>{soldOut ? "No places remaining" : `${item.remaining} remaining`}</span></span>
              </button>;
            })}</div>}
            <p className="mt-4 text-xs leading-relaxed text-slate-500">Keep this page open while completing a registration in another tab. Return here for the next colleague.</p>
          </section>
          <Card className="border-slate-200">
            <CardHeader><CardTitle className="text-xl">{result ? "Your colleague’s link is ready" : "Add a colleague"}</CardTitle></CardHeader>
            <CardContent>
              {contextError && <p role="alert" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Availability could not be refreshed. <button type="button" className="underline" onClick={() => setReload(value => value + 1)}>Check again</button></p>}
              {result ? <div className="space-y-5" role="status">
                <div className="rounded-lg bg-teal-50 p-4"><CheckCircle2 className="mb-2 h-6 w-6 text-teal-700" aria-hidden="true" /><p className="font-semibold">{result.name}</p><p className="mt-2 text-sm text-slate-600">A link is ready, but event registration still needs to be completed. Open it below or copy it to share with your colleague.</p></div>
                <Button asChild className="w-full bg-teal-800 hover:bg-teal-900"><a href={result.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open registration in new tab<ArrowUpRight className="ml-2 h-4 w-4" aria-hidden="true" /></a></Button>
                <Button variant="outline" className="w-full" onClick={copyLink}><Copy className="mr-2 h-4 w-4" aria-hidden="true" />Copy registration link</Button>
                <Input aria-label="Registration link" readOnly value={result.url} onFocus={event => event.target.select()} />
                {copied && <p className="text-sm text-slate-600">{copied}</p>}
                <Button variant="outline" className="w-full" onClick={() => { setResult(null); setForm(emptyForm); setCopied(""); setError(null); setReload(value => value + 1); }}>Add another colleague</Button>
              </div> : !available ? <div className="rounded-lg bg-slate-100 p-5"><CheckCircle2 className="mb-3 h-7 w-7 text-teal-700" aria-hidden="true" /><h3 className="font-semibold">{allocations.length ? "All places have been assigned" : "No places to register"}</h3><p className="mt-2 text-sm text-slate-600">Contact the sender if you need more places or help with an existing registration.</p><Button variant="outline" className="mt-4" disabled={loading} onClick={() => setReload(value => value + 1)}>Refresh availability</Button></div> : <form onSubmit={submit} className="space-y-5">
                <p className="text-sm text-slate-600">Create a registration link for one colleague at a time. Use their own email address.</p>
                <fieldset disabled={pending || loading} className="space-y-4">
                  <div><Label htmlFor="delegate-first-name">First name</Label><Input className="mt-1.5" id="delegate-first-name" autoComplete="given-name" required maxLength={120} value={form.firstName} onChange={event => patch("firstName", event.target.value)} /></div>
                  <div><Label htmlFor="delegate-last-name">Last name</Label><Input className="mt-1.5" id="delegate-last-name" autoComplete="family-name" required maxLength={120} value={form.lastName} onChange={event => patch("lastName", event.target.value)} /></div>
                  <div><Label htmlFor="delegate-email">Colleague’s email</Label><Input className="mt-1.5" id="delegate-email" type="email" autoComplete="email" required maxLength={254} value={form.email} onChange={event => patch("email", event.target.value)} /></div>
                </fieldset>
                {error && <div role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">{error.code === "unsafe_url" ? "The returned link could not be verified. Contact the sender, or retry with the same details to retrieve your existing link." : error.status === 409 ? "Availability has changed or this colleague already has a place. Check the updated places or contact the sender." : "We couldn’t confirm the link. Retry with the same details safely; you won’t create a duplicate request."}</div>}
                <Button type="submit" className="w-full bg-teal-800 hover:bg-teal-900" disabled={pending || loading || !selected || Number(selected.remaining) <= 0 || !form.firstName.trim() || !form.lastName.trim() || !form.email.trim()}>{pending ? "Creating registration link…" : error ? "Retry registration link" : "Create registration link"}</Button>
                <p className="text-xs leading-relaxed text-slate-500">This creates a link, not a completed event registration. You’ll choose when to open or share it.</p>
              </form>}
            </CardContent>
          </Card>
        </div>}
      </>}
    </div>
  </main>;
}

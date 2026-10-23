import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { certificateAwardState, validCertificateOverrideReason } from "./attendeeCertificateAwardState";

const ENDPOINT = "/api/reports/attendee-cpd-certificate";

function describeReason(reason) {
  const messages = {
    no_template: "No certificate template is configured for this ticket or event.",
    template_unavailable: "The selected certificate template is unavailable.",
    template_inactive: "The selected certificate template is not active.",
    invalid_policy: "The certificate settings are invalid.",
    date_unavailable: "The certificate activity dates are unavailable.",
    cancelled_booking: "Cancelled bookings cannot receive certificates.",
    booking_cancelled: "Cancelled bookings cannot receive certificates.",
    missing_recipient: "This attendee has no valid email address. Certificate PDF preview remains available.",
    invalid_recipient: "This attendee has no valid email address. Certificate PDF preview remains available.",
    email_template_unavailable: "The selected certificate email template is unavailable or deleted. Select an active template or the default email in the event's Certificates settings.",
    email_template_inactive: "The selected certificate email template is inactive. Select an active template or the default email in the event's Certificates settings.",
    email_template_invalid: "The selected certificate email template cannot be used. Update it in Email Templates or select the default email in the event's Certificates settings.",
  };
  if (!reason) return "Certificate unavailable. Check the booking and certificate settings.";
  if (typeof reason !== "string") return "Certificate unavailable. Check the booking and certificate settings.";
  return messages[reason] || reason.replaceAll("_", " ");
}

async function readError(response) {
  const body = await response.json().catch(() => ({}));
  return body.error || body.message || `Request failed (${response.status})`;
}

function wasAccepted(delivery) {
  return ["accepted", "sent", "delivered"].includes(delivery?.status);
}

// Render the PDF to canvases rather than navigating an iframe to a blob URL:
// Chromium's PDF viewer treats blob navigation as a download in some contexts.
export function CertificatePdfCanvasPreview({ bytes, pdfEngine }) {
  const containerRef = useRef(null);
  const [state, setState] = useState({ loading: true, error: "", pages: 0 });

  useEffect(() => {
    let cancelled = false;
    let loadingTask;
    let renderTask;
    const container = containerRef.current;
    container.replaceChildren();
    setState({ loading: true, error: "", pages: 0 });

    const render = async () => {
      try {
        const engine = pdfEngine || await import("pdfjs-dist");
        if (cancelled) return;
        if (!pdfEngine) engine.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        // PDF.js may transfer ownership of its data buffer to a worker.
        loadingTask = engine.getDocument({ data: bytes.slice() });
        const document = await loadingTask.promise;
        if (cancelled) return;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1.25 });
          const canvas = window.document.createElement("canvas");
          canvas.setAttribute("aria-label", `Certificate page ${pageNumber} of ${document.numPages}`);
          canvas.className = "block max-w-full mx-auto bg-white shadow-sm";
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.ceil(viewport.width * ratio);
          canvas.height = Math.ceil(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = "auto";
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas preview is not supported in this browser.");
          container.appendChild(canvas);
          renderTask = page.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
          await renderTask.promise;
          renderTask = null;
          if (cancelled) return;
        }
        if (!document.numPages) throw new Error("The certificate PDF has no pages.");
        setState({ loading: false, error: "", pages: document.numPages });
      } catch (error) {
        if (!cancelled) {
          container.replaceChildren();
          setState({ loading: false, error: error.message || "Could not display certificate PDF.", pages: 0 });
        }
      }
    };
    render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      if (loadingTask) Promise.resolve(loadingTask.destroy()).catch(() => {});
      container.replaceChildren();
    };
  }, [bytes, pdfEngine]);

  return (
    <div className="space-y-2" data-testid="certificate-canvas-preview">
      {state.loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Rendering certificate pages…</p>}
      {state.error && <p role="alert" className="text-sm text-destructive">Preview could not be displayed: {state.error}</p>}
      {!state.loading && !state.error && <p role="status" className="text-xs text-muted-foreground">{state.pages} {state.pages === 1 ? "page" : "pages"} rendered</p>}
      <div ref={containerRef} className="max-h-[45vh] overflow-auto rounded border bg-slate-100 p-3 space-y-3" aria-label="CPD certificate PDF pages" />
    </div>
  );
}

export default function AttendeeCpdCertificateDialog({ attendee, bookingSource, onClose, pdfEngine }) {
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pdfBytes, setPdfBytes] = useState(null);
  const [emailPreview, setEmailPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sent, setSent] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [testConfirmed, setTestConfirmed] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [awardConfirmed, setAwardConfirmed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [awardMessage, setAwardMessage] = useState("");
  const testRequestId = useRef(null);
  const requestId = useRef(null);
  const metadataRef = useRef(null);
  const pendingRef = useRef(false);

  const bookingId = attendee?.id;
  const source = bookingSource === "complex" ? "complex" : "standard";

  useEffect(() => {
    if (!bookingId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMetadata(null);
    metadataRef.current = null;
    setConfirmed(false);
    setSent(false);
    setTestRecipient("");
    setTestMessage("");
    setTestConfirmed(false);
    setOverrideReason("");
    setAwardConfirmed(false);
    setAwardMessage("");
    testRequestId.current = null;
    setPdfBytes(null);
    setEmailPreview(null);
    requestId.current = null;
    fetch(`${ENDPOINT}?${new URLSearchParams({ booking_id: bookingId, booking_source: source })}`, {
      credentials: "include", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(await readError(response));
      return response.json();
    }).then(data => {
      if (!controller.signal.aborted) {
        metadataRef.current = data;
        setMetadata(data);
      }
    }).catch(err => {
      if (!controller.signal.aborted) setError(err.message || "Failed to load certificate details");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); };
  }, [bookingId, source, refreshKey]);

  const action = async (kind) => {
    if (pendingRef.current || !metadataRef.current) return;
    const award = certificateAwardState(metadataRef.current);
    if (kind === "send" && (!confirmed || !award.supported
      || (award.required && (!awardConfirmed || !validCertificateOverrideReason(overrideReason))))) {
      setError("Confirm this individual award and enter a specific reason before sending.");
      return;
    }
    pendingRef.current = true;
    setBusy(kind);
    setError("");
    setTestMessage("");
    if (kind === "preview") setPdfBytes(null);
    if (kind === "email-preview") setEmailPreview(null);
    const activeRequestId = kind === "test-send" ? testRequestId : requestId;
    let refreshSendOutcome = kind === "send";
    if (["send", "test-send"].includes(kind) && !activeRequestId.current) {
      if (!globalThis.crypto?.randomUUID) {
        setError("Secure request IDs are unavailable in this browser. Please use a supported browser.");
        pendingRef.current = false;
        setBusy("");
        return;
      }
      activeRequestId.current = globalThis.crypto.randomUUID();
    }
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId, booking_source: source, action: kind,
          expected_fingerprint: metadataRef.current.fingerprint,
          ...(kind === "test-send" ? {
            test_recipient: testRecipient.trim(), confirmed: testConfirmed,
            request_id: testRequestId.current,
          } : {}),
          ...(kind === "send" ? {
            request_id: requestId.current,
            confirmed,
            deliberate_resend: wasAccepted(metadataRef.current.latest_delivery),
            ...(award.required ? {
              award_confirmed: awardConfirmed,
              override_reason: overrideReason.trim(),
            } : {}),
          } : {}),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data.award_status === "awarded") {
          setAwardMessage("CPD points have already been awarded. A delivery failure does not undo the award; retries must not create another award.");
        }
        if (data.fingerprint && data.fingerprint !== metadataRef.current?.fingerprint) {
          // A preflight conflict already includes fresh authoritative metadata;
          // no award or provider attempt occurred for this stale confirmation.
          refreshSendOutcome = false;
          // A changed email selection/content, PDF or recipient needs fresh consent.
          // The server returns the new metadata with a stale-fingerprint conflict.
          const next = kind === "test-send"
            ? { ...data, latest_delivery: metadataRef.current.latest_delivery }
            : data;
          metadataRef.current = next;
          setMetadata(next);
          setConfirmed(false);
          setAwardConfirmed(false);
          setPdfBytes(null);
          setEmailPreview(null);
          requestId.current = null;
          testRequestId.current = null;
          setTestConfirmed(false);
        }
        if (data.latest_delivery) {
          setMetadata(previous => {
            const next = { ...previous, latest_delivery: data.latest_delivery,
              can_send: previous.can_send && !["pending", "unknown"].includes(data.latest_delivery.status) };
            metadataRef.current = next;
            return next;
          });
        }
        throw new Error(data.error || data.message || `Request failed (${response.status})`);
      }
      if (kind === "preview") {
        const blob = await response.blob();
        if (!blob.size || !response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) {
          throw new Error("The preview did not return a PDF.");
        }
        setPdfBytes(new Uint8Array(await blob.arrayBuffer()));
      } else if (kind === "email-preview") {
        setEmailPreview(await response.json());
      } else if (kind === "test-send") {
        const data = await response.json();
        if (data.success !== true) throw new Error(data.error || "Test email was not accepted.");
        setTestMessage(`Test email accepted by the provider for ${data.test_recipient}. Attendee delivery is unchanged.`);
        testRequestId.current = null;
        setTestConfirmed(false);
      } else {
        const data = await response.json();
        if (data.success !== true) throw new Error(data.error || "The email provider has not confirmed acceptance. Check the delivery record before trying again.");
        if (data.award_status === "awarded") {
          setAwardMessage("CPD points are recorded in the ledger. Resending this certificate will not award points again.");
        }
        setSent(true);
        setConfirmed(false);
        setMetadata(previous => {
          const next = { ...previous, latest_delivery: data.latest_delivery || previous.latest_delivery };
          metadataRef.current = next;
          return next;
        });
      }
    } catch (err) {
      setError(err.message || `Failed to ${kind} certificate`);
      // Keep the same request ID after an ambiguous send failure. A retry must
      // never silently turn into a second delivery.
    } finally {
      if (refreshSendOutcome) {
        // Award and provider delivery are separate durable outcomes. Always
        // re-read after an attempt, including a lost/ambiguous response.
        try {
          const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ booking_id: bookingId, booking_source: source })}`, {
            credentials: "include",
          });
          if (!response.ok) throw new Error("Could not verify award and delivery status.");
          const next = await response.json();
          metadataRef.current = next;
          setMetadata(next);
          setConfirmed(false);
          setAwardConfirmed(false);
          setPdfBytes(null);
          setEmailPreview(null);
          if (certificateAwardState(next).awarded) {
            setAwardMessage("CPD points are already recorded in the ledger. Email failure or resending does not undo or duplicate the award.");
          }
        } catch {
          const next = { ...metadataRef.current, can_send: false };
          metadataRef.current = next;
          setMetadata(next);
          setAwardMessage("The award or email may already have occurred. Status could not be verified. Reload details and reconcile the delivery audit before sending again.");
        }
      }
      pendingRef.current = false;
      setBusy("");
    }
  };

  const prepareResend = () => {
    requestId.current = null;
    setSent(false);
    setConfirmed(false);
    setError("");
  };

  const download = () => {
    if (!pdfBytes) return;
    const url = URL.createObjectURL(new Blob([pdfBytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "cpd-certificate.pdf";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const name = metadata?.attendee_name || `${attendee?.attendee_first_name || ""} ${attendee?.attendee_last_name || ""}`.trim() || "Attendee";
  const recipient = metadata?.recipient;
  const available = metadata?.available === true;
  const award = certificateAwardState(metadata);
  const canSend = available && metadata?.can_send === true && !!metadata?.fingerprint
    && award.supported && !["pending", "unknown"].includes(metadata?.latest_delivery?.status);
  // A pending delivery blocks another send, not inspection of the selected email.
  const canPreviewEmail = available && metadata?.can_preview_email === true && !!metadata?.fingerprint;
  const emailPreviewReason = !recipient
    ? "The attendee has no valid email address. Add a valid address to preview the email."
    : metadata?.email_reason
      ? describeReason(metadata.email_reason)
      : metadata?.send_reason && !["pending", "unknown"].includes(metadata.latest_delivery?.status)
        ? describeReason(metadata.send_reason)
        : "The certificate email cannot be previewed with the current settings.";

  return (
    <Dialog open={!!attendee} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="attendee-certificate-dialog">
        <DialogHeader>
          <DialogTitle>CPD certificate — {name}</DialogTitle>
          <DialogDescription>Preview the certificate PDF and the separate email subject and message before deciding whether to send. Previews do not send email, change attendance or award member CPD points.</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Checking certificate settings…</p> : metadata && (
          <div className="space-y-3">
            {!available && <p className="text-sm" data-testid="cpd-email-template-name">
              Certificate email: <strong>{metadata.email_is_default !== false
                ? "Default certificate email"
                : metadata.email_template_name || "Selected template unavailable"}</strong>
            </p>}
            {!available && <p role="status" className="text-sm text-amber-700">Preview unavailable: {describeReason(metadata.reason)}</p>}
            {available && (
              <>
                <p className="text-sm">Attendee: <strong>{name}</strong></p>
                 {metadata.certificate_points_source === "guest_rule" && (
                   <p className="text-sm text-muted-foreground" data-testid="guest-certificate-points">
                     {metadata.certificate_points != null
                       ? `Guest certificate points: ${metadata.certificate_points} (from the qualifying ticket/event rule). `
                       : "No qualifying guest certificate points under the current ticket/event rule and attendance evidence. "}
                     This certificate does not create a member CPD ledger award.
                   </p>
                 )}
                 {!award.guest && <section className="rounded border bg-muted/40 p-3 space-y-1" aria-label="Member CPD award status" data-testid="member-cpd-award-status">
                   <h3 className="text-sm font-semibold">{award.awarded ? "Member CPD points already awarded" : "Not awarded — prospective certificate points"}</h3>
                   <p className="text-sm">{metadata.certificate_points != null
                     ? `${metadata.certificate_points} CPD points ${award.awarded ? "from this attendee’s booking ledger." : "under the effective ticket/event rule. Ticket overrides take precedence."}`
                     : "The server has not confirmed a CPD point value for this attendee."}</p>
                   {!award.awarded && <p className="text-xs text-muted-foreground">Preview, download and test email do not award points. A confirmed individual send may award once with your audited reason, even before the event or without recorded attendance. Attendance and event-wide rules remain unchanged.</p>}
                   {!award.supported && <p role="status" className="text-sm text-amber-700">Individual award capability is not confirmed by the server. Sending is disabled until award status can be verified.</p>}
                 </section>}
                <section className="space-y-2 rounded border p-3" aria-label="Certificate PDF preview" data-testid="cpd-certificate-section">
                  <h3 className="font-semibold">1. Certificate PDF</h3>
                  <p className="text-sm text-muted-foreground">Inspect the personalized certificate without sending it.</p>
                  <Button type="button" variant="outline" disabled={!!busy} onClick={() => action("preview")} data-testid="button-preview-cpd-certificate">
                    {busy === "preview" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Preview CPD certificate PDF
                  </Button>
                  {pdfBytes && <CertificatePdfCanvasPreview bytes={pdfBytes} pdfEngine={pdfEngine} />}
                  {pdfBytes && <Button type="button" variant="outline" disabled={!!busy} onClick={download} data-testid="button-download-cpd-certificate">Download CPD certificate</Button>}
                </section>
                <section className="space-y-2 rounded border p-3" aria-label="Certificate email preview" data-testid="cpd-email-section">
                  <h3 className="font-semibold">2. Certificate email</h3>
                  <p className="text-sm" data-testid="cpd-email-template-name">
                    Email template: <strong>{metadata.email_is_default !== false
                      ? "Default certificate email"
                      : metadata.email_template_name || "Selected template unavailable"}</strong>
                  </p>
                  <p className="text-sm">Recipient: <strong>{recipient || "No valid attendee email"}</strong></p>
                  {metadata.email_selection_missing && <p role="status" className="text-sm text-amber-700">
                    No event-wide certificate email selection is saved. This uses the default email; choose a template in the event Certificates settings and save it before sending.
                  </p>}
                  <Button type="button" variant="outline" disabled={!!busy || !canPreviewEmail}
                    onClick={() => action("email-preview")} data-testid="button-preview-cpd-email">
                    {busy === "email-preview" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Preview email subject &amp; body
                  </Button>
                  {!canPreviewEmail && <p role="status" className="text-sm text-amber-700">Email preview unavailable: {emailPreviewReason}</p>}
                  <div className="space-y-2 rounded border p-3" data-testid="cpd-test-email-section">
                    <label htmlFor="cpd-test-recipient" className="block text-sm font-medium">Test email recipient</label>
                    <input id="cpd-test-recipient" type="email" value={testRecipient}
                      onChange={event => {
                        setTestRecipient(event.target.value); setTestMessage("");
                        setTestConfirmed(false); testRequestId.current = null;
                      }}
                      disabled={!!busy} placeholder="you@example.com"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                    <p className="text-xs text-muted-foreground">Sends this attendee’s email and certificate PDF only to the address above, with [TEST] in the subject. Includes genuine tokenised survey links that open without login. Does not mark the attendee’s certificate as sent or change attendance or CPD points.</p>
                    <p className="text-sm font-medium text-amber-700">Open links only—do not submit surveys. Open in a private or signed-out browser to test access without login. These are real attendee links; submitting records the attendee’s response and may prevent them responding later.</p>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox checked={testConfirmed} onCheckedChange={value => setTestConfirmed(value === true)}
                        disabled={!!busy} data-testid="confirm-cpd-test-email" />
                      I understand these are real attendee survey links and will only open them, not submit.
                    </label>
                    <Button type="button" variant="outline" data-testid="button-test-cpd-email"
                      disabled={!!busy || !canPreviewEmail || !testConfirmed || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(testRecipient.trim())}
                      onClick={() => action("test-send")}>
                      {busy === "test-send" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Send test email
                    </Button>
                    {testMessage && <p role="status" className="text-sm">{testMessage}</p>}
                  </div>
                  {emailPreview && <div className="space-y-2 rounded border p-3" data-testid="cpd-email-preview">
                    <p className="text-sm"><strong>To:</strong> {emailPreview.recipient}</p>
                    <p className="text-sm"><strong>Subject:</strong> {emailPreview.subject}</p>
                    <p className="text-sm"><strong>Body:</strong></p>
                    <iframe title="Certificate email HTML preview" sandbox="" referrerPolicy="no-referrer"
                      srcDoc={emailPreview.html} className="w-full min-h-48 rounded border" />
                    <p className="text-sm"><strong>Attachment:</strong> {emailPreview.attachment?.filename} (PDF, {emailPreview.attachment?.bytes} bytes)</p>
                    <p className="text-xs text-muted-foreground">Survey links are inactive in previews. Sent emails include individual attendee links.</p>
                    {emailPreview.omitted_surveys?.length > 0 && <div className="text-sm text-amber-700" data-testid="cpd-omitted-surveys">
                      <strong>Assigned surveys not included in this email:</strong>
                      <ul className="list-disc pl-5">{emailPreview.omitted_surveys.map((survey, index) =>
                        <li key={index}>{survey.title}: {survey.reason}</li>)}</ul>
                    </div>}
                    {emailPreview.text && <details><summary className="text-sm">Plain-text version</summary>
                      <pre className="whitespace-pre-wrap text-xs">{emailPreview.text}</pre></details>}
                  </div>}
                </section>
                {sent ? (
                  <div className="space-y-2">
                    <p role="status" className="text-sm">Certificate email request accepted for {recipient}. This does not confirm inbox delivery.</p>
                    <Button variant="outline" onClick={prepareResend} data-testid="button-prepare-cpd-resend">Prepare another email</Button>
                  </div>
                ) : (
                  <div className="space-y-2 border-t pt-3">
                     {award.required && award.supported && <section className="rounded border border-amber-300 bg-amber-50/50 p-3 space-y-3" aria-label="Individual CPD award override">
                       <h3 className="font-semibold">3. Authorize this attendee’s CPD award</h3>
                       <p className="text-sm">Sending will first record {metadata.certificate_points} CPD points once in the append-only member ledger, then prepare the certificate with those points. The award remains recorded if email fails. This does not record attendance or change any event rule.</p>
                       <label htmlFor="cpd-override-reason" className="block text-sm font-medium">Why are you authorizing this individual award?</label>
                       <textarea id="cpd-override-reason" value={overrideReason} maxLength={2000} rows={3}
                         disabled={!!busy} aria-describedby="cpd-override-reason-help"
                         className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                         onChange={event => {
                           setOverrideReason(event.target.value);
                           setAwardConfirmed(false);
                           setConfirmed(false);
                         }} />
                       <p id="cpd-override-reason-help" className="text-xs text-muted-foreground">Required: explain the specific circumstances in at least 15 characters and three words. Your reason and admin identity will be audited; no reason is prefilled.</p>
                       <label className="flex items-start gap-2 text-sm">
                         <Checkbox checked={awardConfirmed} disabled={!!busy || !validCertificateOverrideReason(overrideReason)}
                           onCheckedChange={value => setAwardConfirmed(value === true)} data-testid="confirm-cpd-award" />
                         <span>I explicitly authorize this attendee’s CPD award, overriding the normal registration or attendance trigger for this attendee only, including if the event has not yet occurred.</span>
                       </label>
                     </section>}
                     {!canSend && <p role="status" className="text-sm text-amber-700">Email unavailable: {["pending", "unknown"].includes(metadata.latest_delivery?.status) ? "A previous send is pending or its provider outcome is unknown. Reconcile it before sending again." : !award.supported ? "The server has not verified this attendee’s award status or individual award capability." : metadata.email_message || describeReason(metadata.email_reason || metadata.send_reason || metadata.reason || "missing_recipient")}</p>}
                     {["pending", "unknown"].includes(metadata.latest_delivery?.status) && <p className="text-xs text-muted-foreground">
                       Delivery audit ID: {metadata.latest_delivery.id || "unavailable"}. Check the provider outcome and have an authorized administrator reconcile this audit record. Refreshing does not send email or award points.
                     </p>}
                    {canSend && <>
                      {wasAccepted(metadata.latest_delivery) && <p className="text-sm text-amber-700">A certificate email was already accepted. Sending again will create another email.</p>}
                      <label className="flex items-start gap-2 text-sm">
                        <Checkbox checked={confirmed} disabled={!!busy} onCheckedChange={value => setConfirmed(value === true)} data-testid="confirm-cpd-email" />
                        <span>I confirm I want to email the CPD certificate for <strong>{name}</strong> to <strong>{recipient}</strong>.</span>
                      </label>
                      <Button type="button" disabled={!confirmed || !!busy || (award.required && (!awardConfirmed || !validCertificateOverrideReason(overrideReason)))} onClick={() => action("send")} data-testid="button-email-cpd-certificate">
                        {busy === "send" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {award.required ? "Award CPD points & email certificate" : wasAccepted(metadata.latest_delivery) ? "Send another email" : "Email CPD certificate"}
                      </Button>
                    </>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {awardMessage && <p role="status" className="text-sm" data-testid="cpd-award-outcome">{awardMessage}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={!!busy || loading} onClick={() => setRefreshKey(value => value + 1)}>Reload details</Button>
          <Button variant="outline" disabled={!!busy} onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
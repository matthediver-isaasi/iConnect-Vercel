import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

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
    missing_recipient: "This attendee has no valid email address. Preview is still available.",
    invalid_recipient: "This attendee has no valid email address. Preview is still available.",
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
  const [confirmed, setConfirmed] = useState(false);
  const [sent, setSent] = useState(false);
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
  }, [bookingId, source]);

  const action = async (kind) => {
    if (pendingRef.current || !metadataRef.current) return;
    pendingRef.current = true;
    setBusy(kind);
    setError("");
    if (kind === "preview") setPdfBytes(null);
    if (kind === "send" && !requestId.current) {
      if (!globalThis.crypto?.randomUUID) {
        setError("Secure request IDs are unavailable in this browser. Please use a supported browser.");
        pendingRef.current = false;
        setBusy("");
        return;
      }
      requestId.current = globalThis.crypto.randomUUID();
    }
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId, booking_source: source, action: kind,
          expected_fingerprint: metadataRef.current.fingerprint,
          ...(kind === "send" ? {
            request_id: requestId.current,
            confirmed: true,
            deliberate_resend: wasAccepted(metadataRef.current.latest_delivery),
          } : {}),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
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
      } else {
        const data = await response.json();
        if (data.success !== true) throw new Error(data.error || "The email provider has not confirmed acceptance. Check the delivery record before trying again.");
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

  const name = metadata?.attendee_name || `${attendee?.attendee_first_name || ""} ${attendee?.attendee_last_name || ""}`.trim() || "Attendee";
  const recipient = metadata?.recipient;
  const available = metadata?.available === true;
  const canSend = available && metadata?.can_send === true && !!metadata?.fingerprint
    && !["pending", "unknown"].includes(metadata?.latest_delivery?.status);

  return (
    <Dialog open={!!attendee} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="attendee-certificate-dialog">
        <DialogHeader>
          <DialogTitle>CPD certificate — {name}</DialogTitle>
          <DialogDescription>Preview the personalized PDF before emailing it to this attendee. This does not change attendance or award CPD points.</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Checking certificate settings…</p> : metadata && (
          <div className="space-y-3">
            {!available && <p role="status" className="text-sm text-amber-700">Preview unavailable: {describeReason(metadata.reason)}</p>}
            {available && (
              <>
                <p className="text-sm">Attendee: <strong>{name}</strong><br />Email destination: <strong>{recipient || "No valid attendee email"}</strong></p>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => action("preview")} data-testid="button-preview-cpd-certificate">
                  {busy === "preview" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Preview CPD certificate
                </Button>
                {pdfBytes && <CertificatePdfCanvasPreview bytes={pdfBytes} pdfEngine={pdfEngine} />}
                {sent ? (
                  <div className="space-y-2">
                    <p role="status" className="text-sm">Certificate email request accepted for {recipient}. This does not confirm inbox delivery.</p>
                    <Button variant="outline" onClick={prepareResend} data-testid="button-prepare-cpd-resend">Prepare another email</Button>
                  </div>
                ) : (
                  <div className="space-y-2 border-t pt-3">
                    {!canSend && <p role="status" className="text-sm text-amber-700">Email unavailable: {["pending", "unknown"].includes(metadata.latest_delivery?.status) ? "A previous send is pending or its provider outcome is unknown. Reconcile it before sending again." : describeReason(metadata.send_reason || metadata.reason || "missing_recipient")}</p>}
                    {canSend && <>
                      {wasAccepted(metadata.latest_delivery) && <p className="text-sm text-amber-700">A certificate email was already accepted. Sending again will create another email.</p>}
                      <label className="flex items-start gap-2 text-sm">
                        <Checkbox checked={confirmed} disabled={!!busy} onCheckedChange={value => setConfirmed(value === true)} data-testid="confirm-cpd-email" />
                        <span>I confirm I want to email the CPD certificate for <strong>{name}</strong> to <strong>{recipient}</strong>.</span>
                      </label>
                      <Button type="button" disabled={!confirmed || !!busy} onClick={() => action("send")} data-testid="button-email-cpd-certificate">
                        {busy === "send" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {wasAccepted(metadata.latest_delivery) ? "Send another email" : "Email CPD certificate"}
                      </Button>
                    </>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={!!busy} onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
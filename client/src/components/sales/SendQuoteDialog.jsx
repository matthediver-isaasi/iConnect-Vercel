import { useQuoteNaming } from "@/hooks/useSalesSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Eye, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Unmount the form between sessions so drafts and successful previews cannot
// leak into the next delivery. Prop changes within a session keep the draft.
export default function SendQuoteDialog(props) {
  return props.open ? <SendQuoteForm {...props} /> : null;
}

function SendQuoteForm({ open, onOpenChange, pending, onSend, request, quoteId, version, initialRecipient = "", contacts = [] }) {
  const { singular } = useQuoteNaming();
  const [recipient, setRecipient] = useState(initialRecipient);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [attachPdf, setAttachPdf] = useState(true);
  const [personalMessage, setPersonalMessage] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const requestId = useRef(0);
  const sendLock = useRef(false);
  const recipientEdited = useRef(false);
  const payload = { recipient: recipient.trim(), expiresInDays: Number(expiresInDays), attachPdf, personalMessage, version };
  const fingerprint = JSON.stringify([quoteId, payload]);
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  const busy = pending || sending;
  const valid = Boolean(quoteId && version != null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.recipient) && personalMessage.length <= 5000);
  const freshPreview = preview?.fingerprint === fingerprint ? preview.data : null;
  // Sanitize only the displayed copy. The server-rendered/sent email and plain
  // text draft remain unchanged. Retain email layout/styles, but strip every
  // navigation target and interactive or executable embedded element.
  const previewHtml = useMemo(() => DOMPurify.sanitize(freshPreview?.html || "", {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: [
      "script", "form", "input", "button", "select", "textarea", "option",
      "base", "meta", "link", "iframe", "frame", "frameset", "object", "embed",
      "applet", "portal", "svg", "math", "audio", "video", "source", "track",
    ],
    FORBID_ATTR: ["href", "action", "formaction", "target", "xlink:href", "srcdoc", "autofocus", "contenteditable"],
  }), [freshPreview?.html]);

  const invalidate = () => {
    requestId.current += 1;
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError("");
    setSendError("");
  };
  useEffect(() => {
    invalidate();
    return () => { requestId.current += 1; };
  }, [quoteId, version]);
  useEffect(() => {
    if (initialRecipient && !recipientEdited.current && !busy && recipient !== initialRecipient) {
      invalidate();
      setRecipient(initialRecipient);
    }
  }, [initialRecipient, busy]);
  const edit = (setter, value) => {
    if (setter === setRecipient) recipientEdited.current = true;
    invalidate();
    setter(value);
  };
  const previewEmail = async () => {
    if (!valid || busy || previewLoading) return;
    const id = ++requestId.current;
    const requestedFingerprint = fingerprint;
    setPreview(null);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      // Reuse the workspace's authenticated request layer.
      const data = await request(`/api/sales/quotes/${encodeURIComponent(quoteId)}?action=preview-email`, {
        method: "POST", credentials: "include", body: JSON.stringify(payload),
      });
      if (id === requestId.current && requestedFingerprint === currentFingerprint.current) {
        setPreview({ fingerprint: requestedFingerprint, data });
      }
    } catch (error) {
      if (id === requestId.current && requestedFingerprint === currentFingerprint.current) {
        setPreviewError(error.message || "Could not load the email preview.");
      }
    } finally {
      if (id === requestId.current) setPreviewLoading(false);
    }
  };
  const send = async () => {
    if (!valid || !freshPreview || busy || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setSendError("");
    try {
      await onSend(payload);
      setPreview(null);
    } catch (error) {
      setSendError(error.message || `Could not send the ${singular}. Your message has been kept; please try again.`);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent hideCloseButton={busy} className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Send {singular}</DialogTitle>
        <DialogDescription>Review the email before sending a secure, expiring link to this exact {singular} version.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-2 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="quote-recipient-contact">Opportunity contact</Label>
          <select id="quote-recipient-contact" aria-label={`${singular} recipient contact`} disabled={busy} className="w-full rounded-md border bg-background p-2 text-sm" value={contacts.some(contact => contact.email === recipient) ? recipient : ""} onChange={event => edit(setRecipient, event.target.value)}>
            <option value="">Enter an email address below</option>
            {contacts.filter(contact => contact.email).map(contact => <option key={contact.id || contact.email} value={contact.email}>{contact.name} — {contact.email}</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="quote-recipient-email">Recipient email</Label><Input id="quote-recipient-email" type="email" autoFocus disabled={busy} value={recipient} onChange={event => edit(setRecipient, event.target.value)} placeholder="customer@example.com" /></div>
        <div className="space-y-1.5"><Label htmlFor="quote-link-expiry">Link expiry</Label><Select disabled={busy} value={expiresInDays} onValueChange={value => edit(setExpiresInDays, value)}><SelectTrigger id="quote-link-expiry"><SelectValue /></SelectTrigger><SelectContent>{["7", "14", "30", "60", "90"].map(days => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="quote-personal-message">Personal message <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="quote-personal-message" disabled={busy} rows={5} maxLength={5000} value={personalMessage} onChange={event => edit(setPersonalMessage, event.target.value)} aria-describedby="quote-message-help" placeholder="Add a note for your customer…" className="resize-y" />
          <div id="quote-message-help" className="flex justify-between gap-3 text-xs text-muted-foreground"><span>Plain text. Line breaks are preserved.</span><span>{personalMessage.length.toLocaleString()} / 5,000</span></div>
        </div>
        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm sm:col-span-2"><Checkbox disabled={busy} checked={attachPdf} onCheckedChange={value => edit(setAttachPdf, value === true)} /><span><strong className="block">Attach PDF</strong><span className="text-muted-foreground">Also include the branded PDF alongside the secure link.</span></span></label>
      </div>
      <section aria-label="Email preview" className="min-w-0 rounded-lg border bg-muted/30 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Email preview</h3><Button type="button" variant="outline" size="sm" disabled={!valid || busy || previewLoading} onClick={previewEmail}><Eye className="mr-2 h-4 w-4" />{previewLoading ? "Preparing preview…" : "Preview email"}</Button></div>
        {previewLoading ? <div role="status" className="space-y-3"><span className="text-sm text-muted-foreground">Preparing your email preview…</span><div className="h-4 w-3/4 animate-pulse rounded bg-muted" /><div className="h-40 animate-pulse rounded bg-muted" /></div> :
          previewError ? <div role="alert" className="text-sm text-destructive"><p>{previewError}</p><Button type="button" variant="outline" size="sm" className="mt-3" disabled={!valid || busy} onClick={previewEmail}>Retry preview</Button></div> :
          freshPreview ? <div className="space-y-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm"><dt className="text-muted-foreground">Subject</dt><dd className="break-words font-medium">{freshPreview.subject}</dd><dt className="text-muted-foreground">To</dt><dd className="break-words">{freshPreview.recipient}</dd><dt className="text-muted-foreground">PDF attachment</dt><dd>{freshPreview.attachPdf ? "Yes" : "No"}</dd></dl>
            <p className="text-xs text-muted-foreground">Preview links are disabled. Previewing does not send an email or create a live {singular} link.</p>
            <div className="overflow-hidden rounded-md border bg-background">
              <iframe title={`${singular} email preview`} sandbox="" referrerPolicy="no-referrer" tabIndex={0} srcDoc={previewHtml} className="h-80 w-full border-0" />
            </div>
          </div> : <p className="py-5 text-center text-sm text-muted-foreground">Preview the email to check your message and enable sending. Any changes require a new preview.</p>}
      </section>
      {sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}
      <DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" disabled={!valid || !freshPreview || busy || previewLoading} onClick={send}><Send className="mr-2 h-4 w-4" />{busy ? "Sending…" : `Send ${singular}`}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

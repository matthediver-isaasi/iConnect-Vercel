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
import SignatureField from "@/components/forms/SignatureField";
import AgreementDocument from "./AgreementDocument";
import { legalHtmlOf, signaturePayload } from "./agreementSignature";

// Unmount the form between sessions so drafts and successful previews cannot
// leak into the next delivery. Prop changes within a session keep the draft.
export default function SendQuoteDialog(props) {
  return props.open ? <SendQuoteForm {...props} /> : null;
}

function SendQuoteForm({ open, onOpenChange, pending, onSend, onRequestSignature, signingRequest, request, quoteId, version, initialRecipient = "", contacts = [], quote = {} }) {
  const draft = signingRequest?.draft || {};
  const { singular } = useQuoteNaming();
  const [recipient, setRecipient] = useState(draft.recipient || initialRecipient);
  const [senderKey, setSenderKey] = useState("");
  const [senders, setSenders] = useState([]);
  const [senderError, setSenderError] = useState("");
  const [senderLoading, setSenderLoading] = useState(true);
  const [senderRetry, setSenderRetry] = useState(0);
  const [selfKey, setSelfKey] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderRole, setSenderRole] = useState("");
  const [senderConsent, setSenderConsent] = useState(false);
  const [senderSignature, setSenderSignature] = useState(null);
  const [contactName, setContactName] = useState(() => draft.contactName || quote.agreement?.contact?.name || contacts.find(contact => contact.email === initialRecipient)?.name || "");
  const [contactRole, setContactRole] = useState(() => draft.contactRole || quote.agreement?.contact?.role || contacts.find(contact => contact.email === initialRecipient)?.role || "");
  const agreement = Boolean(legalHtmlOf(quote));
  const frozenAgreement = agreement && Boolean(quote.agreement?.sender?.signedAt);
  const requestingSignature = agreement && !frozenAgreement && senderKey && senderKey !== selfKey;
  useEffect(() => {
    let active = true;
    setSenderLoading(true);
    setSenderError("");
    setSenderKey("");
    setSenders([]);
    request(`/api/sales/quotes/${encodeURIComponent(quoteId)}?action=sender-options`, { method: "GET", credentials: "include" })
      .then(data => {
        if (!active) return;
        setSenders(data.items);
        setSenderKey(signingRequest?.senderKey || (frozenAgreement ? data.items.find(item => item.email?.toLowerCase() === quote.agreement?.sender?.email?.toLowerCase())?.key : "") || data.defaultSenderKey || "");
        const actorKey = data.selfSenderKey || data.currentUserKey || data.items.find(item => item.isSelf)?.key || data.defaultSenderKey || "";
        setSelfKey(actorKey);
        setSenderName(data.items.find(item => item.key === actorKey)?.name || "");
      }).catch(error => { if (active) setSenderError(error.message || "Could not load senders."); })
      .finally(() => { if (active) setSenderLoading(false); });
    return () => { active = false; };
  }, [quoteId, senderRetry]);
  const [expiresInDays, setExpiresInDays] = useState(String(draft.expiresInDays || 30));
  const [attachPdf, setAttachPdf] = useState(draft.attachPdf !== false);
  const [personalMessage, setPersonalMessage] = useState(draft.personalMessage || "");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const requestId = useRef(0);
  const sendLock = useRef(false);
  const recipientEdited = useRef(false);
  const payload = { recipient: recipient.trim(), expiresInDays: Number(expiresInDays), attachPdf, personalMessage, version, senderKey, ...(signingRequest?.id ? { signingRequestId: signingRequest.id } : {}), ...(agreement ? { ...(!frozenAgreement && !requestingSignature ? { senderName: senderName.trim(), senderRole: senderRole.trim(), senderConsent, senderSignature: signaturePayload(senderSignature) } : {}), contactName: contactName.trim(), contactRole: contactRole.trim(), contactEmail: recipient.trim() } : {}) };
  const fingerprint = JSON.stringify([quoteId, payload]);
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  const busy = pending || sending;
  const deliveryValid = Boolean(!senderLoading && !senderError && senders.some(item => item.key === senderKey) && quoteId && version != null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.recipient) && personalMessage.length <= 5000 && (!agreement || (contactName.trim() && contactRole.trim())));
  const valid = deliveryValid && !requestingSignature && (!agreement || frozenAgreement || (senderKey === selfKey && senderName.trim() && senderRole.trim() && senderConsent && signaturePayload(senderSignature)));
  // Explain every local gate without relaxing the preview/signature guards.
  const deliveryRequirements = [
    senderLoading && "Wait for senders to finish loading.",
    senderError && "Retry loading senders.",
    !senderLoading && !senderError && !senders.some(item => item.key === senderKey) && (senders.length ? "Choose an eligible sender." : "Add an eligible owner or collaborator with a valid email address, then retry senders."),
    !quoteId && "Reopen this dialog from a saved quote.",
    version == null && "Reload the quote to load its current version.",
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.recipient) && "Enter a valid recipient email address.",
    personalMessage.length > 5000 && "Shorten the personal message to 5,000 characters or fewer.",
    agreement && !contactName.trim() && "Enter the customer signatory’s name.",
    agreement && !contactRole.trim() && "Enter the customer signatory’s role / job title.",
  ].filter(Boolean);
  const previewRequirements = [
    ...deliveryRequirements,
    agreement && !frozenAgreement && !requestingSignature && senderKey !== selfKey && "Choose yourself to sign, or select a colleague to request their signature.",
    agreement && !frozenAgreement && !requestingSignature && !senderName.trim() && "Enter your full name.",
    agreement && !frozenAgreement && !requestingSignature && !senderRole.trim() && "Enter your role / job title.",
    agreement && !frozenAgreement && !requestingSignature && !signaturePayload(senderSignature) && "Add your signature.",
    agreement && !frozenAgreement && !requestingSignature && !senderConsent && "Review the full agreement and confirm your signing consent.",
  ].filter(Boolean);
  const colleagueRequirements = [...deliveryRequirements, !onRequestSignature && "Signature requests are unavailable here. Reopen the quote or contact your workspace administrator."].filter(Boolean);
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
    if (setter === setSenderKey) { setSenderSignature(null); setSenderConsent(false); }
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
  const requestSignature = async () => {
    if (!requestingSignature || !deliveryValid || busy || sendLock.current || !onRequestSignature) return;
    sendLock.current = true;
    setSending(true);
    setSendError("");
    try { await onRequestSignature(payload); }
    catch (error) { setSendError(error.message || "Could not request the colleague’s signature. Your draft has been kept. If notification failed, wait 60 seconds before retrying."); }
    finally { sendLock.current = false; setSending(false); }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent hideCloseButton={busy} className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Send {singular}</DialogTitle>
        <DialogDescription>Review the email before sending a secure, expiring link to this exact {singular} version.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-2 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="quote-sender">Sender (required)</Label>
          <select id="quote-sender" required aria-required="true" disabled={busy || senderLoading || frozenAgreement || Boolean(signingRequest)} className="w-full rounded-md border bg-background p-2 text-sm" value={senderKey} onChange={event => edit(setSenderKey, event.target.value)}>
            <option value="">{senderLoading ? "Loading senders…" : "Choose a sender"}</option>
            {senders.map(sender => <option key={sender.key} value={sender.key}>{sender.name} — {sender.email}{agreement && sender.key !== selfKey ? " (request their signature)" : ""}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Sent using the tenant’s sending address and this person’s name. Replies go to this person.</p>
          {agreement && <p className="text-xs text-muted-foreground">Only sign as yourself. Choosing a colleague requests their signature through an authenticated workspace link; it never signs on their behalf.</p>}
          {senderError ? <div role="alert" className="text-sm text-destructive">{senderError} <Button variant="outline" size="sm" onClick={() => setSenderRetry(value => value + 1)}>Retry senders</Button></div> : !senderLoading && !senders.length ? <p role="alert" className="text-sm text-destructive">No eligible owner or collaborator has a valid email address.</p> : null}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="quote-recipient-contact">Opportunity contact</Label>
          <select id="quote-recipient-contact" aria-label={`${singular} recipient contact`} disabled={busy || frozenAgreement} className="w-full rounded-md border bg-background p-2 text-sm" value={contacts.some(contact => contact.email === recipient) ? recipient : ""} onChange={event => { edit(setRecipient, event.target.value); const contact = contacts.find(item => item.email === event.target.value); setContactName(contact?.name || ""); setContactRole(contact?.role || contact?.jobTitle || contact?.job_title || ""); }}>
            <option value="">Enter an email address below</option>
            {contacts.filter(contact => contact.email).map(contact => <option key={contact.id || contact.email} value={contact.email}>{contact.name} — {contact.email}</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="quote-recipient-email">Recipient email (required)</Label><Input id="quote-recipient-email" type="email" required aria-required="true" autoFocus disabled={busy || frozenAgreement} value={recipient} onChange={event => edit(setRecipient, event.target.value)} placeholder="customer@example.com" /></div>
        {agreement && <><div className="space-y-1.5"><Label htmlFor="agreement-contact-name">Customer signatory name (required)</Label><Input id="agreement-contact-name" required aria-required="true" disabled={busy || frozenAgreement} value={contactName} onChange={event => edit(setContactName, event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-contact-role">Customer signatory role / job title (required)</Label><Input id="agreement-contact-role" required aria-required="true" disabled={busy || frozenAgreement} value={contactRole} onChange={event => edit(setContactRole, event.target.value)} /></div></>}
        <div className="space-y-1.5"><Label htmlFor="quote-link-expiry">Link expiry</Label><Select disabled={busy} value={expiresInDays} onValueChange={value => edit(setExpiresInDays, value)}><SelectTrigger id="quote-link-expiry"><SelectValue /></SelectTrigger><SelectContent>{["7", "14", "30", "60", "90"].map(days => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="quote-personal-message">Personal message <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="quote-personal-message" disabled={busy} rows={5} maxLength={5000} value={personalMessage} onChange={event => edit(setPersonalMessage, event.target.value)} aria-describedby="quote-message-help" placeholder="Add a note for your customer…" className="resize-y" />
          <div id="quote-message-help" className="flex justify-between gap-3 text-xs text-muted-foreground"><span>Plain text. Line breaks are preserved.</span><span>{personalMessage.length.toLocaleString()} / 5,000</span></div>
        </div>
        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm sm:col-span-2"><Checkbox disabled={busy} checked={attachPdf} onCheckedChange={value => edit(setAttachPdf, value === true)} /><span><strong className="block">Attach PDF</strong><span className="text-muted-foreground">Also include the branded PDF alongside the secure link.</span></span></label>
      </div>
      {requestingSignature && <section className="space-y-3 rounded-lg border bg-muted/30 p-4"><h3 className="font-semibold">Request your colleague’s signature</h3><p className="text-sm text-muted-foreground">The selected colleague receives an authenticated link to review this version, sign as themselves and send it to the customer. No signature or customer email is sent by this request.</p><details><summary className="cursor-pointer text-sm font-semibold">Review full agreement</summary><div className="mt-4"><AgreementDocument quote={quote} recipient={{ name: contactName, role: contactRole, email: recipient }} /></div></details></section>}
      {frozenAgreement && <section className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">Resend signed version</h3><p className="text-sm text-muted-foreground">The original sender signature and contact details are frozen. Resend to the same recipient; make an amendment for changes.</p><AgreementDocument quote={quote} sender={quote.agreement.sender} recipient={quote.agreement.contact} /></section>}
      {agreement && !requestingSignature && !frozenAgreement && <section className="space-y-4 rounded-lg border p-4" aria-label="Sender agreement signature">
        <details><summary className="cursor-pointer text-sm font-semibold">Review the full agreement before signing</summary><div className="mt-4"><AgreementDocument quote={quote} sender={{ name: senderName, role: senderRole, email: senders.find(sender => sender.key === senderKey)?.email, signature: senderSignature }} recipient={{ name: contactName, role: contactRole, email: recipient }} /></div></details>
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="agreement-sender-name">Your full name (required)</Label><Input id="agreement-sender-name" required aria-required="true" disabled={busy} value={senderName} onChange={event => edit(setSenderName, event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-sender-role">Your role / job title (required)</Label><Input id="agreement-sender-role" required aria-required="true" aria-describedby={!senderRole.trim() ? "agreement-sender-role-help" : undefined} disabled={busy} value={senderRole} onChange={event => edit(setSenderRole, event.target.value)} />{!senderRole.trim() && <p id="agreement-sender-role-help" className="text-xs text-muted-foreground">Enter your role / job title to preview the email. This is required with your name, signature and consent.</p>}</div></div>
        <Label>Your signature (required)</Label><SignatureField fieldId="sales-sender" allowUpload disabled={busy} value={senderSignature} onChange={value => edit(setSenderSignature, value)} />
        <label className="flex items-start gap-3 text-sm"><Checkbox aria-required="true" disabled={busy} checked={senderConsent} onCheckedChange={checked => edit(setSenderConsent, checked === true)} /><span>I have reviewed this complete agreement, am authorised to sign on behalf of the sender, and consent to using my electronic signature. I am signing as myself, not as a colleague. (Required)</span></label>
        <p className="text-xs text-muted-foreground">Sending signs this exact version. The customer must verify their email and add their own signature.</p>
      </section>}
      {!requestingSignature && <section aria-label="Email preview" className="min-w-0 rounded-lg border bg-muted/30 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Email preview</h3><Button type="button" variant="outline" size="sm" aria-describedby={previewRequirements.length ? "quote-preview-requirements" : undefined} disabled={!valid || busy || previewLoading} onClick={previewEmail}><Eye className="mr-2 h-4 w-4" />{previewLoading ? "Preparing preview…" : "Preview email"}</Button></div>
        {previewRequirements.length > 0 && <div id="quote-preview-requirements" aria-live="polite" className="mb-3 text-sm text-muted-foreground"><p className="font-medium">Before you can preview:</p><ul className="list-disc space-y-1 pl-5">{previewRequirements.map(item => <li key={item}>{item}</li>)}</ul>{frozenAgreement && <p className="mt-2">Signed details cannot be edited here. Reopen the signed version or make an amendment if they need correcting.</p>}</div>}
        {previewLoading ? <div role="status" className="space-y-3"><span className="text-sm text-muted-foreground">Preparing your email preview…</span><div className="h-4 w-3/4 animate-pulse rounded bg-muted" /><div className="h-40 animate-pulse rounded bg-muted" /></div> :
          previewError ? <div role="alert" className="text-sm text-destructive"><p>{previewError}</p><Button type="button" variant="outline" size="sm" className="mt-3" disabled={!valid || busy} onClick={previewEmail}>Retry preview</Button></div> :
          freshPreview ? <div className="space-y-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm"><dt>From</dt><dd className="break-words">{freshPreview.from}</dd><dt>Reply-To</dt><dd className="break-words">{freshPreview.replyTo}</dd></dl>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm"><dt className="text-muted-foreground">Subject</dt><dd className="break-words font-medium">{freshPreview.subject}</dd><dt className="text-muted-foreground">To</dt><dd className="break-words">{freshPreview.recipient}</dd><dt className="text-muted-foreground">PDF attachment</dt><dd>{freshPreview.attachPdf ? "Yes" : "No"}</dd></dl>
            <p className="text-xs text-muted-foreground">Preview links are disabled. Previewing does not send an email or create a live {singular} link.</p>
            <div className="overflow-hidden rounded-md border bg-background">
              <iframe title={`${singular} email preview`} sandbox="" referrerPolicy="no-referrer" tabIndex={0} srcDoc={previewHtml} className="h-80 w-full border-0" />
            </div>
          </div> : <p className="py-5 text-center text-sm text-muted-foreground">Preview the email to check your message and enable sending. Any changes require a new preview.</p>}
      </section>}
      {sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}
      {requestingSignature && colleagueRequirements.length > 0 && <div id="quote-colleague-requirements" aria-live="polite" className="text-sm text-muted-foreground"><p className="font-medium">Before you can request a colleague’s signature:</p><ul className="list-disc space-y-1 pl-5">{colleagueRequirements.map(item => <li key={item}>{item}</li>)}</ul></div>}
      <DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>{requestingSignature ? <Button type="button" aria-describedby={colleagueRequirements.length ? "quote-colleague-requirements" : undefined} disabled={!deliveryValid || busy || !onRequestSignature} onClick={requestSignature}>{busy ? "Requesting signature…" : "Request colleague signature"}</Button> : <Button type="button" disabled={!valid || !freshPreview || busy || previewLoading} onClick={send}><Send className="mr-2 h-4 w-4" />{busy ? "Sending…" : `Send ${singular}`}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}

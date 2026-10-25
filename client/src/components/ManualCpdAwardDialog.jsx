import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, CheckCircle2, Eye, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import { CertificatePdfCanvasPreview } from "@/components/events/AttendeeCpdCertificateDialog";
import { createManualCpdSession, loadManualCpdOptions, postManualCpd, validManualCpdAward } from "./manualCpdAwards.mjs";

const EMPTY_FIELDS = { template_id: "", points_value: "", activity_title: "", activity_date: "" };

export default function ManualCpdAwardDialog({ memberId, pdfEngine }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [sendEmail, setSendEmail] = useState(false);
  const [message, setMessage] = useState("<p>Please find your CPD certificate attached.</p>");
  const [bytes, setBytes] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [emailStatus, setEmailStatus] = useState("not_sent");
  const sessionRef = useRef(null);
  const inFlightRef = useRef(false);
  if (!sessionRef.current) sessionRef.current = createManualCpdSession(memberId);
  const session = sessionRef.current;
  const options = useQuery({
    queryKey: ["manual-cpd-award-options", memberId],
    enabled: open && !!memberId,
    queryFn: () => loadManualCpdOptions(memberId),
    retry: false,
  });
  const locked = Boolean(busy || saved || uncertain);
  const valid = validManualCpdAward(fields);

  useEffect(() => {
    if (!uncertain && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uncertain, busy]);

  function update(name, value) {
    if (locked) return;
    setFields(previous => ({ ...previous, [name]: value }));
    setBytes(null);
    setError("");
  }

  async function preview() {
    if (inFlightRef.current || !valid) return;
    inFlightRef.current = true;
    setBusy("preview");
    setError("");
    try {
      setBytes(await postManualCpd({ action: "preview", member_id: memberId, ...fields }));
    } catch (err) {
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      setBusy("");
    }
  }

  async function emailSavedAward() {
    setBusy("email");
    try {
      const result = await session.email(message);
      setEmailStatus(result.status);
      if (result.status !== "sent") {
        setError(result.status === "failed"
          ? "The award is saved, but the certificate email failed. You can retry email without awarding points again."
          : "The award is saved. Email delivery is not confirmed; retry to check the same email request.");
      }
    } catch (err) {
      setEmailStatus("unknown");
      setError(`The award is saved, but email delivery could not be confirmed. ${err.message}`);
    }
  }

  async function submit() {
    if (inFlightRef.current || (!saved && !uncertain && !valid)) return;
    inFlightRef.current = true;
    setError("");
    try {
      if (!saved) {
        setBusy("award");
        const result = await session.award(fields);
        setSaved(result.entry);
        setUncertain(false);
        // The correction query uses this exact key; the paginated history uses
        // the same prefix. Refresh both, plus certificate availability.
        void queryClient.invalidateQueries({ queryKey: ["member-cpd-points", memberId] });
        void queryClient.invalidateQueries({ queryKey: ["member-cpd-certificates", memberId] });
      }
      if (sendEmail || saved) await emailSavedAward();
    } catch (err) {
      setUncertain(session.locked && !session.entry);
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      setBusy("");
    }
  }

  function changeOpen(next) {
    // Dismissal would hide an unresolved award or interrupt its separate email.
    if (!next && (inFlightRef.current || uncertain)) return;
    setOpen(next);
  }

  function startAnother() {
    sessionRef.current = createManualCpdSession(memberId);
    setFields(EMPTY_FIELDS);
    setSaved(null);
    setUncertain(false);
    setEmailStatus("not_sent");
    setSendEmail(false);
    setMessage("<p>Please find your CPD certificate attached.</p>");
    setBytes(null);
    setError("");
  }

  return <>
    <div className="flex justify-end">
      <Button onClick={() => setOpen(true)}><Award className="mr-2 h-4 w-4" />
        {saved ? "View saved manual CPD award" : "Award manual CPD"}
      </Button>
    </div>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="w-[95vw] max-w-3xl max-h-[90vh] overflow-y-auto"
        onEscapeKeyDown={event => { if (busy || uncertain) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy || uncertain) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{saved ? "Manual CPD award saved" : "Award manual CPD"}</DialogTitle>
          <DialogDescription>
            {saved ? "The points and certificate are recorded. Email delivery is managed separately."
              : "Record a trusted CPD activity and create a certificate for this member."}
          </DialogDescription>
        </DialogHeader>
        {options.isPending && <div role="status" aria-label="Loading certificate templates" className="space-y-3 py-4">
          <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-10 rounded bg-muted" />
          <div className="h-10 rounded bg-muted" />
        </div>}
        {options.isError && <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{options.error.message}</p>
          <Button variant="outline" onClick={() => options.refetch()}>Retry templates</Button>
        </div>}
        {options.data && <div className="space-y-5">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{options.data.member?.name || "Selected member"}</p>
            <p className="text-muted-foreground">{options.data.member?.email || "No email address recorded"}</p>
          </div>
          {saved && <div role="status" className="rounded-lg border p-4 space-y-1">
            <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 text-emerald-700" />{fields.points_value} CPD points awarded</p>
            <p className="text-sm text-muted-foreground">{fields.activity_title} · {fields.activity_date}</p>
            <p className="text-sm">Award reference: {saved.id}</p>
            <p className="text-sm">{emailStatus === "sent" ? "Certificate email sent."
              : emailStatus === "not_sent" ? "Certificate email not sent." : `Email status: ${emailStatus}. The award remains saved.`}</p>
          </div>}
          {!saved && <>
            <div className="space-y-2">
              <Label htmlFor="manual-cpd-template">Certificate template</Label>
              <Select value={fields.template_id} onValueChange={value => update("template_id", value)} disabled={locked}>
                <SelectTrigger id="manual-cpd-template"><SelectValue placeholder="Select a certificate template" /></SelectTrigger>
                <SelectContent>{(options.data.templates || []).map(template =>
                  <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>)}</SelectContent>
              </Select>
              {!options.data.templates?.length && <p className="text-sm text-muted-foreground">No certificate templates are available. Configure a template before awarding manual CPD.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-cpd-title">Event or activity name</Label>
              <Input id="manual-cpd-title" value={fields.activity_title} onChange={event => update("activity_title", event.target.value)} disabled={locked} />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-cpd-points">CPD points</Label>
                <Input id="manual-cpd-points" type="number" min="0" step="any" value={fields.points_value} onChange={event => update("points_value", event.target.value)} disabled={locked} />
                <p className="text-xs text-muted-foreground">Enter a positive amount. Decimal points are supported.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-cpd-date">Activity date</Label>
                <Input id="manual-cpd-date" type="date" value={fields.activity_date} onChange={event => update("activity_date", event.target.value)} disabled={locked} />
              </div>
            </div>
          </>}
          <div className="space-y-3 border-t pt-4">
            {!saved && <div className="flex items-center gap-2">
              <Checkbox id="manual-cpd-send-email" checked={sendEmail} onCheckedChange={checked => setSendEmail(checked === true)} disabled={locked || !options.data.member?.email} />
              <Label htmlFor="manual-cpd-send-email">Email the certificate after saving the award</Label>
            </div>}
            {(sendEmail || saved) && emailStatus !== "sent" && <div className="space-y-2">
              <Label htmlFor="manual-cpd-message">Certificate email message</Label>
              <SimpleRichTextEditor id="manual-cpd-message" aria-label="Certificate email message"
                content={message} onChange={setMessage} disabled={Boolean(busy || uncertain || session.emailLocked)} />
              <p className="text-xs text-muted-foreground">The certificate PDF is attached automatically. Email retries use the original message and request.</p>
            </div>}
          </div>
        </div>}
        {uncertain && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          This award may already exist. The original details are locked. Retry the award request to confirm it without creating a duplicate. Do not navigate away until resolved.
        </p>}
        {busy && <p role="status" className="text-sm text-muted-foreground">
          {busy === "preview" ? "Preparing certificate preview…" : busy === "award" ? "Saving CPD award…" : "Sending certificate email…"}
        </p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {bytes && <div className="space-y-2"><h3 className="text-sm font-medium">Certificate PDF preview</h3>
          <CertificatePdfCanvasPreview bytes={bytes} pdfEngine={pdfEngine} />
        </div>}
        <DialogFooter className="gap-2 sm:flex-wrap">
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={Boolean(busy || uncertain)}>{saved ? "Close" : "Cancel"}</Button>
          {!saved && <>
            <Button variant="outline" onClick={preview} disabled={!valid || Boolean(busy || uncertain) || !options.data}>
              <Eye className="mr-2 h-4 w-4" />Preview PDF
            </Button>
            <Button onClick={submit} disabled={Boolean(busy) || (!uncertain && (!valid || !options.data))}>
              {uncertain ? "Retry award request" : sendEmail ? "Award CPD and email" : "Award CPD"}
            </Button>
          </>}
          {saved && <>
            {(emailStatus === "sent" || emailStatus === "not_sent") && <Button variant="outline" onClick={startAnother} disabled={Boolean(busy)}>Award another activity</Button>}
            {emailStatus !== "sent" && <Button onClick={submit} disabled={Boolean(busy || !options.data?.member?.email)}>
              <Mail className="mr-2 h-4 w-4" />{emailStatus === "not_sent" ? "Email certificate" : "Retry certificate email"}
            </Button>}
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

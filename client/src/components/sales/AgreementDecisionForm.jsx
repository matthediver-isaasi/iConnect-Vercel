import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SignatureField from "@/components/forms/SignatureField";
import { signaturePayload } from "./agreementSignature";

export default function AgreementDecisionForm({ agreement, path, request, pending, onSubmit, onCancel }) {
  const [form, setForm] = useState({ name: agreement.contact?.name || "", role: agreement.contact?.role || "", purchaseOrderReference: "", customerReference: "", agreement: false });
  const [signature, setSignature] = useState(null);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);
  const [captured, setCaptured] = useState(null);
  const [proof, setProof] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const completed = useRef(false);
  const patch = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const sendCode = useMutation({
    mutationFn: () => request(`${path}/send-otp`, { method: "POST", body: "{}" }),
  });
  const verifyCode = useMutation({
    mutationFn: () => request(`${path}/verify-otp`, { method: "POST", body: JSON.stringify({ code: code.trim() }) }),
  });
  useEffect(() => {
    if (!proof) return;
    const timer = setTimeout(() => {
      setProof(null);
      setError("Email verification has expired. Please request a new code. Your signature is still here.");
    }, Math.max(0, proof.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [proof]);
  const busy = pending || submitting || sendCode.isPending || verifyCode.isPending;
  const ready = form.name.trim() && form.role.trim() && form.agreement && signaturePayload(signature);
  const send = async () => {
    if (inFlight.current || pending || completed.current) return;
    inFlight.current = true;
    setError(""); setProof(null); setCode(""); setSent(false);
    try { await sendCode.mutateAsync(); setSent(true); }
    catch (failure) { setError(failure.message || "We couldn't send your code. Please try again."); }
    finally { inFlight.current = false; }
  };
  const begin = () => {
    if (!ready || busy || open || completed.current) return;
    setCaptured({ ...form, consent: true, signature: { ...signaturePayload(signature) } });
    setOpen(true);
    void send();
  };
  const submitCaptured = async verification => {
    if (!verification || Date.now() >= verification.expiresAt) {
      setProof(null);
      throw new Error("Email verification has expired. Please request a new code. Your signature is still here.");
    }
    setSubmitting(true);
    try {
      await onSubmit({ ...captured, signature: { ...captured.signature }, verificationProof: verification.value });
      completed.current = true;
      setProof(null);
      setOpen(false);
    } finally { setSubmitting(false); }
  };
  const verifyAndSubmit = async () => {
    if (inFlight.current || busy || completed.current || !captured) return;
    if (!proof && (!sent || !/^\d{6}$/.test(code))) return;
    inFlight.current = true; setError("");
    try {
      let verification = proof;
      if (!verification) {
        const data = await verifyCode.mutateAsync();
        const seconds = Number(data?.expiresInSeconds ?? 600);
        if (data?.verified !== true || typeof data.verificationProof !== "string" || !data.verificationProof.trim() || !Number.isFinite(seconds) || seconds <= 0) {
          throw new Error("We couldn't verify that code. Please check it or request a new one.");
        }
        verification = { value: data.verificationProof, expiresAt: Date.now() + seconds * 1000 };
        setProof(verification);
      }
      await submitCaptured(verification);
    } catch (failure) { setError(failure.message || "We couldn't record your agreement. Please try again."); }
    finally { inFlight.current = false; }
  };
  const back = () => {
    if (busy || inFlight.current) return;
    setOpen(false); setProof(null); setCaptured(null); setError(""); setCode(""); setSent(false);
  };
  return <Card><CardHeader><CardTitle>Sign and accept agreement</CardTitle><p className="text-sm text-muted-foreground">Review the full agreement and sender signature above, then add your own signature. When you accept, we will verify your email before recording your agreement.</p><p className="text-xs text-muted-foreground">Fields marked * are required.</p></CardHeader><CardContent className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="agreement-customer-name">Your full name *</Label><Input id="agreement-customer-name" required disabled={busy || open} value={form.name} onChange={event => patch("name", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-role">Role / job title *</Label><Input id="agreement-customer-role" required disabled={busy || open} value={form.role} onChange={event => patch("role", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-po">Purchase order reference (optional)</Label><Input id="agreement-customer-po" disabled={busy || open} value={form.purchaseOrderReference} onChange={event => patch("purchaseOrderReference", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-reference">Customer reference (optional)</Label><Input id="agreement-customer-reference" disabled={busy || open} value={form.customerReference} onChange={event => patch("customerReference", event.target.value)} /></div></div>
    <div className="space-y-2"><Label>Your signature *</Label><SignatureField fieldId="sales-customer" allowUpload disabled={busy || open} value={signature} onChange={setSignature} /></div>
    <label className="flex items-start gap-3 rounded-lg bg-muted/30 p-4 text-sm"><Checkbox aria-required="true" disabled={busy || open} checked={form.agreement} onCheckedChange={value => patch("agreement", value === true)} /><span>I have read the complete agreement, including the quoted items, prices, billing schedule and legal terms. I am authorised to sign for the customer and consent to using my electronic signature to accept this agreement. *</span></label>
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" disabled={busy || open} onClick={onCancel}>Cancel</Button><Button type="button" disabled={busy || open || !ready || completed.current} onClick={begin}>{pending ? "Recording agreement…" : "Sign and accept agreement"}</Button></div>
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent hideCloseButton onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Protect your signature</DialogTitle><DialogDescription>Confirming that you own this email address helps protect your signature. We will send a code only to {agreement.contact?.name ? `${agreement.contact.name} at ` : ""}{agreement.contact?.email || "the recipient email on this agreement"}. Your signed agreement is not submitted until you enter the correct code. Contact the sender if these details are incorrect.</DialogDescription></DialogHeader>
        {sendCode.isPending && <p role="status" className="text-sm text-muted-foreground">Sending your verification code…</p>}
        {sent && !proof && <div className="space-y-2"><Label htmlFor="agreement-email-code">Email verification code *</Label><Input id="agreement-email-code" required autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void verifyAndSubmit(); } }} /><p className="text-xs text-muted-foreground">Enter the six-digit code from your email. If it expires, request a new one.</p></div>}
        {proof && <p role="status" className="text-sm text-muted-foreground">Email verified. {submitting ? "Recording your signed agreement…" : "Retry recording your signed agreement below. You do not need to sign again."}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void send()}>{sendCode.isPending ? "Sending code…" : sent ? "Send a new code" : "Retry sending code"}</Button>
        <DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={busy} onClick={back}>Back to agreement</Button><Button type="button" disabled={busy || (!proof && (!sent || !/^\d{6}$/.test(code)))} onClick={() => void verifyAndSubmit()}>{submitting || pending ? "Recording agreement…" : verifyCode.isPending ? "Verifying…" : proof ? "Retry submission" : "Verify and accept agreement"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </CardContent></Card>;
}

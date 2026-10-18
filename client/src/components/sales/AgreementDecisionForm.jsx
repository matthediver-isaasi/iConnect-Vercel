import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import SignatureField from "@/components/forms/SignatureField";
import { signaturePayload } from "./agreementSignature";

export default function AgreementDecisionForm({ agreement, path, request, pending, onSubmit, onCancel }) {
  const [form, setForm] = useState({ name: agreement.contact?.name || "", role: agreement.contact?.role || "", purchaseOrderReference: "", customerReference: "", agreement: false });
  const [signature, setSignature] = useState(null);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verificationProof, setVerificationProof] = useState("");
  const [proofExpiresAt, setProofExpiresAt] = useState(0);
  const patch = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const sendCode = useMutation({
    mutationFn: () => request(`${path}/send-otp`, { method: "POST", body: "{}" }),
    onMutate: () => { setVerified(false); setVerificationProof(""); setProofExpiresAt(0); setCode(""); verifyCode.reset(); },
    onSuccess: () => setSent(true),
  });
  const verifyCode = useMutation({
    mutationFn: () => request(`${path}/verify-otp`, { method: "POST", body: JSON.stringify({ code: code.trim() }) }),
    onSuccess: data => {
      const valid = data.verified === true && typeof data.verificationProof === "string" && Boolean(data.verificationProof);
      setVerified(valid);
      setVerificationProof(valid ? data.verificationProof : "");
      setProofExpiresAt(valid ? Date.now() + Number(data.expiresInSeconds || 600) * 1000 : 0);
    },
  });
  useEffect(() => {
    if (!proofExpiresAt) return;
    const timer = setTimeout(() => { setVerified(false); setVerificationProof(""); setProofExpiresAt(0); }, Math.max(0, proofExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [proofExpiresAt]);
  const busy = pending || sendCode.isPending || verifyCode.isPending;
  return <Card><CardHeader><CardTitle>Sign and accept agreement</CardTitle><p className="text-sm text-muted-foreground">Review the full agreement and sender signature above, verify your email, then add your own signature.</p></CardHeader><CardContent className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="agreement-customer-name">Your full name</Label><Input id="agreement-customer-name" disabled={busy} value={form.name} onChange={event => patch("name", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-role">Role / job title</Label><Input id="agreement-customer-role" disabled={busy} value={form.role} onChange={event => patch("role", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-po">Purchase order reference (optional)</Label><Input id="agreement-customer-po" disabled={busy} value={form.purchaseOrderReference} onChange={event => patch("purchaseOrderReference", event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="agreement-customer-reference">Customer reference (optional)</Label><Input id="agreement-customer-reference" disabled={busy} value={form.customerReference} onChange={event => patch("customerReference", event.target.value)} /></div></div>
    <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-label="Email verification">
      <h3 className="text-sm font-semibold">Verify your email</h3><p className="break-words text-sm text-muted-foreground">A code will be sent only to {agreement.contact?.email || "the recipient email on this agreement"}. Contact the sender if these details are incorrect.</p>
      <Button type="button" variant="outline" disabled={busy} onClick={() => sendCode.mutate()}>{sendCode.isPending ? "Sending code…" : sent ? "Send a new code" : "Send verification code"}</Button>
      {sent && !verified && <div className="space-y-2"><Label htmlFor="agreement-email-code">Email verification code</Label><div className="flex flex-wrap gap-2"><Input id="agreement-email-code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} className="max-w-44" /><Button type="button" disabled={busy || !/^\d{6}$/.test(code)} onClick={() => verifyCode.mutate()}>{verifyCode.isPending ? "Verifying…" : "Verify code"}</Button></div><p className="text-xs text-muted-foreground">Verification expires after 10 minutes. If your code expires, request a new one.</p></div>}
      {verified && <p role="status" className="text-sm font-medium text-emerald-700">Email verified. You can now sign this agreement.</p>}
      {(sendCode.error || verifyCode.error) && <p role="alert" className="text-sm text-destructive">{sendCode.error?.message || verifyCode.error?.message}</p>}
    </section>
    <div className="space-y-2"><Label>Your signature</Label><SignatureField fieldId="sales-customer" allowUpload disabled={busy} value={signature} onChange={setSignature} /></div>
    <label className="flex items-start gap-3 rounded-lg bg-muted/30 p-4 text-sm"><Checkbox disabled={busy} checked={form.agreement} onCheckedChange={value => patch("agreement", value === true)} /><span>I have read the complete agreement, including the quoted items, prices, billing schedule and legal terms. I am authorised to sign for the customer and consent to using my electronic signature to accept this agreement.</span></label>
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="button" disabled={busy || !verified || !verificationProof || !form.name.trim() || !form.role.trim() || !form.agreement || !signaturePayload(signature)} onClick={() => { if (Date.now() < proofExpiresAt) onSubmit({ ...form, consent: true, signature: signaturePayload(signature), verificationProof }); else { setVerified(false); setVerificationProof(""); } }}>{pending ? "Recording agreement…" : "Sign and accept agreement"}</Button></div>
  </CardContent></Card>;
}

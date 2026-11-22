import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function HistoryEvidenceForm({ data, disabled, onAction }) {
  const [source, setSource] = useState("");
  const [historyKind, setHistoryKind] = useState("");
  const [date, setDate] = useState("");
  const [reference, setReference] = useState("");
  const membership = data.evidence.membershipRows === 0;
  const login = data.evidence.activity?.portal_login?.source === "member_lifecycle_login_evidence";
  if (!membership && !login) return null;
  const submit = async event => {
    event.preventDefault();
    if (disabled || !reference.trim() || !["membership", "portal_login"].includes(source)
      || (source === "membership" && (!membership || !["never", "former"].includes(historyKind) || (historyKind === "former" && !date)))
      || (source === "portal_login" && !login)) return;
    const result = await onAction("record_evidence", {
      action: "record_evidence", memberId: data.memberId, expectedRevision: data.revision,
      source, reference: reference.trim(), ...(source === "membership" ? { historyKind, graceEndDate: historyKind === "former" ? date : null } : { lastOccurredAt: date || null }),
    });
    if (result) { setSource(""); setHistoryKind(""); setReference(""); setDate(""); }
  };
  return <details className="border-t pt-4">
    <summary className="cursor-pointer font-semibold">Document verified historical evidence</summary>
    <p className="mt-2 text-sm">Use documented review of reliable records, not assumptions. No membership rows is not proof that someone was never a member. This does not override existing memberships, financial blockers or failed source queries.</p>
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="ml-field"><span>Evidence source</span><select className="ml-select" required disabled={disabled} value={source} onChange={e => { setSource(e.target.value); setHistoryKind(""); setDate(""); }}>
        <option value="">Choose source</option>
        {membership && <option value="membership">Membership history absent from the system</option>}
        {login && <option value="portal_login">Historical member portal login coverage</option>}
      </select></label>
      {source === "membership" && <label className="ml-field"><span>Verified membership history</span><select className="ml-select" required disabled={disabled} value={historyKind} onChange={e => { setHistoryKind(e.target.value); setDate(""); }}>
        <option value="">Choose documented history</option>
        <option value="never">Verified never a member</option><option value="former">Verified former member</option>
      </select></label>}
      {source && (source === "portal_login" || historyKind === "former") && <label className="ml-field">
        <span>{source === "portal_login" ? "Last verified portal login date, if known" : "Verified membership grace end date"}</span>
        <Input type="date" value={date} disabled={disabled} required={source === "membership"} onChange={e => setDate(e.target.value)} />
      </label>}
      {source === "portal_login" && <p className="ml-muted text-sm">A blank login date records no known occurrence after documented review. It does not prove there were no logins, supply an inactivity date or make this member eligible for disposal.</p>}
      <label className="ml-field"><span>Evidence reference and documented review explanation</span><Textarea required maxLength={2000} value={reference} disabled={disabled} onChange={e => setReference(e.target.value)} /></label>
      <Button type="submit" disabled={disabled || !source || !reference.trim() || (source === "membership" && (!historyKind || (historyKind === "former" && !date)))}>Record verified evidence</Button>
    </form>
  </details>;
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function HistoryEvidenceForm({ data, disabled, onAction }) {
  const [source, setSource] = useState("");
  const [historyKind, setHistoryKind] = useState("never");
  const [date, setDate] = useState("");
  const [reference, setReference] = useState("");
  const membership = data.evidence.membershipRows === 0;
  const login = data.evidence.activity?.portal_login?.source === "member_lifecycle_login_evidence";
  if (!membership && !login) return null;
  const submit = async event => {
    event.preventDefault();
    const result = await onAction("record_evidence", {
      action: "record_evidence", memberId: data.memberId, expectedRevision: data.revision,
      source, reference, ...(source === "membership" ? { historyKind, graceEndDate: date || null } : { lastOccurredAt: date || null }),
    });
    if (result) { setSource(""); setReference(""); setDate(""); }
  };
  return <details className="border-t pt-4">
    <summary className="cursor-pointer font-semibold">Document verified historical evidence</summary>
    <p className="mt-2 text-sm">Use reviewed records, not assumptions. This does not override existing memberships, financial blockers or failed source queries. A blank login date means no known occurrence; it does not invent an inactivity date.</p>
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="ml-field"><span>Evidence source</span><select className="ml-select" required disabled={disabled} value={source} onChange={e => { setSource(e.target.value); setDate(""); }}>
        <option value="">Choose source</option>
        {membership && <option value="membership">Membership history absent from the system</option>}
        {login && <option value="portal_login">Historical member portal login coverage</option>}
      </select></label>
      {source === "membership" && <label className="ml-field"><span>Verified membership history</span><select className="ml-select" disabled={disabled} value={historyKind} onChange={e => setHistoryKind(e.target.value)}>
        <option value="never">Verified never a member</option><option value="former">Verified former member</option>
      </select></label>}
      {source && (source === "portal_login" || historyKind === "former") && <label className="ml-field">
        <span>{source === "portal_login" ? "Last verified portal login date, if known" : "Verified membership grace end date"}</span>
        <Input type="date" value={date} disabled={disabled} required={source === "membership"} onChange={e => setDate(e.target.value)} />
      </label>}
      <label className="ml-field"><span>Evidence reference and review explanation</span><Textarea required maxLength={2000} value={reference} disabled={disabled} onChange={e => setReference(e.target.value)} /></label>
      <Button type="submit" disabled={disabled || !source || !reference.trim()}>Record verified evidence</Button>
    </form>
  </details>;
}

import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function words(value) {
  return String(value ?? "Not recorded").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
}

export function Notice({ title, children, tone = "info" }) {
  return <div className="ml-notice" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
    <div className="flex items-start gap-2">
      {tone === "error" || tone === "warning" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0">{title && <p className="font-semibold">{title}</p>}{children}</div>
    </div>
  </div>;
}

export function Panel({ step, title, description, children, className = "" }) {
  return <section className={`ml-panel ${className}`}>
    <div className="ml-panel-heading">
      {step && <p className="ml-step mb-1">{step}</p>}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="ml-muted mt-1 text-sm">{description}</p>}
    </div>
    {children}
  </section>;
}

export function Loading({ label = "Loading authoritative records…" }) {
  return <div role="status" aria-label={label} className="space-y-3 p-6">
    <p className="ml-muted text-sm">{label}</p>
    <Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-5/6" />
  </div>;
}

export function ErrorRetry({ message, onRetry, disabled }) {
  return <div className="space-y-3 p-4"><Notice tone="error" title="Unable to verify records">{message}</Notice>
    <Button variant="outline" onClick={onRetry} disabled={disabled}>Retry loading</Button></div>;
}

export function EvidenceValue({ value }) {
  if (value == null) return <span className="ml-muted">Not recorded</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (Array.isArray(value)) return value.length
    ? <ul className="space-y-2">{value.map((item, index) => <li key={index}><EvidenceValue value={item} /></li>)}</ul>
    : <span className="ml-muted">None reported</span>;
  if (typeof value === "object") return <dl className="ml-evidence">{Object.entries(value).map(([key, item]) =>
    <div key={key}><dt>{words(key)}</dt><dd><EvidenceValue value={item} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

export function RecordTable({ items, preview = false, roles = [], onSelect, disabled }) {
  return <div className="ml-table-wrap"><table className="ml-table">
    <caption className="sr-only">{preview ? "Versioned impact preview proposals" : "Member archive review queue"}</caption>
    <thead><tr><th scope="col">Member ID</th><th scope="col">{preview ? "Proposed action" : "State & protection"}</th><th scope="col">Reason</th><th scope="col">Relevant dates</th><th scope="col"><span className="sr-only">Review evidence</span></th></tr></thead>
    <tbody>{items.map((item, index) => <tr key={`${item.memberId}-${index}`}>
      <td><span className="ml-code">{item.memberId}</span></td>
      <td><span className="font-medium">{words(preview ? item.action : item.state)}</span>
        {item.hold && <p className="mt-1 text-xs">Durable hold</p>}
        {item.exempt && <p className="mt-1 text-xs">Exempt from automation</p>}
        {preview && item.targetRoleId && <p className="mt-1 text-xs">Destination: {roles.find(role => role.id === item.targetRoleId)?.name || `Unavailable role (${item.targetRoleId})`}</p>}
      </td>
      <td className="min-w-[180px]">{words(item.reason)}
        {Array.isArray(item.unavailableSources) && item.unavailableSources.length > 0 && <div className="mt-2 text-xs"><p className="font-semibold">Unavailable evidence sources</p><EvidenceValue value={item.unavailableSources} /></div>}
      </td>
      <td className="min-w-[170px]"><p>Eligible: {item.eligibleOn || "Not established"}</p>
        {preview && <p className="ml-muted mt-1">Last activity: {item.lastActivityOn || "Not established"}</p>}
        {!preview && item.reviewAfter && <p className="ml-muted mt-1">Review after: {item.reviewAfter}</p>}
      </td>
      <td><Button variant="outline" size="sm" disabled={disabled} onClick={() => onSelect(item.memberId)}>Review<span className="sr-only"> member {item.memberId}</span></Button></td>
    </tr>)}</tbody>
  </table></div>;
}

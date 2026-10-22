import { INVOICING_CORE_FIELDS } from "@/lib/invoicingAddressFields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InvoicingAddressStatus({ address }) {
  if (address.error) return (
    <div role="alert" className="text-sm text-red-700">
      Invoicing address: {address.error}{" "}
      {address.saveError ? "Your changes are retained. Retry Save to finish." : (
        <button type="button" className="underline" onClick={() => address.retry()}>Retry loading</button>
      )}
    </div>
  );
  return address.loading ? <p role="status" className="text-sm text-slate-500">Loading invoicing address…</p> : null;
}

export default function InvoicingAddressField({ address, fieldKey, isEditing, isLocked = false, prefix = "" }) {
  const field = INVOICING_CORE_FIELDS.find(field => field.fieldKey === fieldKey);
  return (
    <div className="space-y-2">
      <Label className="text-slate-500">{field.label}</Label>
      {isEditing ? (
        <Input value={address.values[fieldKey]} maxLength={field.maxLength}
          disabled={isLocked || !address.ready || address.saving}
          onChange={event => address.setValue(fieldKey, event.target.value)}
          data-testid={`input-${prefix}${fieldKey}`} />
      ) : (
        <p className="text-sm">{address.loading ? "Loading…" : address.error && !address.ready ? "Unavailable" : address.values[fieldKey] || "-"}</p>
      )}
    </div>
  );
}

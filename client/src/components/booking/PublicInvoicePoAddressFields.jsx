import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INVOICING_ADDRESS_FIELDS } from "../../../../shared/invoicingAddress.js";

const OPTIONAL_FIELDS = new Set(["invoicing_address_line2", "invoicing_region"]);

export default function PublicInvoicePoAddressFields({ value, onChange }) {
  return <fieldset className="space-y-3 rounded-lg border border-indigo-200 bg-white p-4" aria-describedby="public-invoice-address-help">
    <legend className="px-1 text-sm font-medium">Invoice address</legend>
    <p id="public-invoice-address-help" className="text-xs text-slate-500">
      The invoice is billed to the purchaser’s organisation and emailed to the booker.
      This address is used only for the invoice; it does not create or update organisation records.
    </p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {INVOICING_ADDRESS_FIELDS.map(({ key, label, maxLength }) => {
        const required = !OPTIONAL_FIELDS.has(key);
        const id = `public-invoice-${key}`;
        return <div key={key} className="space-y-1">
          <Label htmlFor={id}>{label}{required ? " *" : " (optional)"}</Label>
          <Input id={id} value={value[key] || ""} maxLength={maxLength} required={required}
            aria-describedby="public-invoice-address-help"
            onChange={event => onChange({ [key]: event.target.value })} />
        </div>;
      })}
    </div>
  </fieldset>;
}

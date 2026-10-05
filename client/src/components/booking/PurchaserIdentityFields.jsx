import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function PurchaserIdentityFields({ value, onChange }) {
  return <div className="space-y-3 rounded-lg border border-slate-200 p-4" data-testid="member-purchaser-details">
    <p className="text-sm font-medium">Purchaser details</p>
    <p className="text-xs text-slate-500">Tell us who is making this purchase, even if they are not attending. Each attendee must supply their own organisation.</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {["first_name", "last_name", "email", "organization"].map(field => <div key={field} className="space-y-1">
        <Label htmlFor={`member-purchaser-${field}`}>{({ first_name: "First name", last_name: "Last name", email: "Email address", organization: "Organisation" })[field]} *</Label>
        <Input id={`member-purchaser-${field}`} type={field === "email" ? "email" : "text"} value={value[field] || ""}
          onChange={event => onChange({ ...value, [field]: event.target.value })} required />
      </div>)}
    </div>
  </div>;
}

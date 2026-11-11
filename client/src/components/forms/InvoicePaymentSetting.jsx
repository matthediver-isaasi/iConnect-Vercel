import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const INVOICE_PAYMENT_HELP = 'Confirms the order immediately. Payment remains outstanding until the invoice is paid.';

export function invoiceBillingConfigurationError(field, allFields) {
  if (!field.payment_providers?.includes('invoice')) return null;
  if (!allFields.some(f => f.id === field.invoice_billing_name_field_id && f.type === 'text')) {
    return 'Pay by invoice needs a Billing name field (Text).';
  }
  if (!allFields.some(f => f.id === field.invoice_billing_email_field_id && f.type === 'email')) {
    return 'Pay by invoice needs a Billing email field (Email).';
  }
  return null;
}

export default function InvoicePaymentSetting({ field, provider, allFields = [], onChange, onCheckedChange }) {
  if (field.type !== 'payment' || !provider) return null;
  const id = `payment-provider-invoice-${field.id}`;
  return (
    <div className="space-y-3">
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={Array.isArray(field.payment_providers) && field.payment_providers.includes('invoice')}
        disabled={!provider.configured}
        onCheckedChange={checked => onCheckedChange(checked === true)}
        aria-describedby={`${id}-help`}
        data-testid={`checkbox-payment-provider-invoice-${field.id}`}
      />
      <div>
        <Label htmlFor={id} className={`text-xs ${!provider.configured ? 'text-slate-400' : ''}`}>Pay by invoice</Label>
        <p id={`${id}-help`} className="text-xs text-slate-500">{INVOICE_PAYMENT_HELP}</p>
        {!provider.configured && <p className="text-xs text-slate-400">Invoice checkout requires Xero and the invoice-order setup to be enabled.</p>}
      </div>
    </div>
    {field.payment_providers?.includes('invoice') && (
      <div className="space-y-3 pl-6">
        <p className="text-xs text-slate-500">Choose the fields that identify the invoice recipient. Both are required.</p>
        {[
          { key: 'invoice_billing_name_field_id', label: 'Billing name field', type: 'text' },
          { key: 'invoice_billing_email_field_id', label: 'Billing email field', type: 'email' },
        ].map(({ key, label, type }) => {
          const choices = allFields.filter(f => f.type === type && f.id !== field.id);
          const valid = choices.some(f => f.id === field[key]);
          return (
            <div className="space-y-1" key={key}>
              <Label htmlFor={`${id}-${key}`} className="text-xs">{label} <span className="text-destructive">*</span></Label>
              <Select value={valid ? field[key] : ''} onValueChange={value => onChange({ [key]: value })} required>
                <SelectTrigger id={`${id}-${key}`} className="h-8" data-testid={`${key}-${field.id}`} aria-required="true">
                  <SelectValue placeholder={`Choose a ${type === 'text' ? 'Text' : 'Email'} field…`} />
                </SelectTrigger>
                <SelectContent>
                  {choices.map(f => <SelectItem key={f.id} value={f.id}>{f.label || f.name || f.id}</SelectItem>)}
                </SelectContent>
              </Select>
              {!choices.length && <p className="text-xs text-slate-500">Add a {type === 'text' ? 'Text' : 'Email'} field to the form first.</p>}
              {field[key] && !valid && <p className="text-xs text-destructive">The saved field is unavailable. Choose another field.</p>}
            </div>
          );
        })}
        <div className="space-y-1">
          <Label htmlFor={`${id}-address`} className="text-xs">Invoice address field (optional)</Label>
          <Select value={field.invoice_address_field_id || '_none'} onValueChange={value => onChange({ invoice_address_field_id: value === '_none' ? null : value })}>
            <SelectTrigger id={`${id}-address`} className="h-8" data-testid={`select-invoice-address-field-${field.id}`}>
              <SelectValue placeholder="No address field" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">No address field</SelectItem>
              {allFields.filter(f => f.id !== field.id && ['text', 'textarea'].includes(f.type)).map(f => (
                <SelectItem key={f.id} value={f.id}>{f.label || f.name || f.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    )}
    </div>
  );
}

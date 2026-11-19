import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { INVOICING_ADDRESS_FIELDS } from "../../../../shared/invoicingAddress.js";
import { invoiceAddressFieldTypes, REQUIRED_INVOICE_ADDRESS_KEYS } from "../../../../shared/formInvoiceBilling.js";
export { invoiceBillingConfigurationError } from "../../../../shared/formInvoiceBilling.js";

export const INVOICE_PAYMENT_HELP = 'Confirms the order immediately. Payment remains outstanding until the invoice is paid.';

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
        <Label className="text-xs" htmlFor={`${id}-source`}>Invoice details source</Label>
        <Select value={field.invoice_billing_source || 'fields'} onValueChange={value => value && onChange({ invoice_billing_source: value })}>
          <SelectTrigger id={`${id}-source`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="organization">Use organisation invoice details</SelectItem>
            <SelectItem value="fields">Map individual form fields</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-slate-500">The selected address is saved with the order and applied to the Xero contact’s postal address before invoicing. This does not edit the organisation account or the Xero contact’s email.</p>
        {field.invoice_billing_source === 'organization' ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Uses the selected organisation’s saved name, invoicing email and individual invoice address fields. No separate billing questions are required. Missing account details are reported at checkout.</p>
            <Label htmlFor={`${id}-organisation`} className="text-xs">Organisation source</Label>
            <Select value={field.invoice_organization_field_id || '_none'} onValueChange={value => value && onChange({ invoice_organization_field_id: value === '_none' ? null : value })}>
              <SelectTrigger id={`${id}-organisation`}><SelectValue placeholder="Choose an Organisation Drop Down" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">Choose an Organisation Drop Down</SelectItem>
                {allFields.filter(f => f.type === 'organisation_dropdown').map(f => <SelectItem key={f.id} value={f.id}>{f.label || f.id}</SelectItem>)}
              </SelectContent>
            </Select>
            {!allFields.some(f => f.type === 'organisation_dropdown') && <p className="text-xs text-destructive">Add an Organisation Drop Down to this form first.</p>}
          </div>
        ) : <>
        <p className="text-xs text-slate-500">Choose the fields that identify the invoice recipient. Both are required.</p>
        <p className="text-xs text-slate-500">An Organisation Drop Down uses the selected organisation’s unique Xero name match, ignoring case and whitespace. Its Xero contact is saved with the order; the purchaser’s email is not used to match or update that contact. Missing or ambiguous matches block checkout.</p>
        {[
          { key: 'invoice_billing_name_field_id', label: 'Billing name field', type: 'text' },
          { key: 'invoice_billing_email_field_id', label: 'Billing email field', type: 'email' },
        ].map(({ key, label, type }) => {
          const choices = allFields.filter(f => (f.type === type || (type === 'text' && f.type === 'organisation_dropdown')) && f.id !== field.id);
          const valid = choices.some(f => f.id === field[key]);
          return (
            <div className="space-y-1" key={key}>
              <Label htmlFor={`${id}-${key}`} className="text-xs">{label} <span className="text-destructive">*</span></Label>
              <Select value={valid ? field[key] : ''} onValueChange={value => onChange({ [key]: value })} required>
                <SelectTrigger id={`${id}-${key}`} className="h-8" data-testid={`${key}-${field.id}`} aria-required="true">
                  <SelectValue placeholder={`Choose a ${type === 'text' ? 'Text or Organisation Drop Down' : 'Email'} field…`} />
                </SelectTrigger>
                <SelectContent>
                  {choices.map(f => <SelectItem key={f.id} value={f.id}>{f.label || f.name || f.id}</SelectItem>)}
                </SelectContent>
              </Select>
              {!choices.length && <p className="text-xs text-slate-500">Add a {type === 'text' ? 'Text or Organisation Drop Down' : 'Email'} field to the form first.</p>}
              {field[key] && !valid && <p className="text-xs text-destructive">The saved field is unavailable. Choose another field.</p>}
            </div>
          );
        })}
        <p className="text-xs text-slate-500">Map individual address components. These correspond to Xero and QuickBooks address fields.</p>
        {INVOICING_ADDRESS_FIELDS.map(({ key, label }) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`${id}-${key}`} className="text-xs">{label}{REQUIRED_INVOICE_ADDRESS_KEYS.includes(key) ? ' *' : ' (optional)'}</Label>
            <Select value={field.invoice_address_fields?.[key] || '_none'} onValueChange={value => value && onChange({
              invoice_billing_source: 'fields',
              invoice_address_fields: { ...field.invoice_address_fields, [key]: value === '_none' ? null : value },
            })}>
              <SelectTrigger id={`${id}-${key}`} className="h-8"><SelectValue placeholder="Choose a form field" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">Not mapped</SelectItem>
                {allFields.filter(f => f.id !== field.id && invoiceAddressFieldTypes(key).includes(f.type)).map(f => (
                  <SelectItem key={f.id} value={f.id}>{f.label || f.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
        {!field.invoice_billing_source && field.invoice_address_field_id && <p className="text-xs text-amber-700">This saved configuration uses a legacy combined address. Select a source and map the individual fields to replace it.</p>}
        </>}
      </div>
    )}
    </div>
  );
}

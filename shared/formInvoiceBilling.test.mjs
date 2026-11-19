import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceBillingConfigurationError, mappedInvoiceAddress, structuredInvoiceAddress } from './formInvoiceBilling.js';
import { invoicingAddressToXero, invoicingAddressToQuickBooks } from './invoicingAddress.js';
const address = { invoicing_address_line1:'1 Example Road', invoicing_address_line2:'Suite 2',
  invoicing_city:'York', invoicing_region:'Yorkshire', invoicing_postal_code:'YO1 1AA', invoicing_country:'United Kingdom' };
test('organisation source needs only its dropdown, ignoring stale mapped-field settings', () => {
  const field = { payment_providers:['invoice'], invoice_billing_source:'organization', invoice_organization_field_id:'org',
    invoice_billing_name_field_id:'deleted', invoice_billing_email_field_id:'deleted' };
  assert.equal(invoiceBillingConfigurationError(field,[{id:'org',type:'organisation_dropdown'}]),null);
  assert.match(invoiceBillingConfigurationError(field,[{id:'org',type:'text'}]),/Organisation Drop Down/);
});
test('mapped source validates individual fields and never uses retired combined text', () => {
  const fields = [{id:'name',type:'text'},{id:'email',type:'email'}, ...Object.keys(address).map(id=>({id,type:id==='invoicing_country'?'country':'text'}))];
  const config = { payment_providers:['invoice'], invoice_billing_source:'fields',
    invoice_billing_name_field_id:'name',invoice_billing_email_field_id:'email',
    invoice_address_field_id:'legacy', invoice_address_fields:Object.fromEntries(Object.keys(address).map(k=>[k,k])) };
  assert.equal(invoiceBillingConfigurationError(config,fields),null);
  const resolved=mappedInvoiceAddress(config,fields,{...address,legacy:'Ignored address'});
  assert.deepEqual(resolved.address,address);
  assert.deepEqual(invoicingAddressToXero(resolved),{AddressType:'POBOX',AddressLine1:address.invoicing_address_line1,
    AddressLine2:'Suite 2',City:'York',Region:'Yorkshire',PostalCode:'YO1 1AA',Country:'United Kingdom'});
  assert.equal(invoicingAddressToQuickBooks(resolved).CountrySubDivisionCode,'Yorkshire');
  assert.match(invoiceBillingConfigurationError({...config,invoice_address_fields:{}},fields),/address line 1/);
  assert.throws(()=>mappedInvoiceAddress(config,fields,{...address,invoicing_city:{forged:true}}),/text/);
});
test('organisation details cannot fall back to legacy or partially merge addresses', () => {
  assert.throws(()=>structuredInvoiceAddress({invoicing_address:'Legacy only'}),/line 1.*required/);
  assert.throws(()=>structuredInvoiceAddress({...address,invoicing_postal_code:''}),/postcode.*required/);
  assert.throws(()=>structuredInvoiceAddress({...address,invoicing_address_line1:'one\\ntwo'.replace('\\n','\n')}),/single line/);
  assert.deepEqual(structuredInvoiceAddress({...address,invoicing_region:null}).address.invoicing_region,'');
});

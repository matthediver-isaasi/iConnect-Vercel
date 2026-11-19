import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrganizationInvoiceBilling } from './formInvoiceOrganization.js';
import { prepareFormInvoiceSource } from './formInvoiceOrder.js';
const address = { invoicing_address_line1:'1 Road',invoicing_address_line2:'Suite 2',invoicing_city:'York',
  invoicing_region:'Yorkshire',invoicing_postal_code:'YO1 1AA',invoicing_country:'United Kingdom' };
test('organisation billing reads only the selected tenant-owned private address', async () => {
  const filters = {};
  const db={from(table){ assert.equal(table,'invoicing_address_private');return {
    select(){return this;},eq(key,value){filters[key]=value;return this;},
    async maybeSingle(){return {data:address,error:null};},
  };}};
  const billing=await readOrganizationInvoiceBilling(db,'tenant',{id:'org',name:'Company',invoicing_email:'billing@example.invalid'});
  assert.deepEqual(filters,{tenant_id:'tenant',owner_type:'organization',owner_id:'org'});
  assert.deepEqual(billing.address,{source:'structured',address});
  assert.equal(billing.email,'billing@example.invalid');
  await assert.rejects(readOrganizationInvoiceBilling(db,'tenant',{id:'org',name:'Company'}),/invoicing email/);
});
test('frozen structured address reaches Xero by component, with verified readback and no email mutation', async () => {
  const contactId='837cb871-b1ae-472a-8381-bbaaf8efe919';
  const row={tenant_id:'tenant',company_id:'company',connection_id:'connection',provider:'xero',source_type:'form_invoice_order',source_id:'source',
    snapshot:{version:1,preparation:true,payment:null,linkage:{formId:'form'},
      organizationCustomer:{version:1,organizationId:'org',companyId:'company',connectionId:'connection',contactId},
      billingDetails:{name:'Company',email:'billing@example.invalid',address:{source:'structured',address}},
      lines:[{description:'Item',quantity:1,netMinor:10000,taxMinor:2000,grossMinor:12000,accountCode:'210',taxCode:'OUTPUT2'}],
      invoice:{args:{appTenantId:'tenant',organizationName:'Company',currency:'GBP'},settings:{},totalMinor:12000,invoiceDate:'2026-11-19',dueDate:'2026-12-19'}}};
  const before=structuredClone(row);
  const writes=[];
  let corrupt=false;
  const transport={fetch:async(url,init)=>{
    if(init.method==='POST') {
      const payload=JSON.parse(init.body);writes.push(payload);
      const c=payload.Contacts[0];assert.equal(Object.hasOwn(c,'EmailAddress'),false);
      if(corrupt)c.Addresses[0].PostalCode='wrong';
      return Response.json({Contacts:[c]});
    }
    return Response.json({Contacts:[{ContactID:contactId,ContactStatus:'ACTIVE'}]});
  }};
  const dependencies={prepare:async(args,options)=>{
    const id=await options.findOrCreateXeroContact('fixture','company');
    return {companyId:'company',contactId:id,payload:{Type:'ACCREC',Status:'AUTHORISED',Contact:{ContactID:id},LineItems:[{UnitAmount:120}]}};
  }};
  const result=await prepareFormInvoiceSource({row,transport},dependencies);
  assert.equal(writes[0].Contacts[0].Addresses[0].City,'York');
  assert.equal(writes[0].Contacts[0].Addresses[0].PostalCode,'YO1 1AA');
  assert.equal(result.invoice.envelope.payload.Contact.Addresses[0].Region,'Yorkshire');
  assert.deepEqual(row,before);
  corrupt=true;
  await assert.rejects(prepareFormInvoiceSource({row,transport},dependencies),/could not be verified/);
});

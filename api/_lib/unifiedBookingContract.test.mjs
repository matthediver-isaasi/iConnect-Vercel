import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUnifiedBookingContract, unifiedBookingChoices, unifiedBookingReady, createUnifiedBookingPayment, unifiedBookingKey, freezeUnifiedInvoice } from './unifiedBookingContract.js';
import { recoverUnifiedBookingInvoices } from './unifiedBookingRecovery.js';
import { resolveStoredInvoicingAddress } from '../../shared/invoicingAddress.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const eventId = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const address = { invoicing_address_line1: '1 Invoice Road', invoicing_city: 'London',
  invoicing_postal_code: 'SW1A 1AA', invoicing_country: 'United Kingdom' };
function fixture() {
  const rows = {
    member: [{ id: 'member', tenant_id: tenant, email: 'member@example.invalid', first_name: 'Member', last_name: 'Booker',
      organization_id: 'org', organization_group_id: 'group' }],
    organization: [{ id: 'org', tenant_id: tenant, name: 'Employer', invoicing_email: 'finance@example.invalid', organization_group_id: 'group' }],
    organization_group: [{ id: 'group', tenant_id: tenant, name: 'Trust', invoicing_email: 'trust@example.invalid' }],
    event: [{ id: eventId, tenant_id: tenant, title: 'Event', pricing_config: { ticket_classes: [{ id: 'ticket', visibility_mode: 'members_and_public' }] } }],
    invoicing_address_private: [],
    system_settings: [{ tenant_id: tenant, setting_key: 'xero_invoice_enabled', setting_value: 'true' }],
    tenant_accounting_settings: [{ tenant_id: tenant, active_provider: 'xero' }],
    xero_token: [{ app_tenant_id: tenant, id: 'connection', tenant_id: 'company' }],
    unified_booking_contract: [],
  };
  const calls = [];
  const db = {
    rows, calls,
    from(table) {
      const filters = [];
      let single = false;
      let start = 0, end = Infinity;
      const query = {
        select() { calls.push(table); return this; }, eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return this; },
        order() { return this; }, range(from,to) { start=from;end=to;return this; },
        filter(key, operator, value) {
          assert.equal(operator, 'imatch'); const regex = new RegExp(value.replaceAll('[[:space:]]', '\\s'), 'i');
          filters.push(row => regex.test(row[key])); return this;
        },
        maybeSingle() { single = true; return this; }, limit() { return this; },
        then(resolve, reject) {
          const result = (rows[table] || []).filter(row => filters.every(fn => fn(row))).slice(start,end+1);
          return Promise.resolve({ data: single ? result[0] || null : result, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      if (name === 'unified_booking_readiness') return { data: { version: 2, enabled: true } };
      if (name === 'unified_booking_prepare') {
        const row = { id: args.p_id, tenant_id: args.p_tenant, source: args.p_source, event_id: args.p_event,
          member_id: args.p_member, snapshot: structuredClone(args.p_snapshot) };
        rows.unified_booking_contract.push(row);
        return { data: row };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return db;
}
const input = db => ({ db, tenantId: tenant, source: 'booking', eventId, requestId: id, ticketIds: ['ticket'] });
test('readiness requires explicit matching version and enabled flag', async () => {
  for (const data of [null, { version: 1, enabled: true }, { version: 2, enabled: false }]) {
    assert.equal(await unifiedBookingReady({ rpc: async () => ({ data }) }), false);
  }
  assert.equal(await unifiedBookingReady({ rpc: async () => ({ error: { code: 'PGRST202' } }) }), false);
  await assert.rejects(unifiedBookingReady({ rpc: async () => ({ error: { code: 'offline' } }) }), /readiness/);
});
test('member choices always contain self and deduplicate direct/organisation-linked trusts', async () => {
  const db = fixture();
  const result = await unifiedBookingChoices(db, tenant, 'member');
  assert.deepEqual(result.choices.map(c => c.kind), ['member', 'organization', 'organization_group']);
  assert.equal(result.choices[0].id, 'member');
});
for (const kind of ['member', 'organization', 'organization_group']) {
  test(`server freezes selected ${kind} customer independently of individual email`, async () => {
    const db = fixture();
    const selection = { kind, id: { member: 'member', organization: 'org', organization_group: 'group' }[kind], address };
    const contract = await prepareUnifiedBookingContract({ ...input(db), memberId: 'member', selection });
    assert.equal(contract.snapshot.contact.provenance.kind, kind);
    assert.equal(contract.snapshot.booker.email, 'member@example.invalid');
    if (kind !== 'member') assert.notEqual(contract.snapshot.contact.email, contract.snapshot.booker.email);
    assert.equal(contract.snapshot.accounting.provider.xeroTenantId, 'company');
    db.rows.member[0].organization_id = 'changed';
    db.rows.organization = [];
    db.rows.tenant_accounting_settings[0].active_provider = 'quickbooks';
    const before = db.calls.length;
    const replay = await prepareUnifiedBookingContract({ ...input(db), memberId: 'member', selection });
    assert.deepEqual(replay, contract);
    assert.deepEqual(db.calls.slice(before), ['unified_booking_contract'], 'retry must not adopt current relationships or settings');
    await assert.rejects(prepareUnifiedBookingContract({ ...input(db), memberId: 'member', selection: { ...selection, address: { ...address, invoicing_city: 'Changed' } } }), /instructions changed/);
  });
}
test('forged selections and cross-tenant members are rejected, never replaced by self', async () => {
  const db = fixture();
  await assert.rejects(prepareUnifiedBookingContract({ ...input(db), memberId: 'member', selection: { kind: 'organization', id: 'forged' } }), /not linked/);
  await assert.rejects(unifiedBookingChoices(db, 'another-tenant', 'member'), /purchasing member/);
  assert.equal(db.rows.unified_booking_contract.length, 0);
});
test('secondary organisation choices require the configured active assignment graph', async () => {
  const db=fixture();
  db.rows.profile_affiliation_policy=[{tenant_id:tenant,config:{secondaryMemberDefinitionId:'md',secondaryOrganizationDefinitionId:'od'}}];
  db.rows.custom_object_relationship_definition=[
    {id:'md',tenant_id:tenant,status:'active',source_kind:'member',target_kind:'custom_object',target_custom_object_id:'assignments'},
    {id:'od',tenant_id:tenant,status:'active',source_kind:'custom_object',source_custom_object_id:'assignments',target_kind:'organization'},
  ];
  db.rows.custom_object_record=[{id:'assignment',tenant_id:tenant,custom_object_id:'assignments'}];
  db.rows.custom_object_relationship=[
    {id:'m-link',tenant_id:tenant,relationship_definition_id:'md',source_record_id:'member',target_record_id:'assignment'},
    {id:'o-link',tenant_id:tenant,relationship_definition_id:'od',source_record_id:'assignment',target_record_id:'secondary-org'},
    {id:'unrelated',tenant_id:tenant,relationship_definition_id:'unrelated',source_record_id:'member',target_record_id:'forged'},
  ];
  db.rows.organization.push({id:'secondary-org',tenant_id:tenant,name:'Verified secondary organisation'});
  let result=await unifiedBookingChoices(db,tenant,'member');
  assert.equal(result.incomplete,false);
  assert.ok(result.choices.some(c=>c.id==='secondary-org'));
  db.rows.custom_object_record[0].archived_at='2026-01-01';
  result=await unifiedBookingChoices(db,tenant,'member');
  assert.ok(!result.choices.some(c=>c.id==='secondary-org'));
  assert.equal(result.choices[0].kind,'member');
});
test('guest company is optional reference text; never a customer or an organisation record', async () => {
  for (const organization of ['', 'Descriptive employer']) {
    const db = fixture();
    const contract = await prepareUnifiedBookingContract({ ...input(db), purchaser: {
      first_name: 'Guest', last_name: 'Booker', email: 'guest@example.invalid', organization,
    }, selection: { kind: 'guest', address } });
    assert.equal(contract.snapshot.contact.name, 'Guest Booker');
    assert.equal(contract.snapshot.contact.isOrganization, false);
    assert.equal(contract.snapshot.contact.organizationReference, organization || null);
    assert.equal(db.rows.organization.length, 1);
    assert.equal(contract.member_id, null);
  }
});
test('an unauthenticated existing-member email never becomes member authority', async () => {
  const db = fixture();
  await assert.rejects(prepareUnifiedBookingContract({ ...input(db), purchaser: {
    first_name: 'Unverified', last_name: 'Booker', email: 'member@example.invalid',
  }, selection: { kind: 'guest', address } }), /sign in/);
  assert.equal(db.rows.unified_booking_contract.length, 0);
});
test('payment timeout reuses original parameters/key and never starts an expired unbound payment', async () => {
  const parameters = { amount: 1200, currency: 'gbp', metadata: { event_id: eventId, tenant_id: tenant } };
  const contract = { id, tenant_id: tenant, event_id: eventId };
  const requests = [];
  let frozen;
  let expired = false;
  const db = { async rpc(name, args) {
    if (name === 'unified_booking_payment_request') {
      frozen ||= args.p_parameters;
      return { data: { payment_parameters: frozen, payment_requested_at: new Date(Date.now() - (expired ? 24 * 3600000 : 0)).toISOString() } };
    }
    assert.equal(name, 'unified_booking_payment_bind'); return { data: null };
  } };
  const stripe = { paymentIntents: { async create(params, options) {
    requests.push({ params, options });
    if (requests.length === 1) throw new Error('lost response');
    return { id: 'pi_original', ...params };
  } } };
  await assert.rejects(createUnifiedBookingPayment({ db, stripe, contract, parameters }), /lost response/);
  const payment = await createUnifiedBookingPayment({ db, stripe, contract, parameters });
  assert.equal(payment.id, 'pi_original');
  assert.deepEqual(requests[0], requests[1]);
  expired = true;
  await assert.rejects(createUnifiedBookingPayment({ db, stripe, contract, parameters }), /requires review/);
  assert.equal(requests.length, 2);
  assert.notEqual(unifiedBookingKey(tenant, 'booking', id), unifiedBookingKey(tenant, 'complex_event_booking', id));
});
for(const provider of ['xero','quickbooks'])for(const source of ['booking','complex_event_booking'])
for(const kind of ['member','organization','group','guest'])for(const method of ['card','public_invoice_po']){
  test(`${provider}/${source}/${kind}/${method} freezes the actual customer and settlement before commit`,async()=>{
    const context=provider==='xero'?{provider:{connectionId:'xero',xeroTenantId:'company'},settings:{xero_sales_account_code:'200',xero_stripe_bank_account_code:'bank'}}
      :{provider:{name:'quickbooks',connectionId:'qbo',realmId:'realm',environment:'sandbox'},
        settings:{quickbooks_event_item_id:'item',quickbooks_event_tax_code_id:'tax',quickbooks_event_stripe_bank_account_id:'bank'}};
    const selectedEntity=['organization','group'].includes(kind);
    const contact={name:selectedEntity?'Selected customer':'Actual Booker',email:selectedEntity?'finance@example.invalid':'person@example.invalid',
      isOrganization:selectedEntity,invoicingAddress:resolveStoredInvoicingAddress(address,selectedEntity?'organization':'member'),
      provenance:{kind,id:kind==='guest'?null:'selected'}};
    const contract={id,tenant_id:tenant,snapshot:{contact,booker:{first_name:'Actual',last_name:'Booker',email:'person@example.invalid'},accounting:context}};
    const paymentIntent={id:'pi_original',status:'succeeded',livemode:true,amount:2000,amount_received:2000,currency:'gbp',
      metadata:{event_id:eventId},latest_charge:{id:'ch_original',livemode:true,status:'succeeded',paid:true,captured:true,
        amount_captured:2000,currency:'gbp',amount_refunded:0,refunded:false,created:1760000000,payment_intent:'pi_original'}};
    const prepared=await freezeUnifiedInvoice({db:fixture(),tenantId:tenant,source,bookingGroupReference:'group',
      event:{id:eventId,tenant_id:tenant,title:'Event'},amount:20,currency:'GBP',paymentMethod:method,
      ...(method==='card'?{paymentIntentId:paymentIntent.id,paymentIntent}:{}),
      buildLines:()=>[{Description:'Original ticket',Quantity:1,UnitAmount:20,AccountCode:'200',TaxType:'NONE',TaxAmount:0,
        _invoiceLineAmountType:'Exclusive',_checkoutTaxPercentage:0}]},contract);
    assert.equal(prepared.provider,provider);
    assert.equal(prepared.status,'pending',JSON.stringify(prepared.snapshot?.reviewReasons));
    assert.equal(prepared.snapshot.bookingContractVersion,2);
    assert.deepEqual(provider==='xero'?prepared.snapshot.contact:prepared.snapshot.invoice.contact,contact);
    const zero=await freezeUnifiedInvoice({amount:0,paymentMethod:'free'},contract);
    assert.equal(zero.status,'not_applicable');
    assert.equal(zero.snapshot,null);
  });
}
for (const provider of ['xero', 'quickbooks']) {
  test(`${provider} outbox handoff retains the original snapshot and lease after uncertainty`, async () => {
    const original = { provider: { connectionId: 'original', xeroTenantId: 'company' }, approvalProvider: { connectionId: 'qbo', realmId: 'realm' } };
    const row = { tenant_id: tenant, source: 'booking', purchase_key: 'group', lease_token: 'fence',
      prepared: { version: 2, provider, snapshot: original } };
    let attempts = 0;
    const finishes = [];
    const db = { async rpc(name, args) {
      if (name === 'unified_booking_provision_due') return { data: [] };
      if (name === 'unified_booking_invoice_claim') return { data: structuredClone(row) };
      assert.equal(name, 'unified_booking_invoice_finish'); finishes.push(args); return { data: true };
    } };
    const capture = async args => {
      attempts++;
      assert.deepEqual(provider === 'xero' ? args.snapshot : args.p_snapshot, original);
      if (attempts === 1) throw new Error('lost capture response');
      return provider === 'xero' ? { status: 'pending' } : { id: 'same-operation' };
    };
    const options = { db, enqueueXero: capture, enqueueQuickBooks: capture };
    assert.equal((await recoverUnifiedBookingInvoices(options)).status, 'retry');
    assert.equal((await recoverUnifiedBookingInvoices(options)).status, 'queued');
    assert.equal(finishes[0].p_success, false);
    assert.equal(finishes[1].p_success, true);
    assert.equal(finishes[0].p_token, row.lease_token);
  });
}
test('failed handoff markers preserve the original company and payment on replay',async()=>{
  const snapshot={version:1,bookingContractVersion:2,approvalProvider:{connectionId:'original',realmId:'original-company'},
    payment:{stripePaymentIntentId:'pi_original'}};
  const claimed={tenant_id:'tenant',source:'booking',purchase_key:'original-group',lease_token:'lease',
    prepared:{version:2,provider:'quickbooks',valid:true,snapshot}};
  const captures=[];
  let finishFails=true;
  const db={rpc:async(name,args)=>{
    if(name==='unified_booking_provision_due')return{error:{message:'optional provisioning unavailable'}};
    if(name==='unified_booking_invoice_claim')return{data:claimed};
    if(name==='accounting_event_capture'){captures.push(args);return{data:{id:'same-durable-provider-operation'}};}
    if(name==='unified_booking_invoice_finish')return finishFails?{error:{message:'marker unavailable'}}:{data:true};
    throw new Error(name);
  }};
  await assert.rejects(()=>recoverUnifiedBookingInvoices({db}),/status unavailable/);
  finishFails=false;
  assert.equal((await recoverUnifiedBookingInvoices({db})).status,'queued');
  assert.equal(captures.length,2);
  assert.deepEqual(captures[0],captures[1]);
  assert.equal(captures[1].p_company,'original-company');
  assert.equal(captures[1].p_snapshot.payment.stripePaymentIntentId,'pi_original');
});
test('optional provisioning failure never blocks original invoice handoff',async()=>{
  const snapshot={provider:{connectionId:'original',xeroTenantId:'company'}};
  const db={async rpc(name,args){
    if(name==='unified_booking_provision_due')throw new Error('unavailable optional provisioning');
    if(name==='unified_booking_invoice_claim')return {data:{tenant_id:tenant,source:'booking',purchase_key:'group',lease_token:'lease',
      prepared:{version:2,provider:'xero',snapshot}}};
    assert.equal(name,'unified_booking_invoice_finish');assert.equal(args.p_success,true);return {data:true};
  }};
  const result=await recoverUnifiedBookingInvoices({db,enqueueXero:async input=>{
    assert.deepEqual(input.snapshot,snapshot);return {status:'pending'};
  }});
  assert.equal(result.status,'queued');
  assert.equal(result.provisioning,'unavailable');
});

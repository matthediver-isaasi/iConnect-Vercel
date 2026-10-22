import { INVOICING_ADDRESS_KEYS, invoicingAddressError, resolveStoredInvoicingAddress, invoicingAddressToXero } from '../../shared/invoicingAddress.js';

const fail = (message, statusCode = 503) => { throw Object.assign(new Error(message), { statusCode }); };
const normalized = value => String(value || '').trim().toLowerCase();

export async function knownEventXeroContact(db, tenantId, member, provider) {
  if (member.xero_contact_id && member.xero_tenant_id && member.xero_tenant_id !== provider.xeroTenantId) {
    fail('Saved Xero customer belongs to a different company');
  }
  const candidates = new Set(member.xero_contact_id ? [member.xero_contact_id] : []);
  const trusted = new Set();
  // These are the existing immutable member/company ownership mappings. Sales
  // customer mappings are organization-only and must never identify this payer.
  for (const table of ['bnms_dd_beta_invoice_link', 'bnms_dd_alpha_invoice_link']) {
    const result = await db.from(table).select('tenant_id,member_id,xero_tenant_id,xero_contact_id,evidence')
      .eq('tenant_id', tenantId).eq('member_id', member.id).eq('xero_tenant_id', provider.xeroTenantId).limit(101);
    if (['42P01', 'PGRST205'].includes(result.error?.code)) continue; // optional pilot provenance not installed
    if (result.error || !Array.isArray(result.data) || result.data.length >= 101) fail('Saved Xero customer mapping could not be verified');
    for (const row of result.data) {
      if (row.tenant_id !== tenantId || row.member_id !== member.id || row.xero_tenant_id !== provider.xeroTenantId
        || !row.xero_contact_id || row.evidence?.contact?.ContactID !== row.xero_contact_id
        || row.evidence?.invoice?.Contact?.ContactID !== row.xero_contact_id) fail('Saved Xero customer mapping is inconsistent');
      candidates.add(row.xero_contact_id);
      trusted.add(row.xero_contact_id);
    }
  }
  if (candidates.size > 1) fail('Saved Xero customer mappings are ambiguous');
  const contactId = [...candidates][0] || null;
  return { contactId, trusted: trusted.has(contactId) };
}

// Exact purchaser identity only. Names are included to detect Xero's unique-name
// collisions, never to silently adopt another person's contact. Exhaust pages.
export async function lookupEventXeroContact(api, { name, email, contactId = null }) {
  if (contactId) {
    const result = await api(`Contacts/${encodeURIComponent(contactId)}`);
    const contacts = result?.Contacts;
    if (!Array.isArray(contacts) || contacts.length !== 1 || contacts[0].ContactID !== contactId
      || contacts[0].ContactStatus !== 'ACTIVE' || contacts[0].HasErrors || contacts[0].ValidationErrors?.length) {
      fail('Existing Xero customer could not be verified');
    }
    return contacts[0];
  }
  if (!name || !email) fail('Verified member name and email are required');
  const where = `EmailAddress.ToLower()==${JSON.stringify(normalized(email))}||Name.ToLower()==${JSON.stringify(normalized(name))}`;
  const found = new Map();
  for (let page = 1; page <= 3; page++) {
    const result = await api(`Contacts?where=${encodeURIComponent(where)}&includeArchived=true&page=${page}&pageSize=100`);
    if (!Array.isArray(result?.Contacts) || result.Contacts.length > 100) fail('Xero customer lookup was incomplete');
    if (!result.Contacts.length) {
      if (found.size > 1) fail('Xero customer identity is ambiguous');
      const contact = [...found.values()][0];
      if (contact && (contact.ContactStatus !== 'ACTIVE' || normalized(contact.EmailAddress) !== normalized(email))) {
        fail('Xero customer identity requires review');
      }
      return contact || null;
    }
    for (const contact of result.Contacts) {
      if (!contact?.ContactID || found.has(contact.ContactID) || contact.HasErrors || contact.ValidationErrors?.length
        || (normalized(contact.EmailAddress) !== normalized(email) && normalized(contact.Name) !== normalized(name))) {
        fail('Xero customer lookup was ambiguous');
      }
      found.set(contact.ContactID, contact);
    }
  }
  fail('Xero customer lookup was incomplete');
}

export async function eventAddressContext({ db, tenantId, memberId, eventId, source, lookup }) {
  if (!['simple', 'complex'].includes(source) || !eventId) fail('Valid event and source are required', 400);
  const event = await db.from(source === 'simple' ? 'event' : 'complex_event')
    .select('id').eq('id', eventId).eq('tenant_id', tenantId).maybeSingle();
  if (event.error) fail('Unable to verify event');
  if (!event.data) fail('Event not found', 404);
  if (!memberId) return { applicable: false, required: false };
  // Legacy installations may have xero_contact_id/company fields, while newer
  // installations do not. Read the private server row without selecting an
  // optional/nonexistent column; only the explicit safe contact below escapes.
  const memberResult = await db.from('member').select('*')
    .eq('id', memberId).eq('tenant_id', tenantId).maybeSingle();
  if (memberResult.error || !memberResult.data) fail('Unable to verify purchasing member', 403);
  const member = memberResult.data;
  const active = await db.from('tenant_accounting_settings').select('active_provider').eq('tenant_id', tenantId).maybeSingle();
  if (active.error) fail('Unable to verify accounting provider');
  if (['none', 'quickbooks'].includes(active.data?.active_provider)) return { applicable: false, required: false };
  if (active.data?.active_provider && active.data.active_provider !== 'xero') fail('Unrecognized accounting provider');
  const enabled = await db.from('system_settings').select('setting_value').eq('tenant_id', tenantId)
    .eq('setting_key', 'xero_invoice_enabled').maybeSingle();
  if (enabled.error) fail('Unable to verify invoice settings');
  if (enabled.data?.setting_value !== 'true') return { applicable: false, required: false };
  const integration = await db.from('tenant_integrations').select('is_enabled').eq('tenant_id', tenantId)
    .eq('integration_type', 'xero').maybeSingle();
  if (integration.error || integration.data?.is_enabled !== true) fail('Xero connection requires reconnection');
  const tokens = await db.from('xero_token').select('id,tenant_id').eq('app_tenant_id', tenantId);
  if (tokens.error || tokens.data?.length !== 1 || !tokens.data[0].id || !tokens.data[0].tenant_id
    || tokens.data[0].tenant_id === 'PENDING_SELECTION') fail('A unique selected Xero company is required');
  const provider = { connectionId: tokens.data[0].id, xeroTenantId: tokens.data[0].tenant_id };
  const contact = { name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
    email: member.email, isOrganization: false, provenance: { kind: 'member', id: member.id } };
  const known = await knownEventXeroContact(db, tenantId, member, provider);
  const knownContactId = known.contactId;
  const identity = { ...contact, ...(knownContactId ? { contactId: knownContactId } : {}) };
  let existing;
  if (lookup) existing = await lookup(identity, provider);
  else {
    const { getValidXeroAccessToken } = await import('./xero.js');
    const credentials = await getValidXeroAccessToken(tenantId);
    if (credentials.tenantId !== provider.xeroTenantId) fail('Xero company changed during lookup');
    existing = await lookupEventXeroContact(async path => {
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'xero-tenant-id': provider.xeroTenantId, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) fail('Xero customer lookup unavailable');
      const data = await response.json();
      if (data?.ErrorNumber || data?.HasErrors) fail('Xero customer lookup rejected');
      return data;
    }, identity);
  }
  // A legacy bare ContactID is not a company binding. Verify it in the selected
  // company and verify purchaser email before freezing that binding. Missing or
  // invalid known IDs NEVER fall through to absent-customer creation.
  if (knownContactId && (!existing || existing.ContactID !== knownContactId
    || (!known.trusted && (!normalized(member.email) || normalized(existing.EmailAddress) !== normalized(member.email))))) {
    fail('Saved Xero customer identity requires review');
  }
  const result = { applicable: true, required: !existing, provider, contact, existingContactId: existing?.ContactID || null,
    personalAddress: null, organizationAddress: null, organizationLabel: null };
  // Existing customers must never trigger address collection or private reads.
  if (existing) return result;
  const read = async (ownerType, ownerId) => {
    const row = await db.from('invoicing_address_private').select(INVOICING_ADDRESS_KEYS.join(','))
      .eq('tenant_id', tenantId).eq('owner_type', ownerType).eq('owner_id', ownerId).maybeSingle();
    if (row.error) fail('Private invoice address storage unavailable');
    return row.data || {};
  };
  result.personalAddress = resolveStoredInvoicingAddress(await read('member', member.id), 'member');
  if (member.organization_id) {
    const org = await db.from('organization').select('id,name,invoicing_address').eq('id', member.organization_id)
      .eq('tenant_id', tenantId).maybeSingle();
    if (org.error || !org.data) fail('Linked organization could not be verified');
    result.organizationAddress = resolveStoredInvoicingAddress({ ...org.data, ...await read('organization', org.data.id) }, 'organization');
    result.organizationLabel = org.data.name;
  }
  return result;
}

export function selectedEventInvoiceAddress(context, selection) {
  if (!context.required) return null;
  const required = message => { throw Object.assign(new Error(message), {
    statusCode: 400, code: 'EVENT_INVOICE_ADDRESS_REQUIRED',
  }); };
  if (selection?.mode === 'organization') {
    if (!context.organizationAddress) required('A linked organization invoice address is not available');
    return context.organizationAddress;
  }
  if (selection?.mode !== 'personal' || !selection.address || Array.isArray(selection.address)
    || Object.keys(selection.address).some(key => !INVOICING_ADDRESS_KEYS.includes(key))) {
    required('Select a personal or linked organization invoice address');
  }
  const error = invoicingAddressError(selection.address);
  if (error) required(error);
  const resolved = resolveStoredInvoicingAddress(selection.address, 'member');
  if (!resolved || !resolved.address.invoicing_city || !resolved.address.invoicing_postal_code || !resolved.address.invoicing_country) {
    required('Invoice address line 1, city, postcode and country are required');
  }
  return resolved;
}

const canonical = value => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const changed = () => { throw Object.assign(
  new Error('Checkout details changed after invoice instructions were frozen. Resume the original checkout or contact support.'),
  { statusCode: 409, code: 'EVENT_INVOICE_POLICY_CONFLICT' },
); };
export async function prepareEventInvoiceAddressPolicy(input) {
  // Query by the browser's request key only within verified ownership. It is an
  // idempotency key, never authorization to another member's private snapshot.
  const readExisting = async () => {
    const result = await input.db.from('event_invoice_address_policy').select('id,snapshot')
      .eq('id', input.requestId).eq('tenant_id', input.tenantId).eq('member_id', input.memberId)
      .eq('event_id', input.eventId).eq('source', input.source).maybeSingle();
    if (result.error) fail('Invoice policy storage unavailable');
    return result.data;
  };
  const requested = { selection: input.selection || null, charge: input.charge || null };
  const replay = row => {
    if (canonical(row.snapshot.request) !== canonical(requested)) changed();
    return { id: row.id, policy: row.snapshot };
  };
  // Non-Xero flows do not depend on the new private storage.
  // A scoped existing request is read before refreshing provider/address data:
  // retries must not reinterpret already frozen instructions.
  if (uuid.test(input.requestId || '')) {
    const result = await input.db.from('event_invoice_address_policy').select('id,snapshot')
      .eq('id', input.requestId).eq('tenant_id', input.tenantId).eq('member_id', input.memberId)
      .eq('event_id', input.eventId).eq('source', input.source).maybeSingle();
    if (!result.error && result.data) return replay(result.data);
    if (result.error && !['42P01', 'PGRST205'].includes(result.error.code)) fail('Invoice policy storage unavailable');
  }
  const context = await eventAddressContext(input);
  if (!context.applicable) return null;
  if (!uuid.test(input.requestId || '')) fail('A valid purchase_request_id is required before payment', 400);
  const address = selectedEventInvoiceAddress(context, input.selection);
  const policy = { version: 1, tenantId: input.tenantId, eventId: input.eventId, source: input.source,
    memberId: input.memberId, provider: context.provider, contact: context.contact,
    existingContactId: context.existingContactId, address,
    mode: context.required ? input.selection.mode : 'existing', request: requested };
  const id = input.requestId;
  const saved = await input.db.from('event_invoice_address_policy').insert({
    id, tenant_id: input.tenantId, member_id: input.memberId, event_id: input.eventId, source: input.source, snapshot: policy,
  }).select('id').single();
  if (saved.error?.code === '23505') {
    const prior = await readExisting();
    if (!prior) changed();
    return replay(prior);
  }
  if (saved.error || saved.data?.id !== id) fail('Invoice policy could not be frozen before payment');
  return { id, policy };
}

export async function createPolicyPaymentIntent({ db, stripe, preparation, parameters }) {
  const { id, policy } = preparation;
  const read = async table => {
    const result = await db.from(table).select('*').eq('policy_id', id).eq('tenant_id', policy.tenantId).maybeSingle();
    if (result.error) fail('Payment instruction storage unavailable');
    return result.data;
  };
  let request = await read('event_invoice_payment_request');
  if (!request) {
    const saved = await db.from('event_invoice_payment_request').insert({
      policy_id: id, tenant_id: policy.tenantId, parameters,
    }).select('*').single();
    if (saved.error && saved.error.code !== '23505') fail('Payment instructions could not be frozen');
    request = saved.data || await read('event_invoice_payment_request');
  }
  if (!request || canonical(request.parameters) !== canonical(parameters)) changed();
  const verify = pi => {
    if (!/^pi_[A-Za-z0-9]+$/.test(pi?.id || '') || pi.amount !== parameters.amount
      || String(pi.currency).toLowerCase() !== String(parameters.currency).toLowerCase()
      || pi.metadata?.event_invoice_policy_id !== id || pi.metadata?.tenant_id !== policy.tenantId
      || pi.metadata?.event_invoice_member_id !== policy.memberId || pi.metadata?.event_id !== policy.eventId) {
      fail('Stripe payment response does not match frozen invoice authority');
    }
    return pi;
  };
  const binding = await read('event_invoice_payment_binding');
  if (binding) {
    const pi = verify(await stripe.paymentIntents.retrieve(binding.payment_intent_id));
    if (pi.id !== binding.payment_intent_id) fail('Bound Stripe payment identity changed');
    return pi;
  }
  // Stripe retains idempotency keys for at least 24h. Once that safety window
  // has passed, unbound attempts require review; never create another payment.
  if (!Number.isFinite(Date.parse(request.created_at)) || Date.now() - Date.parse(request.created_at) > 23 * 3600000) {
    fail('Payment initiation requires review; do not make another payment with this checkout', 409);
  }
  const pi = verify(await stripe.paymentIntents.create(request.parameters, { idempotencyKey: `event-invoice:${policy.tenantId}:${id}` }));
  const saved = await db.from('event_invoice_payment_binding').insert({
    policy_id: id, tenant_id: policy.tenantId, payment_intent_id: pi.id,
  }).select('payment_intent_id').single();
  if (saved.error || saved.data?.payment_intent_id !== pi.id) {
    const prior = await read('event_invoice_payment_binding');
    if (prior?.payment_intent_id !== pi.id) fail('Payment identity could not be durably bound; retry the same checkout');
  }
  return pi;
}

export async function assertEventInvoicePaymentOwner({ db, paymentIntent, tenantId, eventId, source, memberId }) {
  const binding = await db.from('event_invoice_payment_binding').select('policy_id')
    .eq('tenant_id', tenantId).eq('payment_intent_id', paymentIntent.id).maybeSingle();
  if (binding.error || !binding.data?.policy_id || !memberId) fail('Payment invoice authority is unavailable or belongs to another purchaser', 403);
  const result = await db.from('event_invoice_address_policy').select('id')
    .eq('id', binding.data.policy_id).eq('tenant_id', tenantId).eq('event_id', eventId)
    .eq('member_id', memberId).eq('source', source).maybeSingle();
  if (result.error || result.data?.id !== binding.data.policy_id
    || paymentIntent.metadata?.event_invoice_policy_id !== binding.data.policy_id
    || paymentIntent.metadata?.event_invoice_member_id !== memberId
    || paymentIntent.metadata?.tenant_id !== tenantId || paymentIntent.metadata?.event_id !== eventId) {
    fail('Payment does not belong to this authenticated purchaser', 403);
  }
}

export async function loadPaidEventInvoicePolicy({ db, tenantId, eventId, source, contact, paymentIntent, provider }) {
  const binding = await db.from('event_invoice_payment_binding').select('policy_id')
    .eq('tenant_id', tenantId).eq('payment_intent_id', paymentIntent?.id).maybeSingle();
  const hasMarker = paymentIntent?.metadata?.event_invoice_policy_id || paymentIntent?.metadata?.event_invoice_policy_version
    || paymentIntent?.metadata?.event_invoice_member_id;
  // Pre-rollout payments have neither our version marker nor a durable binding.
  // Their original charge evidence remains valid legacy authority.
  if (!hasMarker && (!binding.data && (!binding.error || ['42P01', 'PGRST205'].includes(binding.error.code)))) return null;
  const id = binding.data?.policy_id;
  if (binding.error || !id) fail('Original pre-payment invoice policy payment binding is missing');
  const result = await db.from('event_invoice_address_policy').select('snapshot')
    .eq('id', id).eq('tenant_id', tenantId).eq('member_id', contact?.provenance?.id)
    .eq('event_id', eventId).eq('source', source === 'booking' ? 'simple' : 'complex').maybeSingle();
  const policy = result.data?.snapshot;
  if (result.error || !policy || policy.version !== 1 || policy.memberId !== contact?.provenance?.id
    || policy.tenantId !== tenantId || policy.eventId !== eventId
    || policy.provider.connectionId !== provider.connectionId || policy.provider.xeroTenantId !== provider.xeroTenantId
    || paymentIntent.metadata.tenant_id !== tenantId || paymentIntent.metadata.event_id !== eventId
    || paymentIntent.metadata.event_invoice_policy_id !== id
    || paymentIntent.metadata.event_invoice_member_id !== policy.memberId) fail('Invoice policy payment ownership or company mismatch');
  return policy;
}

export function policyInvoiceContact(policy) {
  if (policy.existingContactId) return { ContactID: policy.existingContactId };
  if (!policy.address) fail('Frozen invoice address missing');
  return { Name: policy.contact.name, EmailAddress: policy.contact.email, Addresses: [invoicingAddressToXero(policy.address)] };
}

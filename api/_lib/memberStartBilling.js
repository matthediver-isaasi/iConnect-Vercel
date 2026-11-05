import { startError } from './memberStartQuote.js';

const text = value => typeof value === 'string' ? value.trim() : '';
async function read(query) {
  const result = await query;
  if (result.error) throw startError('Invoice address choices could not be loaded. Please retry.', 503);
  return result.data;
}
export async function memberStartInvoiceParties(db, tenantId, memberId) {
  const member = await read(db.from('member').select('*').eq('tenant_id', tenantId).eq('id', memberId).single());
  if (!member) throw startError('Member not found.', 404);
  const entities = [{ type: 'member', row: member }];
  if (member.organization_id) {
    const row = await read(db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', member.organization_id).single());
    if (row) entities.push({ type: 'organization', row });
  }
  const groupIds = new Set([member.organization_group_id, entities.find(e => e.type === 'organization')?.row.organization_group_id].filter(Boolean));
  for (const groupId of groupIds) {
    const row = await read(db.from('organization_group').select('*').eq('tenant_id', tenantId).eq('id', groupId).single());
    if (row) entities.push({ type: 'organization_group', row });
  }
  const parties = [];
  for (const { type, row } of entities) {
    const definitions = await read(db.from('preference_field').select('id,label,name,field_type')
      .eq('tenant_id', tenantId).eq('entity_scope', type).eq('is_active', true).order('id').limit(1000));
    if (definitions.length === 1000) throw startError('Too many invoice fields to load safely.');
    const fields = ['invoicing_address', 'address', 'invoicing_email', 'email'].filter(key => text(row[key]))
      .map(key => ({ key: `core:${key}`, label: key.replaceAll('_', ' '), value: text(row[key]) }));
    if (type !== 'member' && text(member.email)) fields.push({
      key: 'member:email', label: "Member's email (billing contact)", value: text(member.email),
    });
    if (definitions.length) {
      const values = await read(db.from(`${type}_preference_value`).select('field_id,value')
        .eq(`${type}_id`, row.id).in('field_id', definitions.map(f => f.id)).limit(1000));
      if (values.length === 1000) throw startError('Too many invoice values to load safely.');
      for (const f of definitions) {
        if (!['text', 'textarea', 'email', 'country', 'select', 'dropdown', 'single_select', 'string'].includes(f.field_type)) continue;
        const matches = values.filter(v => v.field_id === f.id);
        if (matches.length > 1) throw startError('Duplicate address field values require review.');
        const value = text(matches[0]?.value);
        if (value) fields.push({ key: `custom:${f.id}`, label: f.label || f.name, value });
      }
    }
    parties.push({ key: `${type}:${row.id}`, id: row.id, type,
      label: type === 'member' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email : row.name,
      email: text(row.invoicing_email || row.email), fields });
  }
  return parties;
}

export function resolveMemberStartBilling(parties, billing) {
  const recipient = parties.find(p => p.key === billing?.recipientKey);
  const source = parties.find(p => p.key === billing?.addressSourceKey);
  if (!recipient || !source) throw startError('Choose a currently linked invoice recipient and address source.');
  if (!Array.isArray(billing.addressFields) || !billing.addressFields.length || billing.addressFields.length > 7
      || new Set(billing.addressFields).size !== billing.addressFields.length) throw startError('Choose the invoice address fields in order.');
  const lines = billing.addressFields.map(key => {
    const field = source.fields.find(f => f.key === key);
    if (!field?.value) throw startError('A selected address field is no longer available. Refresh the preview.');
    return field.value;
  });
  const email = billing.emailField ? recipient.fields.find(f => f.key === billing.emailField)?.value : recipient.email;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw startError('Select a valid billing email field for this recipient.');
  const address = lines.join('\n');
  if (address.length > 2000) throw startError('The invoice address is too long.');
  return { organizationName: recipient.label, invoicingEmail: email, invoicingAddress: address,
    billing: { recipientKey: recipient.key, addressSourceKey: source.key, addressFields: [...billing.addressFields], emailField: billing.emailField || null },
    requireInvoiceAddress: true };
}

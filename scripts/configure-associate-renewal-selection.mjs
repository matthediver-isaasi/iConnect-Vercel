import { connectDestination } from './annual-meeting-destination.mjs';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const formId = 'e86b2a16-e5bc-4c18-9329-6862cb2a2a4b';
const paymentId = 'field_1786382412640';
const answerId = 'field_1786367685995';
const classId = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
const explicitMapping = { source_field_id: answerId, entries: [
  { value: 'Associate', config_id: '9b1615b0-0699-487f-8ee5-c34746b72493' },
  { value: 'Overseas associate', config_id: '62c6a57d-23c3-432d-881f-33a095a3e658' },
] };
const apply = process.argv.includes('--apply');
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout = '5s'");
  const { rows: [form] } = await db.query(
    `SELECT fields,is_active,require_authentication FROM form WHERE tenant_id=$1 AND id=$2${apply ? ' FOR UPDATE' : ''}`,
    [tenantId, formId]);
  if (!form?.is_active || !form.require_authentication || !Array.isArray(form.fields)) throw new Error('Form configuration changed');
  const payment = form.fields.find(field => field.id === paymentId && field.type === 'membership_payment');
  const answer = form.fields.find(field => field.id === answerId && field.type === 'radio');
  if (!payment || JSON.stringify(answer?.options) !== JSON.stringify(['Associate', 'Overseas associate'])) throw new Error('Expected fields changed');
  const { rows: [config] } = await db.query(
    'SELECT structure_field_id,structure_scope_type FROM membership_tier_config WHERE tenant_id=$1 AND id=$2',
    [tenantId, payment.membership_config_id]);
  if (config?.structure_scope_type !== 'member' || config.structure_field_id !== classId) throw new Error('Schedule scope changed');
  const previousMapping = payment.field_mappings?.[classId];
  if (previousMapping && previousMapping !== answerId) throw new Error('A different mapping has been configured');
  if (payment.membership_schedule_mapping
      && JSON.stringify(payment.membership_schedule_mapping) !== JSON.stringify(explicitMapping)) {
    // Compare structurally as JSONB can reorder object keys.
    const current = payment.membership_schedule_mapping;
    if (current.source_field_id !== answerId || current.entries?.length !== 2
        || explicitMapping.entries.some(expected => !current.entries.some(entry =>
          entry.value === expected.value && entry.config_id === expected.config_id))) {
      throw new Error('A different explicit schedule mapping has been configured');
    }
  }
  for (const entry of explicitMapping.entries) {
    const { rows: [target] } = await db.query(
      'SELECT structure_field_id,structure_match_value,structure_scope_type,is_active FROM membership_tier_config WHERE tenant_id=$1 AND id=$2',
      [tenantId, entry.config_id]);
    if (!target || target.is_active === false || target.structure_scope_type !== 'member'
        || target.structure_field_id !== classId || target.structure_match_value !== entry.value) {
      throw new Error('Explicit target schedule is not valid');
    }
  }
  const fields = form.fields.map(field => field.id === paymentId
    ? { ...field, membership_schedule_mapping: explicitMapping } : field);
  const alreadyConfigured = !!payment.membership_schedule_mapping;
  if (apply && !alreadyConfigured) {
    const result = await db.query('UPDATE form SET fields=$1::jsonb WHERE tenant_id=$2 AND id=$3',
      [JSON.stringify(fields), tenantId, formId]);
    if (result.rowCount !== 1) throw new Error('Unexpected update count');
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, alreadyConfigured,
    change: 'Map each Member Class answer to its exact renewal schedule', formId }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}

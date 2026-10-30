import { connectDestination } from './annual-meeting-destination.mjs';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const formId = 'e86b2a16-e5bc-4c18-9329-6862cb2a2a4b';
const paymentId = 'field_1786382412640';
const answerId = 'field_1786367685995';
const classId = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
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
  const fields = form.fields.map(field => field.id === paymentId
    ? { ...field, field_mappings: { ...field.field_mappings, [classId]: answerId } } : field);
  if (apply && previousMapping !== answerId) {
    const result = await db.query('UPDATE form SET fields=$1::jsonb WHERE tenant_id=$2 AND id=$3',
      [JSON.stringify(fields), tenantId, formId]);
    if (result.rowCount !== 1) throw new Error('Unexpected update count');
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, alreadyConfigured: previousMapping === answerId,
    change: 'Map renewal membership class to the existing Member Class answer', formId }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}

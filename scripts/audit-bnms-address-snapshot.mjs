import fs from 'node:fs';
import { connectDestination } from './annual-meeting-destination.mjs';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const directory = 'private/bnms-address-audit';
if (process.argv.length > 2) throw new Error('This read-only audit accepts no arguments.');
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout = '60s'");
  const tenant = (await db.query('SELECT id,name FROM public.tenant WHERE id=$1', [tenantId])).rows;
  if (tenant.length !== 1 || !/bnms|british nuclear medicine society/i.test(tenant[0].name)) throw new Error('BNMS pin failed');
  const metadata = (await db.query("SELECT current_timestamp AS captured_at, current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation")).rows[0];
  const columns = (await db.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('organization','preference_field','organization_preference_value') ORDER BY table_name,ordinal_position")).rows;
  const fields = (await db.query("SELECT id,tenant_id,name,label,field_type,options,is_active,entity_scope,to_jsonb(f)->'all_countries' AS all_countries,to_jsonb(f)->'selected_countries' AS selected_countries FROM public.preference_field f WHERE tenant_id=$1 AND entity_scope='organization' ORDER BY id", [tenantId])).rows;
  const organizations = (await db.query('SELECT id,tenant_id,name,invoicing_address FROM public.organization WHERE tenant_id=$1 ORDER BY id', [tenantId])).rows;
  const values = (await db.query('SELECT v.id,v.organization_id,v.field_id,v.value FROM public.organization_preference_value v JOIN public.organization o ON o.id=v.organization_id JOIN public.preference_field f ON f.id=v.field_id WHERE o.tenant_id=$1 AND f.tenant_id=$1 AND f.entity_scope=$2 ORDER BY v.id', [tenantId, 'organization'])).rows;
  const count = Number((await db.query('SELECT count(*) FROM public.organization WHERE tenant_id=$1', [tenantId])).rows[0].count);
  if (count !== organizations.length || new Set(organizations.map(o => o.id)).size !== count) throw new Error('Incomplete cohort');
  await db.query('ROLLBACK');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${directory}/snapshot.json`, JSON.stringify({ tenant: tenant[0], metadata, columns, fields, organizations, values }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...metadata, organizations: count, withSource: organizations.filter(o => o.invoicing_address?.trim()).length, fields: fields.filter(f => /address|town|county|postcode|country/i.test(f.name)), valueRows: values.length }, null, 2));
} finally {
  await db.end();
}

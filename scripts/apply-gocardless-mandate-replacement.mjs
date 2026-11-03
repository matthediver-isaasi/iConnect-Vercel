// Destination-only, additive schema installation. No provider operations and
// no membership/mandate data updates. Releases remain separately controlled.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
const files = [
  '202611030001_gocardless_mandate_replacement.sql',
  '202611030002_gocardless_mandate_handover.sql',
];
const db = await destinationConnection();
await db.connect();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'");
  const exists = (await db.query("SELECT to_regclass('public.membership_mandate_replacements') name")).rows[0].name;
  if (exists) throw new Error('Replacement schema already exists; inspect installed contracts rather than replaying.');
  const hashes = [];
  for (const file of files) {
    const text = await fs.readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    await db.query(text.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
    hashes.push({ file, sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  const grants = await db.query(`SELECT
    has_table_privilege('authenticated','public.membership_mandate_replacements','SELECT') browser_read,
    has_table_privilege('service_role','public.membership_mandate_replacements','DELETE') service_delete,
    has_table_privilege('service_role','public.gocardless_replacement_release','UPDATE') service_release,
    has_function_privilege('authenticated','public.prepare_mandate_handover(uuid,integer,jsonb)','EXECUTE') browser_prepare`);
  if (Object.values(grants.rows[0]).some(Boolean)) throw new Error('Unexpected replacement privileges');
  await db.query("NOTIFY pgrst,'reload schema'");
  await db.query('COMMIT');
  console.log(JSON.stringify({ installed: hashes, accessChecks: grants.rows[0], releasesEnabled: false }));
} catch (error) {
  await db.query('ROLLBACK'); throw error;
} finally { await db.end(); }

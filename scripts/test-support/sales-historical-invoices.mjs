import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function verifyHistoricalStageInvoices({ admin, a, b, tenant }) {
  await admin.query(readFileSync(new URL('../../supabase/migrations/202611240001_sales_stage_historical_invoices.sql', import.meta.url), 'utf8'));
  const version = randomUUID(), quote = randomUUID(), sale = randomUUID();
  await admin.query('CREATE TABLE IF NOT EXISTS sales_quote(id uuid PRIMARY KEY,tenant_id uuid)');
  await admin.query('INSERT INTO sales_quote(id,tenant_id) VALUES($1,$2)', [quote, tenant]);
  const groups = [0, 1, 2, 3].map(i => ({ id: randomUUID(), name: `Stage ${i}`, grossMinor: 1000,
    netMinor: 1000, taxMinor: 0, currency: 'GBP', timing: { kind: 'acceptance', days: 0 }, paymentTerms: { days: 14 } }));
  const billing = { timezone: 'UTC', timezoneFallback: false, recipient: { email: 'fixture@example.test' }, groups };
  await admin.query(`INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,status,currency,
    net_minor,tax_minor,gross_minor,billing_schedule) VALUES($1,$2,$3,1,'draft','GBP',4000,0,4000,$4)`,
  [version, tenant, quote, billing]);
  const record = (client, group, number, tenantId = tenant, versionId = version) => client.query(
    'SELECT record_sales_stage_historical_invoice($1,$2,$3,$4,$5,$6,$7,$8)',
    [tenantId, quote, versionId, group, number, 'fixture-admin', 'admin', groups.find(row => row.id === group) || {}]);
  await assert.rejects(record(a, groups[0].id, ''), /valid invoice number/);
  await assert.rejects(record(a, groups[0].id, 'INV-1', randomUUID()), /Reload/);
  await assert.rejects(record(a, randomUUID(), 'INV-1'), /saved billing stage/);
  await assert.rejects(a.query('SELECT record_sales_stage_historical_invoice($1,$2,$3,$4,$5,$6,$7,$8)',
    [tenant, quote, version, groups[0].id, 'INV-1', 'admin', 'admin', { ...groups[0], grossMinor: 999 }]), /stage changed/);
  await record(a, groups[0].id, ' INV-1 ');
  await record(a, groups[0].id, 'INV-1');
  await assert.rejects(record(a, groups[0].id, 'INV-OTHER'), /already been recorded/);
  await assert.rejects(a.query('DELETE FROM sales_stage_historical_invoice'), /permission denied/);
  const changed = structuredClone(billing); changed.groups[0].name = 'Changed invoiced stage';
  await assert.rejects(admin.query('UPDATE sales_quote_version SET billing_schedule=$1 WHERE id=$2', [changed, version]), /cannot be removed or changed/);
  await admin.query("UPDATE sales_quote_version SET status='accepted' WHERE id=$1", [version]);
  await admin.query("INSERT INTO sales_quote_status_history VALUES($1,$2,'accepted',now())", [tenant, version]);
  await admin.query('INSERT INTO sales_commercial_sale VALUES($1,$2,$3)', [sale, tenant, version]);
  let rows = (await admin.query('SELECT * FROM sales_invoice_schedule WHERE quote_version_id=$1 ORDER BY group_id', [version])).rows;
  const stage = index => rows.find(row => row.group_id === groups[index].id);
  assert.equal(stage(0).status, 'no_invoice_required');
  assert.equal(stage(0).manual_invoice_number, 'INV-1');
  const claim = (client, id) => client.query('SELECT claim_sales_schedule_dispatch($1,$2,$3) AS claimed', [tenant, id, randomUUID()]);
  assert.equal((await claim(a, stage(0).id)).rows[0].claimed, false);
  await assert.rejects(admin.query("UPDATE sales_invoice_schedule SET status='queued' WHERE id=$1", [stage(0).id]), /new issuance is prohibited/);
  await record(a, groups[1].id, 'INV-2');
  assert.equal((await claim(a, stage(1).id)).rows[0].claimed, false);
  assert.equal((await claim(a, stage(2).id)).rows[0].claimed, true);
  await assert.rejects(record(b, groups[2].id, 'INV-3'), /already issued or being processed/);
  // Manual record holds the stage row until commit; a waiting worker must recheck status.
  await a.query('BEGIN');
  await record(a, groups[3].id, 'INV-4');
  const competing = claim(b, stage(3).id);
  await a.query('COMMIT');
  assert.equal((await competing).rows[0].claimed, false);
  const audit = await admin.query("SELECT * FROM sales_audit_event WHERE entity_id=$1 AND action='invoice_stage.historical_invoice_recorded'", [version]);
  assert.equal(audit.rows.length, 3);
  // Copying an amendment retains documentary evidence, not new invoice commands.
  const amendment = randomUUID();
  await admin.query(`INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,status,currency,
    net_minor,tax_minor,gross_minor,billing_schedule) VALUES($1,$2,$3,2,'draft','GBP',4000,0,4000,$4)`,
  [amendment, tenant, quote, billing]);
  assert.equal((await admin.query('SELECT * FROM sales_stage_historical_invoice WHERE quote_version_id=$1', [amendment])).rows.length, 3);
  await assert.rejects(record(a, groups[2].id, 'STALE'), /Reload/);
  await admin.query('SET ROLE authenticated');
  await assert.rejects(record(admin, groups[2].id, 'UNAUTHORIZED', tenant, amendment), /permission denied/);
  await admin.query('RESET ROLE');
}

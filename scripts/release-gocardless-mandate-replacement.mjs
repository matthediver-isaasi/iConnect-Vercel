// Enable only after the provider-only proof has completed. This changes a
// feature release row, never a mandate, subscription, member or payment.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
const environment = process.argv[2];
assert.ok(['sandbox','live'].includes(environment), 'Choose sandbox or live explicitly');
const text = await fs.readFile(new URL('../generated-artifacts/gocardless-handover/provider-switch-evidence.json', import.meta.url), 'utf8');
const proof = JSON.parse(text);
assert.equal(proof.environment, 'sandbox');
assert.ok(proof.completed && Number.isFinite(Date.parse(proof.completed)));
assert.notEqual(proof.phases['original-mandates'].id,proof.phases['replacement-mandates'].id);
assert.deepEqual(proof.oldSubscription.upcoming_payments, proof.newSubscription.upcoming_payments);
assert.equal(proof.newSubscription.upcoming_payments.length,2);
const reference = `sandbox-stop-create-retire:${crypto.createHash('sha256').update(text).digest('hex')}`;
const db = await destinationConnection(); await db.connect();
try {
  await db.query('BEGIN');
  await db.query(`INSERT INTO public.gocardless_replacement_release(environment,enabled,evidence_reference)
    VALUES($1,true,$2) ON CONFLICT(environment) DO UPDATE SET enabled=true,evidence_reference=excluded.evidence_reference,
    enabled_at=now()`, [environment,reference]);
  await db.query('COMMIT');
  console.log(`${environment} release recorded; authorization becomes available after the five-minute release delay.`);
} catch(error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }

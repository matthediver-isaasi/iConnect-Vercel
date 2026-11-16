import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { INVOICING_ADDRESS_KEYS as keys, invoicingAddressError } from '../shared/invoicingAddress.js';

assert.equal(process.argv[2], '--apply');
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const names = ['org_address_line_1', 'org_address_line_2', 'org_address_line_3',
  'org_town_city', 'org_county', 'org_postcode', 'org_country'];
const audit = 'generated-artifacts/bnms-invoice-address-backfill/approved-backfill.jsonl';
await mkdir('generated-artifacts/bnms-invoice-address-backfill', { recursive: true, mode: 0o700 });
await writeFile(audit, JSON.stringify({ stage: 'started', at: new Date().toISOString(), tenant }) + '\n', { flag: 'wx', mode: 0o600 });
const c = await connectDestination();
let committed = false;
try {
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await c.query("SET LOCAL lock_timeout='10s'");
  const loadOrgs = () => c.query('select * from organization where tenant_id=$1 order by id', [tenant]);
  const beforeOrgs = (await loadOrgs()).rows;
  const fields = (await c.query(`select id,name from preference_field where tenant_id=$1
    and entity_scope='organization' and name=any($2::text[])`, [tenant, names])).rows;
  assert.equal(fields.length, 7);
  assert.equal(new Set(fields.map(f => f.name)).size, 7);
  const loadSources = () => c.query(`select v.organization_id,f.name,v.value from organization_preference_value v
    join organization o on o.id=v.organization_id
    join preference_field f on f.id=v.field_id and f.tenant_id=o.tenant_id
    where o.tenant_id=$1 and f.entity_scope='organization' and f.name=any($2::text[])
    order by v.organization_id,f.name`, [tenant, names]);
  const sources = (await loadSources()).rows;
  const sourceByOrg = new Map(), seen = new Set();
  for (const v of sources) {
    const key = `${v.organization_id}:${v.name}`;
    assert(!seen.has(key), 'Duplicate source value');
    seen.add(key);
    if (!sourceByOrg.has(v.organization_id)) sourceByOrg.set(v.organization_id, {});
    sourceByOrg.get(v.organization_id)[v.name] = v.value;
  }
  const loadTargets = () => c.query(`select * from invoicing_address_private
    where tenant_id=$1 and owner_type='organization' order by owner_id`, [tenant]);
  const existing = (await loadTargets()).rows;
  const byId = new Map(existing.map(a => [a.owner_id, a]));
  const updates = [];
  let protectedCount = 0, missingSource = 0;
  for (const o of beforeOrgs) {
    assert.equal(o.status, 'active', 'Organisation status changed since review');
    const old = byId.get(o.id);
    if (keys.some(k => String(old?.[k] ?? '').trim())) { protectedCount++; continue; }
    const p = sourceByOrg.get(o.id) || {};
    const text = k => typeof p[k] === 'string' ? p[k].trim() : '';
    if (!text('org_address_line_1')) { missingSource++; continue; }
    const values = [text('org_address_line_1'),
      [text('org_address_line_2'), text('org_address_line_3')].filter(Boolean).join(', '),
      text('org_town_city'), text('org_county'), text('org_postcode'), text('org_country')];
    const next = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
    assert.equal(invoicingAddressError(next), null);
    updates.push({ ownerId: o.id, before: old || null, after: next, source: p });
  }
  assert.equal(beforeOrgs.length, 464);
  assert.equal(updates.length, 364);
  assert.equal(protectedCount, 9);
  assert.equal(missingSource, 91);
  await appendFile(audit, JSON.stringify({ stage: 'approved-plan', updates }) + '\n');
  for (const u of updates) {
    const result = await c.query(`insert into invoicing_address_private
      (tenant_id,owner_type,owner_id,${keys.join(',')})
      values ($1,'organization',$2,${keys.map((_, i) => `$${i + 3}`).join(',')})
      on conflict (tenant_id,owner_type,owner_id) do update set
      ${keys.map(k => `${k}=excluded.${k}`).join(',')}
      where ${keys.map(k => `nullif(btrim(invoicing_address_private.${k}),'') is null`).join(' and ')}
      returning owner_id`, [tenant, u.ownerId, ...keys.map(k => u.after[k])]);
    assert.equal(result.rowCount, 1, 'Target became populated; abort entire transaction');
  }
  const verify = rows => {
    const after = new Map(rows.map(a => [a.owner_id, a]));
    for (const u of updates) for (const k of keys) assert.equal(after.get(u.ownerId)?.[k], u.after[k]);
    const changed = new Set(updates.map(u => u.ownerId));
    for (const old of existing) if (!changed.has(old.owner_id)) assert.deepEqual(after.get(old.owner_id), old);
  };
  verify((await loadTargets()).rows);
  assert.deepEqual((await loadOrgs()).rows, beforeOrgs, 'Organisation core/legacy fields must stay unchanged');
  assert.deepEqual((await loadSources()).rows, sources, 'Mailing fields must stay unchanged');
  await c.query('COMMIT');
  committed = true;
  await appendFile(audit, JSON.stringify({ stage: 'committed', at: new Date().toISOString(), count: updates.length }) + '\n');
  verify((await loadTargets()).rows);
  await appendFile(audit, JSON.stringify({ stage: 'verified', count: updates.length }) + '\n');
  console.log(JSON.stringify({ updated: updates.length, existingAddressesPreserved: protectedCount,
    skippedMissingMailingLine1: missingSource, committedAndVerified: true, accountingProviderCalls: 0 }));
} catch (error) {
  if (!committed) await c.query('ROLLBACK');
  await appendFile(audit, JSON.stringify({ stage: committed ? 'post-commit-verification-error' : 'rolled-back', error: error.message }) + '\n');
  throw error;
} finally { await c.end(); }

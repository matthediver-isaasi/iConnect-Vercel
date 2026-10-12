import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignRecipientClaimer } from './campaignRecipientClaims.js';
import { drainCampaignRecipients } from './campaignDrain.js';

function fixture(count) {
  const rows = Array.from({ length: count }, (_, id) => ({ id, campaign_id: 'campaign', status: 'pending' }));
  let failReads = false, failWrites = false, afterRead = () => {};
  const db = { from(table) {
    assert.equal(table, 'email_campaign_recipient');
    const filters = [];
    let update, limit = Infinity;
    const query = {
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      order() { return this; },
      limit(value) { limit = value; return this; },
      update(value) { update = value; return this; },
      then(resolve) {
        if (update ? failWrites : failReads) return Promise.resolve({ error: new Error('Unavailable') }).then(resolve);
        const matches = rows.filter(row => filters.every(check => check(row))).slice(0, limit);
        if (update) matches.forEach(row => Object.assign(row, update));
        const data = matches.map(row => update ? { ...row } : { id: row.id });
        if (!update) afterRead();
        return Promise.resolve({ data }).then(resolve);
      },
    };
    return query;
  } };
  return { db, rows, failReads: () => { failReads = true; }, failWrites: () => { failWrites = true; },
    afterRead: fn => { afterRead = fn; } };
}

test('5,000 claims use 100 candidate reads without preclaiming unused rows', async () => {
  const f = fixture(5000);
  const claimer = createCampaignRecipientClaimer(f.db, 'campaign');
  const first = await claimer.claim();
  assert.equal(first.length, 1);
  assert.equal(f.rows.filter(row => row.status === 'processing').length, 1);
  for (let i = 1; i < 5000; i++) assert.equal((await claimer.claim())[0].id, i);
  assert.equal(claimer.metrics.candidateReads, 100);
  assert.equal(claimer.metrics.claimWrites, 5000);
  assert.deepEqual(await claimer.claim(), []);
});

test('overlapping workers cannot own the same recipient', async () => {
  const f = fixture(12);
  const a = createCampaignRecipientClaimer(f.db, 'campaign', { pageSize: 5 });
  const b = createCampaignRecipientClaimer(f.db, 'campaign', { pageSize: 5 });
  const owned = [];
  for (let i = 0; i < 12; i++) {
    const results = await Promise.all([a.claim(), b.claim()]);
    owned.push(...results.flat().map(row => row.id));
  }
  assert.equal(owned.length, 12);
  assert.equal(new Set(owned).size, 12);
});

test('one claimer safely serves sixteen concurrent slots across small page boundaries', async () => {
  const f = fixture(80);
  const c = createCampaignRecipientClaimer(f.db, 'campaign', { pageSize: 5 });
  const owned = [];
  for (let round = 0; round < 5; round++) {
    const result = await Promise.all(Array.from({ length: 16 }, () => c.claim()));
    owned.push(...result.flat().map(row => row.id));
  }
  assert.equal(owned.length, 80);
  assert.equal(new Set(owned).size, 80);
  assert.equal(c.metrics.candidateReads, 16);
  assert.equal(c.metrics.claimCollisions, 0);
});

test('stale candidates cannot claim sent, cancelled or other-campaign rows', async () => {
  const f = fixture(5);
  const c = createCampaignRecipientClaimer(f.db, 'campaign');
  await c.claim();
  f.rows[1].status = 'sent';
  f.rows[2].status = 'cancelled';
  f.rows[3].campaign_id = 'other';
  assert.equal((await c.claim())[0].id, 4);
  assert.equal(c.metrics.claimCollisions, 3);
});

test('deadline after read leaves every recipient pending', async () => {
  const f = fixture(10);
  let now = 0;
  f.afterRead(() => { now = 11; });
  const c = createCampaignRecipientClaimer(f.db, 'campaign', { deadline: 10, now: () => now });
  assert.deepEqual(await c.claim(), []);
  assert.equal(c.metrics.claimWrites, 0);
  assert.ok(f.rows.every(row => row.status === 'pending'));
});

test('read and conditional-write errors propagate, never grant ownership', async () => {
  for (const method of ['failReads', 'failWrites']) {
    const f = fixture(2); f[method]();
    await assert.rejects(createCampaignRecipientClaimer(f.db, 'campaign').claim(), /Unavailable/);
    assert.ok(f.rows.every(row => row.status === 'pending'));
  }
});

test('page size one provides rollback and remains bounded', async () => {
  const f = fixture(2);
  const c = createCampaignRecipientClaimer(f.db, 'campaign', { pageSize: 1 });
  await c.claim(); await c.claim();
  assert.equal(c.metrics.candidateReads, 2);
  assert.equal(createCampaignRecipientClaimer(f.db, 'campaign', { pageSize: 9999 }).metrics.candidatePageSize, 100);
});

test('cancellation still stops the drain and leaves prefetched recipients untouched', async () => {
  const f = fixture(50);
  const c = createCampaignRecipientClaimer(f.db, 'campaign');
  let sends = 0;
  await drainCampaignRecipients({
    batchSize: 50, concurrency: 1, claim: c.claim,
    gate: async () => ({ allowed: sends === 0, cancelled: sends > 0 }),
    release: async row => { f.rows[row.id].status = 'cancelled'; },
    send: async row => { sends++; f.rows[row.id].status = 'sent'; return 'sent'; },
  });
  assert.equal(sends, 1);
  assert.equal(f.rows.filter(row => row.status === 'pending').length, 48);
});

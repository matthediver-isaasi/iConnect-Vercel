import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBulkEnvelope, fittingCampaignBatchSize } from './campaignBulkTransport.js';
import { finishPreparedCampaignBatch } from './campaignBulkDrain.js';

const messages = (body, count = 100) => Array.from({ length: count }, (_, i) => ({
  domain: 'example.invalid', messageData: {
    from: 'sender@example.invalid', to: [`recipient${i}@example.invalid`],
    subject: `Newsletter ${i}`, html: body, text: 'Newsletter',
    'o:testmode': 'yes',
  },
}));

test('small messages retain a full batch', () => {
  assert.equal(fittingCampaignBatchSize('campaign', messages('Small newsletter')), 100);
});
for (const body of ['A'.repeat(85_000), 'é"\\\n'.repeat(22_000)]) {
  test('large newsletters split at actual encoded bytes, not character or recipient counts', () => {
    const batch = messages(body);
    const size = fittingCampaignBatchSize('campaign', batch);
    assert.ok(size > 1 && size < 100);
    const envelope = buildBulkEnvelope('campaign', batch.slice(0, size));
    assert.ok(Buffer.byteLength(JSON.stringify(envelope.messageData)) <= 8_000_000);
    assert.throws(() => buildBulkEnvelope('campaign', batch.slice(0, size + 1)),
      { code: 'CAMPAIGN_BATCH_TOO_LARGE' });
  });
}
test('genuine incompatibility retains fallback; a single oversized item does not block later recipients', () => {
  const incompatible = messages('Small', 2);
  incompatible[1].domain = 'other.invalid';
  assert.equal(fittingCampaignBatchSize('campaign', incompatible), 2);
  assert.equal(fittingCampaignBatchSize('campaign', messages('A'.repeat(8_000_001), 2)), 1);
});

for (const outcome of ['success', 'ambiguous', 'pause', 'deadline', 'rejected', 'persistence failure']) {
  test(`split ownership remains safe on ${outcome}`, async () => {
    const batch = messages('A'.repeat(100_000));
    const entries = batch.map((prepared, i) => ({ recipient: { id: i }, prepared }));
    const size = fittingCampaignBatchSize('campaign', batch);
    const released = new Set(), persisted = new Set();
    let submitted = 0, clock = 0;
    const result = await finishPreparedCampaignBatch({
      entries, deadline: 12000, now: () => clock,
      revalidateBatch: async rows => new Map(rows.map(r => [r.recipient.id, 'ready'])),
      selectBatchSize: rows => {
        if (outcome === 'deadline') clock = 5000;
        return fittingCampaignBatchSize('campaign', rows.map(r => r.prepared));
      },
      gate: async () => ({ allowed: outcome !== 'pause', paused: outcome === 'pause' }),
      release: async rows => rows.forEach(r => released.add(r.recipient.id)),
      submit: async rows => {
        submitted += rows.length;
        assert.equal(rows.length, size);
        assert.equal(released.size, 100 - size);
        buildBulkEnvelope('campaign', rows.map(r => r.prepared));
        if (outcome === 'ambiguous') return { success: false, ambiguousEffect: true };
        if (outcome === 'rejected') return { success: false, rateLimited: true };
        return { success: true, messageId: 'shared-batch-id' };
      },
      persist: async rows => {
        if (outcome === 'persistence failure') throw new Error('Unavailable');
        rows.forEach(r => persisted.add(r.recipient.id));
      },
    });
    if (['pause', 'deadline'].includes(outcome)) {
      assert.equal(submitted, 0); assert.equal(released.size, 100);
    } else {
      assert.equal(submitted, size); assert.equal(released.size, 100 - size);
      assert.equal([...released].some(id => id < size), false);
      if (['ambiguous', 'persistence failure'].includes(outcome)) {
        assert.equal(result.processing, size); assert.equal(persisted.size, 0);
      } else assert.equal(persisted.size, size);
    }
    assert.equal(result.fallback, undefined);
  });
}

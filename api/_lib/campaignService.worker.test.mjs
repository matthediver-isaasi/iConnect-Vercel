import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.SUPABASE_URL = 'https://campaign-worker.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
const { supabase } = await import('./database.js');
const { sendBatch } = await import('./campaignService.js');

test('booking event-scope lookup carries the recipient read budget into nested audience-list resolution', async () => {
  const source = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
  assert.match(source, /async function resolveCampaignBookingEventScope\(campaign, tenantId, db = supabase\) \{\s*const scope = await resolveCampaignEventScope\(campaign, tenantId, db\)/);
});

function install(t, size) {
  const campaign = {
    id: 'campaign', tenant_id: 'tenant', status: 'sending', from_email: 'sender@example.test',
    subject: 'Subject', html_content: '<p>Message</p>', category_review_required: false,
    target_type: 'all_members', target_ids: [], target_audiences: [],
  };
  const rows = Array.from({ length: size }, (_, index) => ({
    id: `recipient-${index}`, campaign_id: 'campaign', status: 'pending',
    email: `attendee-${index}@example.test`,
  }));
  const originalFrom = supabase.from;
  supabase.from = table => {
    let action = 'select', value, fields, countRequested = false, head = false;
    const filters = [];
    let limit = Infinity;
    const q = {
      select(columns, opts = {}) { fields = columns; countRequested = opts.count === 'exact'; head = opts.head; return this; },
      update(updates) { action = 'update'; value = updates; return this; },
      eq(key, expected) { filters.push(row => row[key] === expected); return this; },
      in(key, expected) { filters.push(row => expected.includes(row[key])); return this; },
      not(key, _op, expected) { filters.push(row => row[key] !== expected); return this; },
      order() { return this; },
      limit(n) { limit = n; return this; },
      async single() { const result = await this; return { ...result, data: result.data[0] || null }; },
      async maybeSingle() { const result = await this; return { ...result, data: result.data[0] || null }; },
      then(resolve) {
        const source = table === 'email_campaign' ? [campaign] : rows;
        const matching = source.filter(row => filters.every(filter => filter(row))).slice(0, limit);
        if (action === 'update') matching.forEach(row => Object.assign(row, value));
        return resolve({ data: head ? null : structuredClone(matching),
          count: countRequested ? matching.length : null, error: null });
      },
    };
    assert.ok(['email_campaign', 'email_campaign_recipient'].includes(table));
    return q;
  };
  t.after(() => { supabase.from = originalFrom; });
  return { campaign, rows };
}

test('actual service batch stops after two slow personalized sends and leaves 98 rows unclaimed', async t => {
  const { campaign, rows } = install(t, 100);
  let clock = 0;
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100, {
    deadline: 38_000,
    now: () => clock,
    sendRecipient: async recipient => {
      clock += 19_000;
      rows.find(row => row.id === recipient.id).status = 'sent';
      return 'sent';
    },
  });
  assert.equal(result.batchSent, 2, JSON.stringify(result));
  assert.equal(result.sent, 2);
  assert.equal(result.queued, 98);
  assert.equal(result.remaining, 98);
  assert.equal(rows.some(row => row.status === 'processing'), false);
});

test('actual service batch completes ordinary fast recipients without an inline send request', async t => {
  const { campaign, rows } = install(t, 3);
  let clock = 0;
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100, {
    deadline: 38_000, now: () => clock,
    sendRecipient: async recipient => {
      clock += 100;
      rows.find(row => row.id === recipient.id).status = 'sent';
      return 'sent';
    },
  });
  assert.equal(result.batchSent, 3);
  assert.equal(result.remaining, 0);
  assert.equal(result.status, 'sent');
});
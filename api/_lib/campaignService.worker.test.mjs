import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

// This worker suite must never reach a real provider, even if an injected
// callback is accidentally omitted or misspelled.
const noNetwork = () => { throw new Error('Worker test attempted an unmocked network request'); };
mock.method(http, 'request', noNetwork);
mock.method(https, 'request', noNetwork);
mock.method(globalThis, 'fetch', noNetwork);

process.env.SUPABASE_URL = 'https://campaign-worker.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
const { supabase } = await import('./database.js');
const { sendBatch } = await import('./campaignService.js');
const { buildBulkEnvelope } = await import('./campaignBulkTransport.js');

test('actual worker splits oversized newsletters and later drains untouched recipients exactly once', async t => {
  const { campaign, rows } = install(t, 100);
  const previous = process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
  process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = 'true';
  t.after(() => {
    if (previous == null) delete process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
    else process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = previous;
  });
  campaign.delivery_transport = 'mailgun_batch_v1';
  campaign.is_test_mode = true;
  const submitted = new Set();
  let requests = 0;
  const options = {
    sendRecipient: async (recipient, _campaign, _tenant, _slug, _host, _design, _destination, opts) => {
      assert.equal(opts.prepareOnly, true);
      return { recipient, prepared: { domain: 'example.invalid', messageData: {
        from: 'sender@example.invalid', to: [recipient.email],
        html: 'Large newsletter '.repeat(6500), text: 'Plain text', 'o:testmode': 'yes',
      } } };
    },
    submitBulk: async (id, messages) => {
      const { messageData } = buildBulkEnvelope(id, messages);
      assert.equal(messageData['o:testmode'], 'yes');
      for (const address of messageData.to) {
        assert.ok(!submitted.has(address), 'No duplicate submission');
        submitted.add(address);
      }
      requests++;
      return { success: true, messageId: `batch-${requests}` };
    },
  };
  await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100, { ...options, deadline: Date.now() + 38000 });
  assert.equal(requests, 1);
  assert.ok(submitted.size > 1 && submitted.size < 100);
  assert.equal(rows.filter(r => r.status === 'pending').length, 100 - submitted.size);
  assert.equal(rows.filter(r => r.status === 'processing').length, 0);
  await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100, { ...options, deadline: Date.now() + 38000 });
  assert.equal(requests, 2);
  assert.equal(submitted.size, 100);
  assert.ok(rows.every(r => r.status === 'sent'));
});

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
      is(key, expected) { filters.push(row => row[key] === expected); return this; },
      in(key, expected) { filters.push(row => expected.includes(row[key])); return this; },
      not(key, _op, expected) { filters.push(row => row[key] !== expected); return this; },
      order() { return this; },
      limit(n) { limit = n; return this; },
      async single() { const result = await this; return { ...result, data: result.data[0] || null }; },
      async maybeSingle() { const result = await this; return { ...result, data: result.data[0] || null }; },
      then(resolve) {
        const source = table === 'email_campaign' ? [campaign] : table === 'email_address_bounce' ? [] : rows;
        const matching = source.filter(row => filters.every(filter => filter(row))).slice(0, limit);
        if (action === 'update') matching.forEach(row => Object.assign(row, value));
        return resolve({ data: head ? null : structuredClone(matching),
          count: countRequested ? matching.length : null, error: null });
      },
    };
    assert.ok(['email_campaign', 'email_campaign_recipient', 'email_address_bounce'].includes(table));
    return q;
  };
  t.after(() => { supabase.from = originalFrom; });
  return { campaign, rows };
}

test('real worker drains multiple 100-recipient bulk requests without a 100-per-minute cap', async t => {
  const { campaign, rows } = install(t, 250);
  const previous = process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
  process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = 'true';
  t.after(() => { if (previous == null) delete process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
    else process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = previous; });
  campaign.delivery_transport = 'mailgun_batch_v1';
  campaign.is_test_mode = true;
  const sizes = [];
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 800, {
    deadline: Date.now() + 38000,
    sendRecipient: async (recipient, ...args) => {
      assert.equal(args.at(-1).prepareOnly, true);
      return { recipient, prepared: { messageData: { to: [recipient.email] } } };
    },
    submitBulk: async (_id, messages) => { sizes.push(messages.length); return { success: true, messageId: 'batch' }; },
  });
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(result.batchSent, 250);
  assert.equal(result.remaining, 0);
  assert.ok(rows.every(row => row.status === 'sent'));
});

test('pinned bulk campaigns claim nothing when the switch is disabled', async t => {
  const { campaign, rows } = install(t, 3);
  campaign.delivery_transport = 'mailgun_batch_v1';
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100);
  assert.equal(result.success, false);
  assert.ok(rows.every(row => row.status === 'pending'));
});

test('test-only rollout cannot submit a bulk campaign after its test flag is cleared', async t => {
  const { campaign, rows } = install(t, 3);
  const previous = process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
  process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = 'true';
  t.after(() => { if (previous == null) delete process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED;
    else process.env.CAMPAIGN_MAILGUN_BATCH_ENABLED = previous; });
  campaign.delivery_transport = 'mailgun_batch_v1';
  campaign.is_test_mode = false;
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 100);
  assert.equal(result.success, false);
  assert.match(result.error, /Live bulk delivery/);
  assert.ok(rows.every(row => row.status === 'pending'));
});

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

test('actual worker batch defaults to eight overlapping slots with immutable render reuse', async t => {
  const { campaign, rows } = install(t, 12);
  let active = 0, peak = 0;
  const renderSnapshots = [];
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 10, {
    sendRecipient: async (recipient, ...args) => {
      const options = args.at(-1);
      renderSnapshots.push(options.batchRender);
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      rows.find(row => row.id === recipient.id).status = 'sent';
      active--;
      return 'sent';
    },
  });
  assert.equal(peak, 8);
  assert.equal(result.batchSent, 10);
  assert.equal(result.queued, 2);
  assert.ok(renderSnapshots.every(snapshot => snapshot === renderSnapshots[0] && Object.isFrozen(snapshot)));
});

test('default worker-scaled cap of 800 is shared across eight service slots, not per slot', async t => {
  const { campaign, rows } = install(t, 805);
  let active = 0, peak = 0;
  const sentIds = new Set();
  const result = await sendBatch('campaign', 'tenant', campaign, 'tenant', null, 800, {
    sendRecipient: async recipient => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sentIds.has(recipient.id), false);
      sentIds.add(recipient.id);
      rows.find(row => row.id === recipient.id).status = 'sent';
      active--;
      return 'sent';
    },
  });
  assert.equal(peak, 8);
  assert.equal(sentIds.size, 800);
  assert.equal(result.batchSent, 800);
  assert.equal(result.batchMetrics.attempted, 800);
  assert.equal(result.batchMetrics.stopReason, 'batch_cap');
  assert.equal(result.queued, 5);
  assert.ok(rows.every(row => row.status !== 'processing'));
});
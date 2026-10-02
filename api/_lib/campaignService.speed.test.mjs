import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { replacePlaceholders } from './emailService.js';
import { sanitizeSlotHtml, htmlSlotToPlainText } from './slotHtmlSanitizer.js';
import { campaignSendConcurrency } from './campaignDrain.js';

// Execute the real recipient implementation with explicit in-memory boundaries.
// The isolated runner additionally denies all network/DB/provider access.
const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
  .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
  .replace('const supabase = preparationDatabase(rawSupabase);', '')
  .replace(/export (async )?function /g, '$1function ');

function fixture({ providerResult = { success: true, messageId: '<accepted>' }, persistenceError = false, providerThrow = false, consentRevoked = false, groupRevoked = false } = {}) {
  const campaign = { id: 'campaign', status: 'sending', tenant_id: 'tenant',
    from_email: 'sender@example.invalid', html_content: '<p>Hello [[member.first_name]]</p>', subject: 'Subject' };
  const row = { id: 'recipient', member_id: 'member', first_name: 'Ada',
    email: 'ada@example.invalid', status: 'processing' };
  if (consentRevoked) campaign.preparation_generation = 'generation';
  if (groupRevoked) Object.assign(campaign, { member_group_id: 'group', preparation_actor_member_id: 'actor' });
  let orgReads = 0, providerCalls = 0;
  const payloads = [], releases = [], stops = [];
  const db = { from(table) {
    let updates;
    const query = {
      select() { return this; }, eq() { return this; }, in() { return this; },
      update(value) { updates = value; return this; },
      async single() {
        return { data: table === 'campaign_preparation_recipient' ? { recipient: { bypass_opt_out: false } } : campaign };
      },
      async maybeSingle() {
        assert.equal(table, 'member'); orgReads++;
        return { data: consentRevoked ? { communications_opted_out_all: true } :
          { organization: { id: 'org', name: 'Analytical Society', phone: '123' } } };
      },
      then(resolve) {
        assert.equal(table, 'email_campaign_recipient');
        if (persistenceError) return resolve({ error: new Error('Persistence unavailable') });
        Object.assign(row, updates);
        releases.push(updates.status);
        return resolve({ data: [row] });
      },
    };
    return query;
  } };
  const functions = vm.runInNewContext(`${source};({sendToRecipient, prepareCampaignBatchRender, campaignNeedsRecipientOrganization})`, {
    process: { env: {} }, crypto, Buffer, supabase: db,
    console: { log() {}, warn() {}, error() {} },
    prepareCampaignSurveyDelivery: async () => null,
    finishCampaignSurveyDelivery: async () => {},
    resolveCampaignAttendeeContent: async (_db, content) => ({ html: content.html_content, subject: content.subject }),
    resolveCampaignEventSurvey: async () => null,
    resolveCampaignEventSponsors: async () => null,
    getMemberEmsAccess: async () => ({ groups: [], error: 'Group authority revoked' }),
    requireGroupAccess: () => null,
    replacePlaceholders, sanitizeSlotHtml, htmlSlotToPlainText, isStandaloneCampaignPreferencePlaceholder: () => false,
    sendEmail: async payload => {
      providerCalls++; payloads.push(payload);
      if (providerThrow) throw new Error('Unknown transport outcome');
      return providerResult;
    },
  });
  return { campaign, row, payloads, releases, stops, functions,
    counts: () => ({ orgReads, providerCalls }),
    send: (options = {}, composition = {}, testDestination = null) => functions.sendToRecipient(row, campaign, 'tenant', 'fixture', null, composition, testDestination,
      { recheckBeforeProvider: true, stop: reason => stops.push(reason), ...options }),
  };
}

test('no organization tokens skips only enrichment; subject-only and HTML organization tokens still populate', async () => {
  for (const location of ['none', 'subject', 'html']) {
    const f = fixture();
    if (location === 'subject') f.campaign.subject = 'For [[organization.name]]';
    if (location === 'html') f.campaign.html_content += '<p>{{organization.phone}}</p>';
    assert.equal(await f.send(), 'sent');
    assert.equal(f.counts().orgReads, location === 'none' ? 0 : 1);
    assert.match(f.payloads[0].html, /Hello Ada/);
    if (location === 'subject') assert.equal(f.payloads[0].subject, 'For Analytical Society');
    if (location === 'html') assert.match(f.payloads[0].html, /<p>123<\/p>/);
  }
});

test('organization aliases conservatively retain enrichment and ordinary tokens do not', () => {
  const f = fixture();
  for (const token of ['[[organization.name]]', '{{organization_id}}', '[[member.organization_id]]',
    '[[record.phone]]', '{{name}}', '[[member.phone]]']) {
    assert.equal(f.functions.campaignNeedsRecipientOrganization('', token), true, token);
  }
  assert.equal(f.functions.campaignNeedsRecipientOrganization('[[member.email]] {{first_name}}', 'Hello'), false);
});

test('immutable render reuse retains hidden blocks, rich/plain slot escaping and recipient fidelity', async () => {
  const f = fixture();
  f.campaign.subject = '{{dynamic_1}} [[member.first_name]]';
  f.campaign.html_content = '<!-- DYN_BLOCK:START:dynamic_2 --><p>hidden</p><!-- DYN_BLOCK:END:dynamic_2 --><p>{{dynamic_1}} [[member.first_name]]</p>';
  const composition = { hiddenSlots: ['dynamic_2'], slotValues: { dynamic_1: 'A & B\nC', dynamic_2: 'secret' } };
  const batchRender = f.functions.prepareCampaignBatchRender(f.campaign, composition);
  assert.equal(Object.isFrozen(batchRender), true);
  assert.match(batchRender.html, /A &amp; B<br>C/);
  assert.doesNotMatch(batchRender.html, /hidden|secret/);
  assert.equal(await f.send({ batchRender }), 'sent');
  assert.match(f.payloads[0].html, /A &amp; B<br>C Ada/);
  assert.equal(f.payloads[0].subject, 'A & B\nC Ada');
  assert.match(batchRender.html, /\[\[member.first_name\]\]/);
});

test('cached and uncached rich-slot sends preserve identical sanitized content and subject', async () => {
  const f = fixture();
  f.campaign.subject = '{{dynamic_1}} [[member.first_name]]';
  f.campaign.html_content = '<p>{{dynamic_1}} [[member.first_name]]</p>';
  const composition = { richSlots: ['dynamic_1'], slotValues: { dynamic_1: '<strong>A &amp; B</strong><script>unsafe()</script>' } };
  assert.equal(await f.send({}, composition), 'sent');
  const batchRender = f.functions.prepareCampaignBatchRender(f.campaign, composition);
  assert.equal(await f.send({ batchRender }, composition), 'sent');
  assert.equal(f.payloads[0].html, f.payloads[1].html);
  assert.equal(f.payloads[0].subject, f.payloads[1].subject);
  assert.match(f.payloads[1].html, /<strong>A &amp; B<\/strong>/);
  assert.doesNotMatch(f.payloads[1].html, /script|unsafe/);
  assert.doesNotMatch(f.payloads[1].subject, /<strong>/);
});

test('shared stop after rendering prevents provider submission and safely releases unsent claim', async () => {
  const f = fixture();
  assert.equal(await f.send({ shouldStop: () => true }), 'stopped');
  assert.equal(f.counts().providerCalls, 0);
  assert.equal(f.row.status, 'pending');
});

for (const revoked of ['consentRevoked', 'groupRevoked']) {
  test(`fresh ${revoked} after personalization prevents provider submission`, async () => {
    const f = fixture({ [revoked]: true });
    assert.equal(await f.send(), 'stopped');
    assert.equal(f.counts().providerCalls, 0);
    assert.equal(f.row.status, revoked === 'consentRevoked' ? 'unsubscribed' : 'pending');
  });
}

test('definitive 429 marks failed without automatic replay and signals invocation stop; ambiguous 429 never releases', async () => {
  for (const ambiguousEffect of [false, true]) {
    const f = fixture({ providerResult: { success: false, rateLimited: true, ambiguousEffect, status: 429 } });
    assert.equal(await f.send(), ambiguousEffect ? 'processing' : 'rate_limited');
    assert.equal(f.row.status, ambiguousEffect ? 'processing' : 'failed');
    assert.deepEqual(f.stops, ['rate_limit']);
    assert.equal(f.counts().providerCalls, 1);
  }
});

test('source-recipient tests never mutate real delivery state on 429 or notSubmitted results', async () => {
  for (const providerResult of [
    { success: false, rateLimited: true, ambiguousEffect: false, status: 429, error: 'Rate limited' },
    { success: false, rateLimited: true, ambiguousEffect: true, status: 429, error: 'ETIMEDOUT' },
    { success: false, notSubmitted: true, error: 'Deadline exhausted before submission' },
  ]) {
    const f = fixture({ providerResult });
    assert.equal(await f.send({}, {}, 'reviewer@example.invalid'), providerResult);
    assert.equal(f.row.status, 'processing');
    assert.deepEqual(f.releases, []);
    assert.deepEqual(f.stops, []);
    assert.equal(f.payloads[0].to, 'reviewer@example.invalid');
    assert.equal(f.counts().providerCalls, 1);
  }
});

test('provider acceptance followed by persistence failure remains processing, never auto released', async () => {
  const f = fixture({ persistenceError: true });
  assert.equal(await f.send(), 'processing');
  assert.equal(f.row.status, 'processing');
  assert.deepEqual(f.releases, []);
  assert.equal(f.counts().providerCalls, 1);
});

test('provider timeout or unexpected postsubmission throw remains processing', async () => {
  for (const settings of [
    { providerResult: { success: false, ambiguousEffect: true, error: 'ETIMEDOUT' } },
    { providerThrow: true },
  ]) {
    const f = fixture(settings);
    assert.equal(await f.send(), 'processing');
    assert.equal(f.row.status, 'processing');
    assert.deepEqual(f.releases, []);
  }
});

test('confirmed ordinary provider rejection still marks failed; aggregate stage timings contain only numbers', async () => {
  const f = fixture({ providerResult: { success: false, error: 'Invalid recipient' } });
  let timings;
  assert.equal(await f.send({ onTiming: value => { timings = value; } }), 'failed');
  assert.equal(f.row.status, 'failed');
  assert.deepEqual(Object.keys(timings).sort(), ['renderMs', 'preProviderGateMs', 'providerMs', 'persistenceMs'].sort());
  assert.ok(Object.values(timings).every(value => typeof value === 'number' && value >= 0));
});

test('worker invocation stops at first rate-limited campaign instead of admitting next campaign', async () => {
  const campaigns = ['first', 'second'].map(id => ({ id, tenant_id: 'tenant', status: 'sending' }));
  const batchCalls = [];
  const batchCaps = [];
  const db = { from(table) {
    let status;
    const q = {
      select() { return this; }, order() { return this; },
      eq(key, value) { if (key === 'status') status = value; return this; },
      async single() { return { data: { slug: 'fixture' } }; },
      then(resolve) { return resolve({ data: table === 'email_campaign' ? campaigns : null,
        count: table === 'email_campaign_recipient' && status === 'pending' ? 2 : 0 }); },
    };
    return q;
  } };
  const { processSendingCampaigns } = vm.runInNewContext(`${source};
    recoverStuckPreparingCampaigns = async () => {};
    getCampaign = async id => ({success: true, campaign: campaigns.find(row => row.id === id)});
    sendBatch = async (id, _tenant, _campaign, _slug, _host, cap, options) => {
      batchCalls.push(id); batchCaps.push({cap, concurrency: options.concurrency, deadline: options.deadline});
      return { batchMetrics: {stopReason: 'rate_limit'}, remaining: 2 };
    };
    ({processSendingCampaigns});`, {
    process: { env: {} }, crypto, Buffer, supabase: db, campaigns, batchCalls, batchCaps, campaignSendConcurrency,
    console: { log() {}, warn() {}, error() {} },
    resolveCampaignEventSurvey: async () => null,
  });
  const deadline = Date.now() + 10_000;
  const result = await processSendingCampaigns({ deadline });
  assert.deepEqual(batchCalls, ['first']);
  assert.equal(result.stopReason, 'rate_limit');
  assert.deepEqual(structuredClone(batchCaps), [{ cap: 200, concurrency: 2, deadline }]);
  for (const [input, concurrency, cap] of [[1, 1, 100], [4, 4, 400], [99, 4, 400], [0, 1, 100]]) {
    batchCaps.length = 0;
    await processSendingCampaigns({ deadline, concurrency: input });
    assert.deepEqual(structuredClone(batchCaps), [{ cap, concurrency, deadline }]);
  }
});
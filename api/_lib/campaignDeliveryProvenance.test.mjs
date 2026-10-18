import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { persistCampaignDeliveryProvenance, verifyCampaignDeliveryProvenance } from './campaignDeliveryProvenance.js';
import { sendEmail, sendPreparedCampaignBatch, replacePlaceholders } from './emailService.js';
import { finishPreparedCampaignBatch } from './campaignBulkDrain.js';

function fixture(size = 1) {
  const rows = Array.from({ length: size }, (_, i) => ({
    id: `r${i}`, campaign_id: 'campaign', email: `r${i}@example.invalid`,
    status: 'processing', delivery_is_test: null,
  }));
  const state = { writeError: false, readError: false, writes: 0, reads: 0 };
  const db = { from(table) {
    assert.equal(table, 'email_campaign_recipient');
    let updates;
    const filters = [];
    const q = {
      update(value) { updates = value; return q; }, select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      is(key, value) { return q.eq(key, value); },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      async maybeSingle() { const result = await q; return { ...result, data: result.data?.[0] }; },
      then(resolve) {
        const error = updates ? state.writeError : state.readError;
        if (updates) state.writes++; else state.reads++;
        if (error) return resolve({ error: { message: 'Database unavailable' } });
        const matching = rows.filter(row => filters.every(filter => filter(row)));
        if (updates) matching.forEach(row => Object.assign(row, updates));
        return resolve({ data: structuredClone(matching), error: null });
      },
    };
    return q;
  } };
  return { rows, state, db, entries: rows.map(recipient => ({ recipient })),
    persist: message => persistCampaignDeliveryProvenance(db, 'campaign', rows.map(recipient => ({ recipient })), message) };
}

const baseMessage = { to: 'r0@example.invalid', subject: 'Subject', html: '<p>Body</p>',
  skipFooter: true, resolveTransactionalPreferences: false };
function mailDependencies(beforeSubmit, create) {
  return { beforeSubmit, client: { messages: { create } },
    defaultDomain: 'fallback.invalid', getTenantEmailConfig: async () => ({ domain: 'tenant.invalid' }) };
}

for (const isTest of [true, false]) {
  test(`individual exact envelope persists ${isTest} before provider and survives timeout`, async () => {
    const f = fixture();
    const result = await sendEmail({ ...baseMessage, testMode: isTest },
      mailDependencies(f.persist, async (_domain, envelope) => {
        assert.equal(f.rows[0].delivery_is_test, isTest);
        assert.equal(envelope['o:testmode'] === 'yes', isTest);
        throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }));
    assert.equal(result.ambiguousEffect, true);
    assert.equal(f.rows[0].delivery_is_test, isTest);
    assert.equal(f.rows[0].status, 'processing');
  });
}

for (const failure of ['writeError', 'readError', 'lostClaim', 'mismatch']) {
  test(`${failure} fails closed before individual and bulk provider calls`, async () => {
    for (const bulk of [false, true]) {
      const f = fixture();
      if (failure === 'lostClaim') f.rows[0].status = 'pending';
      else if (failure === 'mismatch') f.rows[0].delivery_is_test = false;
      else f.state[failure] = true;
      const deps = mailDependencies(f.persist, () => assert.fail('Provider must not be called'));
      const result = bulk
        ? await sendPreparedCampaignBatch('campaign', [{ domain: 'tenant.invalid', messageData: {
          from: 'sender@example.invalid', to: [baseMessage.to], subject: 'Subject', html: 'Body', text: 'Body', 'o:testmode': 'yes',
        } }], null, deps)
        : await sendEmail({ ...baseMessage, testMode: true }, deps);
      assert.equal(result.notSubmitted, true);
      assert.equal(result.provenanceError, true);
      assert.match(result.error, /provenance/i);
    }
  });
}

test('fallback domain re-verifies unchanged envelope provenance before its submission', async () => {
  const f = fixture();
  let calls = 0;
  const result = await sendEmail({ ...baseMessage, testMode: true },
    mailDependencies(f.persist, async (domain, envelope) => {
      calls++;
      assert.equal(f.rows[0].delivery_is_test, true);
      assert.equal(envelope['o:testmode'], 'yes');
      assert.equal(f.state.reads, calls);
      if (domain === 'tenant.invalid') throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return { id: '<accepted>' };
    }));
  assert.equal(result.success, true);
  assert.equal(result.fallback, true);
  assert.equal(calls, 2);
});

test('bulk provenance survives acceptance followed by failed sent-state persistence', async () => {
  const f = fixture(3);
  const entries = f.entries.map(entry => ({ ...entry, prepared: { domain: 'tenant.invalid', messageData: {
    from: 'sender@example.invalid', to: [entry.recipient.email], subject: 'Subject', html: 'Body', text: 'Body',
  } } }));
  const result = await finishPreparedCampaignBatch({
    entries, gate: async () => ({ allowed: true }), revalidate: async () => 'ready',
    release: () => assert.fail('Possibly accepted recipients must not be released'),
    submit: ready => sendPreparedCampaignBatch('campaign', ready.map(entry => entry.prepared), null,
      mailDependencies(f.persist, async () => {
        assert.ok(f.rows.every(row => row.delivery_is_test === false));
        return { id: '<batch>' };
      })),
    persist: async () => { throw new Error('Sent-state persistence failed'); },
  });
  assert.equal(result.processing, 3);
  assert.ok(f.rows.every(row => row.delivery_is_test === false && row.status === 'processing'));
  for (const row of f.rows) await verifyCampaignDeliveryProvenance(f.db, 'campaign', row.id);
});

test('bulk ambiguous test-mode submission preserves provenance through later reconciliation', async () => {
  const f = fixture(2);
  const messages = f.rows.map(row => ({ domain: 'tenant.invalid', messageData: {
    from: 'sender@example.invalid', to: [row.email], subject: 'Subject', html: 'Body', text: 'Body', 'o:testmode': 'yes',
  } }));
  const result = await sendPreparedCampaignBatch('campaign', messages, null,
    mailDependencies(f.persist, async () => {
      assert.ok(f.rows.every(row => row.delivery_is_test === true));
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }));
  assert.equal(result.ambiguousEffect, true);
  for (const row of f.rows) await verifyCampaignDeliveryProvenance(f.db, 'campaign', row.id);
  assert.ok(f.rows.every(row => row.delivery_is_test === true));
});

test('bulk provenance refusal releases unsubmitted claims and reports an explicit error', async () => {
  const f = fixture();
  f.state.writeError = true;
  const result = await finishPreparedCampaignBatch({
    entries: f.entries, gate: async () => ({ allowed: true }), revalidate: async () => 'ready',
    release: async entries => entries.forEach(entry => { entry.recipient.status = 'pending'; }),
    submit: () => sendPreparedCampaignBatch('campaign', [{ domain: 'tenant.invalid', messageData: {
      from: 'sender@example.invalid', to: [baseMessage.to], subject: 'Subject', html: 'Body', text: 'Body',
    } }], null, mailDependencies(f.persist, () => assert.fail('No provider call'))),
    persist: () => assert.fail('No provider outcome to persist'),
  });
  assert.equal(result.stopReason, 'provenance_error');
  assert.match(result.error, /Database unavailable/);
  assert.equal(f.rows[0].status, 'pending');
  assert.equal(f.rows[0].delivery_is_test, null);
});

test('reconciliation refuses unknown provenance rather than inferring from campaign', async () => {
  const f = fixture();
  await assert.rejects(verifyCampaignDeliveryProvenance(f.db, 'campaign', 'r0'), /provenance/);
  f.rows[0].delivery_is_test = true;
  await verifyCampaignDeliveryProvenance(f.db, 'campaign', 'r0');
  assert.equal(f.state.writes, 0);
});

const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
  .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
  .replace('const supabase = preparationDatabase(rawSupabase);', '')
  .replace(/export (async )?function /g, '$1function ');

function recipientFixture({ alreadyAccepted = false } = {}) {
  const f = fixture();
  const campaign = { id: 'campaign', html_content: 'Body', subject: 'Subject', from_email: 'sender@example.invalid', is_test_mode: true };
  const envelopes = [];
  const { sendToRecipient, campaignRecipientTestMode } = vm.runInNewContext(`${source};({ sendToRecipient, campaignRecipientTestMode })`, {
    process: { env: {} }, Buffer, crypto, supabase: f.db,
    console: { log() {}, warn() {}, error() {} },
    persistCampaignDeliveryProvenance, verifyCampaignDeliveryProvenance, replacePlaceholders,
    prepareCampaignSurveyDelivery: async () => alreadyAccepted ? { alreadyAccepted: true } : null,
    finishCampaignSurveyDelivery: async () => {},
    resolveCampaignAttendeeContent: async (_db, content) => ({ html: content.html_content, subject: content.subject }),
    resolveCampaignEventSurvey: async () => null, resolveCampaignEventSponsors: async () => null,
    campaignAddressSuppressed: async () => false,
    sendEmail: (payload, dependencies) => sendEmail(payload, {
      ...mailDependencies(null, async (_domain, envelope) => { envelopes.push(structuredClone(envelope)); return { id: '<accepted>' }; }),
      getEmailFooter: async () => null, ...dependencies,
    }),
  });
  return { ...f, campaign, envelopes, campaignRecipientTestMode,
    send: destination => sendToRecipient(f.rows[0], campaign, 'tenant', 'tenant', null, { skipFooter: true }, destination) };
}

for (const originalMode of [true, false]) test(`retry keeps original ${originalMode} mode after campaign edit`, async () => {
  const f = recipientFixture();
  f.rows[0].delivery_is_test = originalMode;
  f.campaign.is_test_mode = !originalMode;
  assert.equal(await f.send(), 'sent');
  assert.equal(f.envelopes[0]['o:testmode'] === 'yes', originalMode);
  assert.equal(f.rows[0].delivery_is_test, originalMode);
});

for (const alreadyAccepted of [true, false]) test(`explicit test destination never mutates source recipient (accepted=${alreadyAccepted})`, async () => {
  const f = recipientFixture({ alreadyAccepted });
  const before = structuredClone(f.rows);
  const result = await f.send('reviewer@example.invalid');
  assert.equal(result.success, true);
  assert.deepEqual(f.rows, before);
  assert.equal(f.state.writes, 0);
  if (!alreadyAccepted) {
    assert.deepEqual(f.envelopes[0].to, ['reviewer@example.invalid']);
    assert.equal(f.envelopes[0]['o:testmode'], undefined);
  }
});

test('accepted-survey reconciliation preserves historical test provenance after campaign edit', async () => {
  const f = recipientFixture({ alreadyAccepted: true });
  f.rows[0].delivery_is_test = true;
  f.campaign.is_test_mode = false;
  assert.equal(await f.send(), 'sent');
  assert.equal(f.rows[0].delivery_is_test, true);
  assert.equal(f.envelopes.length, 0);
});

test('accepted-survey reconciliation with unknown provenance stays processing', async () => {
  const f = recipientFixture({ alreadyAccepted: true });
  assert.equal(await f.send(), 'processing');
  assert.equal(f.rows[0].status, 'processing');
  assert.equal(f.rows[0].delivery_is_test, null);
  assert.equal(f.state.writes, 0);
  assert.equal(f.envelopes.length, 0);
});

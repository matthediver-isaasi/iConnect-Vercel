// One-incident, DEST-only recovery. This runner has no email-sending capability.
// Default: read-only plan. Apply requires the exact printed evidence-plan hash.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { verifyDeliveredCampaignMessage } from './lib/campaign-delivery-evidence.mjs';

process.umask(0o077);
const directory = 'generated-artifacts/campaign-incident';
const campaignId = 'ad9d4071-e1ec-469f-aebc-1cf689a41041';
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const ids = [
  '180d9f75-f798-4bea-b5dc-8ec3d8f6a843', '18119980-b81a-4faf-9bda-8bd0c93ebe0c',
  '1811f2a9-fc18-4265-9f5e-62025e02c99a', '184e6af1-a103-4a8b-903d-6fb9ad15c0c6',
  '1851712b-39cf-4f70-baca-36ffeaf37446', '1867beed-52a5-4838-9294-9af198c84669',
  '18a1240e-5ca4-496b-9568-a931bd05f007', '18a74f1f-c93e-470b-9d5a-b0b2dc4adfcd',
  'befd8cc9-1a7a-4992-822e-6100559f107c', 'befee2ec-4619-412a-b00e-b918271398f8',
  'bf083d3f-30d2-4630-bbe9-adad1ba8711b', 'bf0d3088-8dc5-4020-ac0c-2129863bccad',
  'bf1bd4f1-46dc-4d9a-b855-eac1b10c0b40', 'bf2681c9-655f-4a61-9000-cfb62c66c3b1',
  'bf2cdf7b-4ba4-4f05-bf1d-e47c415a4630',
].sort();
const read = file => JSON.parse(fs.readFileSync(`${directory}/${file}`, 'utf8'));
const hash = data => createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => assert.deepEqual(canonical(a), canonical(b));
const write = (file, value) => fs.writeFileSync(`${directory}/${file}`, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
const original = read('evidence.json');
const access = read('reconciliation-access.json');
const provider = read('reconciliation-events.json');
const identities = read('reconciliation-identities.json');
assert.equal(original.campaign.id, campaignId);
assert.equal(original.campaign.tenant_id, tenantId);
same(access.recipients.map(r => r.id).sort(), ids);
same(provider.recipients.filter(r => !r.control).map(r => r.recipientId).sort(), ids);
same(identities.messages.filter(r => !r.control).map(r => r.recipientId).sort(), ids);
const repairs = ids.map(id => {
  const raw = fs.readFileSync(`${directory}/stored-message-${id}.json`, 'utf8');
  const identity = identities.messages.find(r => r.recipientId === id);
  assert.equal(hash(raw), identity.storedMessageSha256, 'Stored provider message changed');
  const result = verifyDeliveredCampaignMessage({
    campaign: original.campaign, recipient: access.recipients.find(r => r.id === id),
    events: provider.recipients.find(r => r.recipientId === id).events,
    message: JSON.parse(raw), linkHost: 'graduatefutures.org',
  });
  assert.equal(result.messageId, identity.messageId);
  return { ...result, storedMessageSha256: hash(raw) };
});
assert.equal(new Set(repairs.map(r => r.messageId)).size, 15, 'Repeated message identity');
const eventIds = repairs.flatMap(r => r.events.map(e => e.id));
assert.equal(new Set(eventIds).size, eventIds.length, 'Repeated event identity');
const schema = read('reconciliation-schema.json');
// One historical sync row attributed this provider event to a different
// campaign. Preserve it byte-for-byte; repairing that campaign is out of scope.
// Correct-scope evidence can coexist: provider ID is not globally unique here.
const existingRaw = fs.readFileSync(`${directory}/reconciliation-existing-evidence.json`, 'utf8');
assert.equal(hash(existingRaw), '2b58c950b2982d303811bc911a4936bd6bbef9c7b96019aff78c2b814f342e1c');
const existingOtherCampaignEvidence = JSON.parse(existingRaw);
assert.ok(existingOtherCampaignEvidence.every(row => row.campaign_id !== campaignId));
const planHash = hash({ campaignId, tenantId, repairs, baseline: access.recipients,
  triggers: schema.triggers, existingOtherCampaignEvidence });
const args = process.argv.slice(2);
assert.ok(args.length <= 1, 'Only one optional --apply=<planHash> argument is supported');
const applying = args.length === 1;
if (applying) assert.equal(args[0], `--apply=${planHash}`, 'An exact evidence plan hash is required');

const db = await connectDestination();
const audit = { capturedAt: new Date().toISOString(), campaignId, tenantId, planHash, applying, providerSends: 0, sourceAccess: false };
const stamp = audit.capturedAt.replaceAll(':', '-');
let committed = false;
try {
  await db.query(applying ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  const campaign = (await db.query(`select to_jsonb(c) as row from email_campaign c
    where id=$1 and tenant_id=$2 ${applying ? 'for update' : ''}`, [campaignId, tenantId])).rows[0]?.row;
  assert.ok(campaign, 'Campaign not found in pinned tenant');
  assert.equal(campaign.subject, original.campaign.subject);
  assert.equal(campaign.archived_at, null, 'Archived campaign requires separate decision');
  assert.ok(['sending', 'sent'].includes(campaign.status), 'Operator stop/changed campaign state');
  if (applying) {
    // Parent locks serialize new claims. Freeze its rows while checking totals.
    await db.query('select id from email_campaign_recipient where campaign_id=$1 order by id for update', [campaignId]);
    // Existing schema has no unique event-ID constraint. Briefly exclude event
    // writers so the evidence check and insert are atomic without a migration.
    await db.query('LOCK TABLE email_event IN SHARE ROW EXCLUSIVE MODE');
  }
  const triggers = (await db.query(`select c.relname,pg_get_triggerdef(t.oid) as trigger,
    pg_get_functiondef(t.tgfoid) as function from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname in ('email_campaign','email_campaign_recipient','email_event') and not t.tgisinternal
    order by c.relname,t.tgname`)).rows;
  same(triggers, schema.triggers);
  const snapshot = async () => {
    const recipients = (await db.query(`select to_jsonb(r) as row from email_campaign_recipient r
      where campaign_id=$1 and id=any($2::uuid[]) order by id`, [campaignId, ids])).rows.map(r => r.row);
    const totals = (await db.query(`select count(*)::int as total,
      count(*) filter(where status in ('pending','processing','sending'))::int as unresolved,
      count(*) filter(where status in ('sent','delivered','opened','clicked'))::int as sent,
      count(*) filter(where status in ('delivered','opened','clicked'))::int as delivered,
      count(*) filter(where open_count>0)::int as opened,
      count(*) filter(where status='cancelled')::int as cancelled,
      md5(string_agg(to_jsonb(r)::text,',' order by id) filter(where not(id=any($2::uuid[])))) as other_rows_hash
      from email_campaign_recipient r where campaign_id=$1`, [campaignId, ids])).rows[0];
    const events = (await db.query(`select to_jsonb(e) as row from email_event e
      where (campaign_id=$1 and recipient_id=any($2::uuid[])) or mailgun_event_id=any($3::text[])
      order by mailgun_event_id,id`, [campaignId, ids, eventIds])).rows.map(r => r.row);
    return { recipients, totals, events };
  };
  audit.before = { campaign, ...await snapshot() };
  same(audit.before.recipients.map(row => row.id).sort(), ids);
  same(audit.before.events.filter(row => row.campaign_id !== campaignId), existingOtherCampaignEvidence);
  assert.equal(audit.before.totals.total, 4991, 'Campaign audience changed');
  const recovered = audit.before.recipients.every(row => {
    const repair = repairs.find(r => r.recipientId === row.id);
    return row.mailgun_message_id === repair.messageId && row.sent_at && row.delivery_outcome === 'delivered' && row.delivery_is_test === false;
  });
  if (recovered) {
    for (const row of audit.before.recipients) {
      const repair = repairs.find(r => r.recipientId === row.id);
      assert.equal(new Date(row.sent_at).toISOString(), repair.sentAt);
      assert.equal(new Date(row.delivered_at).toISOString(), repair.deliveredAt);
      assert.equal(new Date(row.delivery_outcome_at).toISOString(), repair.deliveredAt);
      for (const event of repair.events) {
        const matches = audit.before.events.filter(e => e.campaign_id === campaignId && e.mailgun_event_id === event.id);
        assert.equal(matches.length, 1, 'Missing/duplicate stored provider evidence');
        assert.equal(matches[0].recipient_id, row.id);
        assert.equal(matches[0].campaign_id, campaignId);
        assert.equal(matches[0].mailgun_message_id, repair.messageId);
      }
    }
    assert.equal(audit.before.totals.unresolved, 0);
    assert.equal(campaign.status, 'sent');
    assert.equal(campaign.sent_count, audit.before.totals.sent);
    assert.equal(campaign.delivered_count, audit.before.totals.delivered);
    assert.equal(campaign.opened_count, audit.before.totals.opened);
    await db.query('ROLLBACK');
    audit.result = 'verified_already_reconciled_zero_writes';
    write(`reconciliation-verification-${stamp}.json`, audit);
    console.log(JSON.stringify({ result: audit.result, planHash, recipients: 15, events: eventIds.length, databaseWrites: 0, providerSends: 0 }));
  } else {
    assert.equal(campaign.status, 'sending');
    same(audit.before.recipients, [...access.recipients].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(audit.before.totals.unresolved, 15, 'Other queued/processing work exists');
    assert.equal(audit.before.events.filter(row => row.campaign_id === campaignId).length, 0, 'Existing target evidence requires separate review');
    assert.ok(audit.before.recipients.every(r => r.status === 'processing' && r.sent_at === null &&
      r.mailgun_message_id === null && r.delivery_is_test === null && r.delivery_outcome === null));
    write(`reconciliation-before-${stamp}.json`, audit);
    if (!applying) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ result: 'read_only_plan', planHash, recipients: 15, events: eventIds.length,
        totalsBefore: audit.before.totals, databaseWrites: 0, providerSends: 0 }));
    } else {
      const patches = repairs.map(r => ({ id: r.recipientId, message_id: r.messageId, sent_at: r.sentAt,
        delivered_at: r.deliveredAt, opened_at: r.openedAt, open_count: r.openCount }));
      const updated = await db.query(`update email_campaign_recipient r set mailgun_message_id=p.message_id,
        sent_at=p.sent_at, delivery_is_test=false, status=case when p.opened_at is null then 'sent' else 'opened' end,
        opened_at=p.opened_at, open_count=p.open_count
        from jsonb_to_recordset($1::jsonb) as p(id uuid,message_id text,sent_at timestamptz,
          delivered_at timestamptz,opened_at timestamptz,open_count integer)
        where r.id=p.id and r.campaign_id=$2 and r.status='processing' and r.sent_at is null
          and r.mailgun_message_id is null and r.delivery_is_test is null returning r.id`,
      [JSON.stringify(patches), campaignId]);
      assert.equal(updated.rowCount, 15, 'Recipient compare-and-set failed');
      const rows = repairs.flatMap(repair => repair.events.map(event => ({
        id: randomUUID(), tenant_id: tenantId, campaign_id: campaignId, recipient_id: repair.recipientId,
        member_id: audit.before.recipients.find(r => r.id === repair.recipientId).member_id,
        event_type: event.event, email: event.recipient, mailgun_message_id: repair.messageId, mailgun_event_id: event.id,
        delivery_status_code: event['delivery-status']?.code ?? null,
        delivery_status_message: event['delivery-status']?.message ?? null,
        raw_event: { ...event, _iconnect_verified_provider: true,
          _iconnect_reconciliation: { plan_sha256: planHash, stored_message_sha256: repair.storedMessageSha256 } },
        event_timestamp: new Date(event.timestamp * 1000).toISOString(),
      })));
      const inserted = await db.query(`insert into email_event
        (id,tenant_id,campaign_id,recipient_id,member_id,event_type,email,mailgun_message_id,mailgun_event_id,
         delivery_status_code,delivery_status_message,raw_event,event_timestamp)
        select id,tenant_id,campaign_id,recipient_id,member_id,event_type,email,mailgun_message_id,mailgun_event_id,
         delivery_status_code,delivery_status_message,raw_event,event_timestamp
        from jsonb_populate_recordset(null::email_event,$1::jsonb) returning id`, [JSON.stringify(rows)]);
      assert.equal(inserted.rowCount, rows.length, 'Evidence insert count mismatch');
      audit.after = await snapshot();
      same(audit.after.events.filter(row => row.campaign_id !== campaignId), existingOtherCampaignEvidence);
      assert.equal(audit.after.events.filter(row => row.campaign_id === campaignId).length, rows.length);
      assert.equal(audit.after.totals.other_rows_hash, audit.before.totals.other_rows_hash, 'Non-target recipient changed');
      assert.equal(audit.after.totals.unresolved, 0);
      assert.equal(audit.after.totals.total, 4991);
      assert.equal(audit.after.totals.cancelled, audit.before.totals.cancelled);
      const allowed = new Set(['mailgun_message_id', 'sent_at', 'delivery_is_test', 'status', 'opened_at', 'open_count',
        'delivery_outcome', 'delivery_outcome_at', 'delivery_reason', 'delivered_at', 'bounced_at', 'error_message']);
      for (const row of audit.after.recipients) {
        const before = audit.before.recipients.find(r => r.id === row.id);
        const repair = repairs.find(r => r.recipientId === row.id);
        for (const key of Object.keys(row)) if (!allowed.has(key)) same(row[key], before[key]);
        assert.equal(row.mailgun_message_id, repair.messageId);
        assert.equal(row.delivery_is_test, false);
        assert.equal(row.delivery_outcome, 'delivered');
        assert.equal(row.status, repair.openCount ? 'opened' : 'delivered');
        assert.equal(new Date(row.sent_at).toISOString(), repair.sentAt);
        assert.equal(new Date(row.delivered_at).toISOString(), repair.deliveredAt);
        assert.equal(row.open_count, repair.openCount);
      }
      const finalized = await db.query(`update email_campaign set status='sent',sent_count=$3,
        delivered_count=$4,opened_count=$5,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=$1 and tenant_id=$2 and status='sending' returning to_jsonb(email_campaign) as row`,
      [campaignId, tenantId, audit.after.totals.sent, audit.after.totals.delivered, audit.after.totals.opened]);
      assert.equal(finalized.rowCount, 1, 'Campaign finalization failed');
      audit.after.campaign = finalized.rows[0].row;
      const campaignAllowed = new Set(['status', 'sent_count', 'delivered_count', 'opened_count', 'completed_at', 'updated_at']);
      for (const key of Object.keys(campaign)) if (!campaignAllowed.has(key)) same(campaign[key], audit.after.campaign[key]);
      write(`reconciliation-precommit-${stamp}.json`, audit);
      await db.query('COMMIT');
      committed = true;
      audit.result = 'committed';
      write(`reconciliation-committed-${stamp}.json`, audit);
      console.log(JSON.stringify({ result: audit.result, planHash, recipientsRepaired: 15, evidenceInserted: rows.length,
        campaignStatus: audit.after.campaign.status, totalsAfter: audit.after.totals, providerSends: 0, sourceAccess: false }));
    }
  }
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => {});
  // Raw DB errors can contain private data; retain them only in the ignored audit.
  write(`reconciliation-error-${stamp}.json`, { ...audit, error: error.message, committed });
  console.error(`Reconciliation ${committed ? 'committed; audit failure requires verification' : 'not committed'}; see private audit.`);
  process.exitCode = 1;
} finally {
  await db.end();
}

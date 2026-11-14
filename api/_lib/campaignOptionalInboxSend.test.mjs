import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { drainCampaignRecipients } from './campaignDrain.js';

// Load the real orchestration with an inert database and composition boundary.
// Any attempt to send (rather than compose) is a test failure.
const key = '__optionalInboxSendFixture';
let source = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
source = source.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, new URL('./campaignService.js', import.meta.url)).href}'`)
  .replace(/import \{ supabase as rawSupabase \} from '[^']+';/, `const rawSupabase = globalThis.${key}.db;`)
  .replace(/import \{ sendEmail, replacePlaceholders, sendPreparedCampaignBatch \} from '[^']+';/,
    `const sendEmail = (...args) => globalThis.${key}.compose(...args);
     const replacePlaceholders = html => html;
     const sendPreparedCampaignBatch = () => { throw new Error('Unexpected provider batch'); };`);

async function fixture({ prepared = true, testMode = false, paused = false, external = false } = {}) {
  const recipient = { id: 'recipient', member_id: 'member', email: 'member@example.invalid',
    first_name: 'Fixture', status: 'processing', delivery_is_test: null };
  const campaign = { id: 'campaign', tenant_id: 'tenant', status: 'sending',
    subject: 'Hello {{first_name}}', html_content: '<p>For {{first_name}}</p>',
    from_email: 'sender@example.invalid', deliver_to_inbox_when_opted_out: true,
    ignore_opt_outs: true, is_test_mode: testMode,
    ...(prepared ? { preparation_generation: 'generation' } : {}) };
  const f = { recipient, campaign, compositions: 0, publications: 0 };
  if (external) {
    recipient.member_id = null;
    campaign.communication_category_id = 'category';
  }
  const tables = {
    email_campaign: [{ ...campaign, ...(paused ? { status: 'paused' } : {}) }],
    campaign_preparation_recipient: [{ recipient_id: recipient.id, generation: 'generation',
      recipient: { inbox_only: !external, bypass_opt_out: true } }],
    member: [{ id: 'member', tenant_id: 'tenant', email: recipient.email,
      communications_opted_out_all: !external, login_enabled: true }],
    communication_category: [], member_communication_preference: [],
    email_unsubscribe: [], email_address_bounce: [], email_campaign_recipient: [recipient],
  };
  f.db = {
    from(table) {
      assert.ok(table in tables, `Unexpected database read: ${table}`);
      const filters = []; let single = false, patch;
      const q = {
        select() { return q; }, limit() { return q; },
        eq(k,v) { filters.push(r => r[k] === v); return q; },
        in(k,v) { filters.push(r => v.includes(r[k])); return q; },
        is(k,v) { filters.push(r => r[k] === v); return q; },
        filter() { return q; }, or() { return q; },
        single() { single = true; return q; }, maybeSingle() { single = true; return q; },
        update(value) { patch = value; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const rows = tables[table].filter(r => filters.every(fn => fn(r)));
            if (patch) rows.forEach(r => Object.assign(r,patch));
            return { data: single ? rows[0] : rows, error: null };
          }).then(resolve,reject);
        },
      };
      return q;
    },
    async rpc(name,args) {
      assert.equal(name,'publish_campaign_inbox_only');
      assert.equal(args.p_tenant,'tenant');
      assert.equal(args.p_recipient,recipient.id);
      assert.equal(args.p_subject,'Hello Fixture');
      assert.match(args.p_html,/For Fixture/);
      f.publications++;
      recipient.inbox_published_at = new Date().toISOString();
      recipient.status = 'unsubscribed';
      return { data: true };
    },
  };
  f.compose = async (content, options) => {
    assert.equal(options.prepareOnly,true,'Excluded recipients must never enter email transport');
    f.compositions++;
    return { prepared: { messageData: { subject: content.subject,html:content.html } } };
  };
  globalThis[key] = f;
  const service = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`);
  f.send = () => service.sendToRecipient(recipient,campaign,'tenant','fixture',null,{ skipFooter:true });
  return f;
}

for (const prepared of [true,false]) test(`real send orchestration publishes without provider, prepared=${prepared}`,async () => {
  const f = await fixture({ prepared });
  assert.equal(await f.send(),'inbox_only');
  assert.equal(f.publications,1);
  assert.equal(await f.send(),'inbox_only');
  assert.equal(f.publications,1);
  assert.equal(f.compositions,1);
  assert.equal(f.recipient.sent_at,undefined);
});
test('test-mode exclusions never publish or submit email',async () => {
  const f = await fixture({ testMode:true });
  assert.equal(await f.send(),'stopped');
  assert.equal(f.publications,0);
  assert.equal(f.compositions,0);
});
for (const prepared of [true,false]) test(`external row cannot email a category-excluded member address, prepared=${prepared}`,async () => {
  const f = await fixture({ prepared, external:true });
  assert.equal(await f.send(),'stopped');
  assert.equal(f.recipient.status,'unsubscribed');
  assert.equal(f.publications,0,'external rows do not acquire member inbox authority');
  assert.equal(f.compositions,0,'provider transport must not run');
});
test('pause during rendering prevents inbox publication',async () => {
  const f = await fixture({ paused:true });
  assert.equal(await f.send(),'stopped');
  assert.equal(f.publications,0);
});
test('inbox-only outcomes drain all work without counting sent emails',async () => {
  let remaining=8;
  const result=await drainCampaignRecipients({
    batchSize:100,concurrency:1,claim:async()=>remaining-- > 0 ? [{id:remaining}] : [],
    gate:async()=>({allowed:true}),release:async()=>assert.fail(),
    send:async()=> 'inbox_only',
  });
  assert.equal(result.sent,0);
  assert.equal(result.failed,0);
  assert.equal(result.metrics.claimed,8);
});

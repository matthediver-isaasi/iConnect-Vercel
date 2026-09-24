import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolveCampaignEventSurvey, replaceEventSurvey } from '../_lib/campaignEventSurvey.js';

// Execute the actual endpoint/access code with hermetic dependencies: no service
// module imports, database connections, or email transports are loaded.
async function load(path, dependencies, exports) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export default async function handler/, 'async function handler')
    .replace(/export (async )?function /g, '$1function ');
  return vm.runInNewContext(`${source}\n;({${exports.join(',')}})`, { ...dependencies, console });
}

async function fixture(options = {}) {
  const calls = [];
  const campaign = {
    id: 'campaign', tenant_id: 'tenant', member_group_id: 'group',
    created_by_member_id: 'original-author', status: 'draft', name: 'Newsletter',
    updated_at: '2026-01-01T12:00:00.000Z',
    subject: 'Hello', email_template_id: 'template', from_email: 'verified@example.org',
    design_json: { slotValues: { title: 'Hi' }, hiddenSlots: ['optional'], richSlots: ['title'] },
    target_audiences: [{ type: 'member_group', ids: ['group'], roles: ['Member'] }],
    ...options.campaign,
  };
  const tables = {
    email_campaign: [campaign],
    email_campaign_recipient: options.recipients || [],
    member_group_assignment: [{
      member_id: 'other-admin', group_id: 'group', group_role: 'Member',
      is_group_admin: true, expires_at: null, ...options.assignment,
    }],
    member_group: [{
      id: 'group', tenant_id: 'tenant', name: 'Group', is_active: true,
      roles: ['Member'], classification_id: 'classification', ...options.group,
    }],
    email_template: [{ id: 'template', tenant_id: 'tenant', member_group_opt_in: true, ...options.template }],
    tenant: [{ id: 'tenant', slug: 'tenant' }],
  };
  const supabase = {
    from(table) {
      let rows = tables[table] || [];
      const query = {
        select() { return query; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return query; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query; },
        order() { return query; },
        range(start, end) { rows = rows.slice(start, end + 1); return query; },
        single() { return Promise.resolve({ data: rows[0] || null }); },
        then(resolve, reject) { return Promise.resolve({ data: rows }).then(resolve, reject); },
      };
      return query;
    },
  };
  const access = await load('../_lib/memberGroupEmsAccess.js', {
    supabase,
    getTenantContext: async () => ({
      tenantId: 'tenant', memberId: 'other-admin', member: { email: 'test@example.org' },
      ...options.context,
    }),
    _getTenantEmailConfig: async () => options.senderError ? null : ({ fromEmail: 'verified@example.org' }),
  }, ['getCallerEmsAccess', 'requireGroupAccess', 'normalizeAudienceRoles', 'resolveMemberCampaignSender', 'validateStoredMemberCampaign']);
  const services = {};
  for (const name of ['getCampaign', 'getCampaignStats', 'getCampaignRecipients', 'updateCampaign',
    'deleteCampaign', 'createCampaign', 'cancelCampaign', 'pauseCampaign', 'resumeCampaign',
    'returnScheduledCampaignToDraft', 'sendCampaign', 'scheduleCampaign', 'getTargetRecipients']) {
    services[name] = async (...args) => {
      calls.push({ name, args });
      return options.conflict && name !== 'getTargetRecipients' ? { success: false, code: 'CAMPAIGN_STATE_CONFLICT', error: 'Status changed' }
        : { success: true, campaign: name === 'createCampaign' ? { ...args[0], status: 'draft' } : campaign, recipients: options.audience || [] };
    };
  }
  services.resolveMemberCampaignTemplateContent = async args => {
    calls.push({ name: 'resolveTemplate', args: [args] });
    return options.templateError ? { ok: false, error: 'Template unavailable' } : {
      ok: true, html_content: '<p>Validated</p>', design_json: { slotValues: args.requestedSlotValues },
      email_template_id: 'template',
    };
  };
  const dependencies = {
    resolveCampaignEventSurvey, replaceEventSurvey,
    supabase, ...access, ...services,
    getHostFromRequest: () => 'example.org',
    validateCampaignSenderEmail: () => ({ valid: true }),
    getTenantBaseUrl: () => 'https://example.org',
    generateTrackingToken: () => 'test-token',
    rewriteLinksForTracking: html => html,
    applyDynamicSlotValues: value => value,
    stripHiddenDynamicRegions: html => html,
    sendEmail: async args => { calls.push({ name: 'sendEmail', args: [args] }); return { success: true }; },
  };
  return {
    calls, campaign,
    async request(file, method, body = {}, query = {}) {
      const { handler } = await load(`./${file}.js`, dependencies, ['handler']);
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
      };
      await handler({ method, body, query: { id: 'campaign', ...query } }, res);
      return res;
    },
  };
}

test('another current group admin can list, read, inspect stats/recipients, and edit without taking authorship', async () => {
  const f = await fixture();
  assert.equal((await f.request('index', 'GET')).body.campaigns.length, 1);
  for (const query of [{}, { stats: 'true' }, { recipients: 'true' }]) {
    assert.equal((await f.request('[id]', 'GET', {}, query)).statusCode, 200);
  }
  assert.equal((await f.request('[id]', 'PATCH', { subject: 'Changed', created_by_member_id: 'attacker' })).statusCode, 200);
  const update = f.calls.find(call => call.name === 'updateCampaign');
  assert.equal('created_by_member_id' in update.args[1], false);
  assert.equal(update.args[1].from_email, 'verified@example.org');
  assert.equal(update.args[3].expectedStatus, 'draft');
});

const protectedRequests = [
  ['[id]', 'GET'], ['[id]', 'GET', {}, { stats: 'true' }],
  ['[id]', 'GET', {}, { recipients: 'true' }], ['[id]', 'PATCH', { subject: 'Changed' }],
  ['[id]', 'DELETE'], ...['duplicate', 'cancel', 'pause', 'resume', 'edit-scheduled'].map(action => ['[id]', 'POST', { action }]),
  ['send', 'POST', { campaignId: 'campaign', preview: true }],
  ['send', 'POST', { campaignId: 'campaign' }],
  ['send', 'POST', { campaignId: 'campaign', scheduledAt: '2099-01-01' }],
  ['test-send', 'POST', { campaignId: 'campaign' }],
];

for (const [label, options, status] of [
  ['wrong tenant', { campaign: { tenant_id: 'another-tenant' } }, 404],
  ['wrong group', { campaign: { member_group_id: 'another-group' } }, 403],
  ['not group admin', { assignment: { is_group_admin: false } }, 403],
  ['expired assignment', { assignment: { expires_at: '2000-01-01' } }, 403],
  ['invalid expiry', { assignment: { expires_at: 'invalid' } }, 403],
  ['inactive group', { group: { is_active: false } }, 403],
  ['foreign group tenant', { group: { tenant_id: 'foreign' } }, 403],
  ['missing member session', { context: { memberId: null } }, 403],
  ['missing tenant', { context: { tenantId: null } }, 401],
]) {
  test(`${label} denies all stored-campaign operations before side effects`, async () => {
    const f = await fixture(options);
    for (const args of protectedRequests) {
      assert.equal((await f.request(...args)).statusCode, status, JSON.stringify(args));
    }
    assert.equal(f.calls.length, 0);
  });
}

test('another admin can preview, test-send and invoke every lifecycle action', async () => {
  const f = await fixture();
  for (const args of protectedRequests) assert.ok((await f.request(...args)).statusCode < 300, JSON.stringify(args));
  for (const name of ['sendCampaign', 'scheduleCampaign', 'resumeCampaign']) {
    assert.equal(f.calls.find(call => call.name === name).args[3].expectedStatus, 'draft');
    assert.equal(f.calls.find(call => call.name === name).args[3].expectedUpdatedAt, f.campaign.updated_at);
  }
  assert.equal(f.calls.find(call => call.name === 'deleteCampaign').args[2].expectedStatus, 'draft');
  assert.ok(f.calls.some(call => call.name === 'sendEmail'));
  assert.ok(f.calls.some(call => call.name === 'returnScheduledCampaignToDraft'));
});

test('scheduled content cannot mutate/delete/send until explicitly returned to draft', async () => {
  const f = await fixture({ campaign: { status: 'scheduled' } });
  for (const args of [
    ['[id]', 'PATCH', { subject: 'Changed' }], ['[id]', 'DELETE'],
    ['send', 'POST', { campaignId: 'campaign' }],
    ['send', 'POST', { campaignId: 'campaign', scheduledAt: '2099-01-01' }],
  ]) assert.equal((await f.request(...args)).statusCode, 400);
  assert.equal((await f.request('[id]', 'POST', { action: 'edit-scheduled' })).statusCode, 200);
});

test('concurrent status conflicts are surfaced', async () => {
  const f = await fixture({ conflict: true });
  for (const args of [
    ['[id]', 'PATCH', { subject: 'Changed' }], ['[id]', 'DELETE'],
    ['[id]', 'POST', { action: 'edit-scheduled' }],
    ['[id]', 'POST', { action: 'resume' }],
    ['send', 'POST', { campaignId: 'campaign' }],
    ['send', 'POST', { campaignId: 'campaign', scheduledAt: '2099-01-01' }],
  ]) assert.equal((await f.request(...args)).statusCode, 409);
});

test('duplication validates template slots and sender before a single safe create', async () => {
  const f = await fixture({ campaign: {
    status: 'sent', scheduled_at: '2020-01-01', sent_at: '2020-01-01',
    sent_count: 99, delivered_count: 88, html_content: '<script>unsafe</script>',
    communication_category_id: 'unsafe-category',
  } });
  const res = await f.request('[id]', 'POST', { action: 'duplicate', member_group_id: 'attacker' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, 'draft');
  const creates = f.calls.filter(call => call.name === 'createCampaign');
  assert.equal(creates.length, 1);
  const data = creates[0].args[0];
  assert.equal(data.created_by_member_id, 'other-admin');
  assert.equal(data.member_group_id, 'group');
  assert.equal(data.from_email, 'verified@example.org');
  assert.equal(data.html_content, '<p>Validated</p>');
  assert.equal(data.communication_category_id, null);
  for (const field of ['scheduled_at', 'sent_at', 'sent_count', 'delivered_count', 'id']) assert.equal(field in data, false);
  assert.equal(data.target_audiences[0].roles[0], 'Member');
  const validation = f.calls.find(call => call.name === 'resolveTemplate').args[0];
  assert.equal(validation.requestedSlotValues.title, 'Hi');
  assert.equal(validation.requestedHiddenSlots[0], 'optional');
  assert.equal(validation.requestedRichSlots[0], 'title');
  assert.equal(validation.groupClassificationId, 'classification');
});

for (const [label, options] of [
  ['removed role', { campaign: { target_audiences: [{ type: 'member_group', ids: ['group'], roles: ['Removed'] }] } }],
  ['malformed roles', { campaign: { target_audiences: [{ type: 'member_group', ids: ['group'], roles: 'Member' }] } }],
  ['widened audience', { campaign: { target_audiences: [{ type: 'all_members' }] } }],
  ['unavailable template', { templateError: true }],
  ['unavailable sender', { senderError: true }],
  ['malformed design', { campaign: { design_json: '{invalid' } }],
]) {
  test(`duplication rejects ${label} without creating anything`, async () => {
    const f = await fixture(options);
    assert.equal((await f.request('[id]', 'POST', { action: 'duplicate' })).statusCode, 400);
    assert.equal(f.calls.some(call => call.name === 'createCampaign'), false);
  });
}

test('ad-hoc preview rejects unauthorized groups and invalid roles rather than widening recipients', async () => {
  const f = await fixture();
  assert.equal((await f.request('send', 'POST', { campaignId: 'preview', preview: true, groupId: 'foreign' })).statusCode, 403);
  for (const audienceRoles of [['Removed'], 'Member', false]) {
    assert.equal((await f.request('send', 'POST', { campaignId: 'preview', preview: true, groupId: 'group', audienceRoles })).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});

const deliveryRequests = [
  ['[id]', 'POST', { action: 'resume' }],
  ['send', 'POST', { campaignId: 'campaign', preview: true }],
  ['send', 'POST', { campaignId: 'campaign' }],
  ['send', 'POST', { campaignId: 'campaign', scheduledAt: '2099-01-01' }],
  ['test-send', 'POST', { campaignId: 'campaign' }],
];

test('tenant-created campaigns with valid group scope support shared delivery operations', async () => {
  const f = await fixture({ campaign: { created_by_member_id: null } });
  for (const args of deliveryRequests) assert.equal((await f.request(...args)).statusCode, 200);
  assert.equal(f.calls.some(call => call.name === 'getCampaign'), false, 'delivery uses the authorized, validated snapshot without a second fetch');
});

for (const [label, options, status] of [
  ['widened audience', { campaign: { target_audiences: [{ type: 'all_members' }] } }, 400],
  ['multiple segments', { campaign: { target_audiences: [{ type: 'member_group', ids: ['group'] }, { type: 'all_members' }] } }, 400],
  ['foreign audience group', { campaign: { target_audiences: [{ type: 'member_group', ids: ['foreign'] }] } }, 400],
  ['removed audience role', { campaign: { target_audiences: [{ type: 'member_group', ids: ['group'], roles: ['Removed'] }] } }, 400],
  ['missing audience', { campaign: { target_audiences: null } }, 400],
  ['legacy broad target', { campaign: { target_type: 'all_members' } }, 400],
  ['legacy foreign ids', { campaign: { target_ids: ['foreign'] } }, 400],
  ['category selector', { campaign: { communication_category_id: 'category' } }, 400],
  ['opt-out bypass', { campaign: { ignore_opt_outs: true } }, 400],
  ['missing template', { campaign: { email_template_id: null } }, 403],
  ['revoked template opt-in', { template: { member_group_opt_in: false } }, 403],
  ['foreign tenant template', { template: { tenant_id: 'foreign' } }, 403],
  ['wrong classification', { template: { member_group_classification_ids: ['foreign'] } }, 403],
  ['malformed classification policy', { template: { member_group_classification_ids: 'classification' } }, 403],
  ['old sender', { campaign: { from_email: 'old@example.org' } }, 400],
  ['unconfigured sender', { senderError: true }, 400],
]) {
  test(`all delivery paths reject ${label} on tenant-created group campaigns`, async () => {
    const f = await fixture({ ...options, campaign: { created_by_member_id: null, ...options.campaign } });
    for (const args of deliveryRequests) assert.equal((await f.request(...args)).statusCode, status, JSON.stringify(args));
    assert.equal(f.calls.some(call => ['getTargetRecipients', 'sendEmail', 'sendCampaign', 'scheduleCampaign', 'resumeCampaign'].includes(call.name)), false);
  });
}

for (const status of ['pending', 'processing']) {
  for (const mismatch of ['email', 'member_id']) {
    test(`resume rejects persisted ${status} recipient with unauthorized ${mismatch}`, async () => {
      const recipient = { id: 'recipient', campaign_id: 'campaign', member_id: 'member', email: 'member@example.org', status };
      const f = await fixture({
        campaign: { status: 'paused' },
        audience: [{ id: 'member', email: 'member@example.org' }],
        recipients: [{ ...recipient, [mismatch]: 'external' }],
      });
      assert.equal((await f.request('[id]', 'POST', { action: 'resume' })).statusCode, 403);
      assert.equal(f.calls.some(call => call.name === 'resumeCampaign'), false);
    });
  }
}

test('resume checks every persisted page and ignores already delivered recipients', async () => {
  const recipient = { campaign_id: 'campaign', member_id: 'member', email: 'member@example.org', status: 'pending' };
  const f = await fixture({
    campaign: { status: 'paused' },
    audience: [{ id: 'member', email: 'member@example.org' }],
    recipients: [
      ...Array.from({ length: 500 }, (_, i) => ({ ...recipient, id: String(i) })),
      { ...recipient, id: 'last', email: 'external@example.org' },
    ],
  });
  assert.equal((await f.request('[id]', 'POST', { action: 'resume' })).statusCode, 403);
  const valid = await fixture({
    campaign: { status: 'paused' },
    audience: [{ id: 'member', email: 'member@example.org' }],
    recipients: [{ ...recipient, id: 'valid' }, { ...recipient, id: 'sent', status: 'sent', email: 'external@example.org' }],
  });
  assert.equal((await valid.request('[id]', 'POST', { action: 'resume' })).statusCode, 200);
  assert.equal(valid.calls.find(call => call.name === 'resumeCampaign').args[3].expectedStatus, 'paused');
});
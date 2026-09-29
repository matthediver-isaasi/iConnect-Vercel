import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import Mailgun from 'mailgun.js';
import { randomUUID } from 'node:crypto';

process.env.MAILGUN_API_KEY = 'mock-entry-point-key';
process.env.APP_DOMAIN = 'example.test';

register('./campaignEntryPointMocks.loader.mjs', import.meta.url, {
  data: { fixtureTenantId: 'tenant-fixture' },
});

const transportCalls = [];
const originalMailgunClient = Mailgun.prototype.client;
Mailgun.prototype.client = () => ({
  messages: {
    create: async (domain, payload) => {
      transportCalls.push({ domain, payload });
      return { id: `<entry-${transportCalls.length}>` };
    },
  },
});

const [
  { default: tenantTestHandler },
  { default: groupTestHandler },
  { default: immediateHandler },
  { processScheduledCampaigns },
  { supabase },
] = await Promise.all([
  import('../email-campaigns/test-send.js?entry-point-fixture'),
  import('../member-campaigns/test-send.js?entry-point-fixture'),
  import('../email-campaigns/send.js?entry-point-fixture'),
  import('./campaignService.js'),
  import('./database.js'),
]);

const originalFrom = supabase.from;
const originalRpc = supabase.rpc;

const GSF_HTML = [
  '<main data-fixture="gsf-body">Hello {{first_name}}</main>',
  '<table class="tenant-email-footer" data-fixture="gsf-branded-footer">',
  '<tr><td>Graduate Futures branded footer</td></tr>',
  '</table>',
].join('');
const RUNTIME_FOOTER = '<footer data-fixture="runtime-tenant-footer">Runtime footer {{unsubscribe_link}}</footer>';

function campaign(status = 'draft', id = 'campaign-fixture', overrides = {}) {
  return {
    id,
    tenant_id: 'tenant-fixture',
    name: 'GSF structural fixture',
    status,
    updated_at: '2026-01-01T00:00:00.000Z',
    scheduled_at: status === 'scheduled' ? '2020-01-01T00:00:00.000Z' : null,
    category_review_required: false,
    from_email: 'sender@fixture.test',
    from_name: 'Fixture Sender',
    subject: 'Fixture subject',
    html_content: GSF_HTML,
    design_json: {
      blocks: [{ type: 'text', content: 'Body without unsubscribe' }],
      globalStyles: { contentWidth: '640px' },
    },
    target_type: 'member_group',
    target_ids: ['group-fixture'],
    target_audiences: [],
    member_group_id: 'group-fixture',
    email_template_id: 'template-fixture',
    communication_category_id: null,
    ignore_opt_outs: true,
    ...overrides,
  };
}

function fixtureDatabase(initialCampaign, extraTables = {}) {
  const state = {
    surveyRows: { campaign_survey_delivery: [], certificate_survey_entitlement: [], certificate_survey_credential: [] },
    campaign: structuredClone(initialCampaign),
    recipients: initialCampaign.status === 'sending'
      ? [{
        id: `${initialCampaign.id}-recipient`,
        campaign_id: initialCampaign.id,
        member_id: null,
        email: 'grace@example.test',
        first_name: 'Grace',
        last_name: 'Hopper',
        status: 'pending',
      }]
      : [],
  };

  supabase.from = (table) => {
    let operation = 'select';
    let values = null;
    let selected = '*';
    let countOptions = null;
    let single = false;
    const filters = [];
    const query = {
      select(fields = '*', options = null) {
        selected = fields;
        countOptions = options;
        return query;
      },
      update(nextValues) {
        operation = 'update';
        values = nextValues;
        return query;
      },
      insert(nextValues) {
        operation = 'insert';
        values = Array.isArray(nextValues) ? nextValues : [nextValues];
        return query;
      },
      eq(key, value) {
        filters.push((row) => row?.[key] === value);
        return query;
      },
      ilike(key, value) {
        filters.push(row => String(row?.[key] || '').toLowerCase() === value.toLowerCase());
        return query;
      },
      is(key, value) {
        filters.push((row) => (row?.[key] ?? null) === value);
        return query;
      },
      in(key, choices) {
        filters.push((row) => choices.includes(row?.[key]));
        return query;
      },
      not() { return query; },
      lte(key, value) {
        filters.push((row) => row?.[key] <= value);
        return query;
      },
      lt(key, value) {
        filters.push((row) => row?.[key] < value);
        return query;
      },
      gt(key, value) {
        filters.push((row) => row?.[key] > value);
        return query;
      },
      order() { return query; },
      range() { return query; },
      limit() { return query; },
      single() { single = true; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        Promise.resolve().then(() => {
          if (Object.hasOwn(state.surveyRows, table)) {
            const rows = state.surveyRows[table];
            if (operation === 'insert') {
              const inserted = values.map(value => ({ id: randomUUID(),
                ...(table === 'campaign_survey_delivery' ? { status: 'pending' } : {}), ...value }));
              rows.push(...inserted);
              return { data: single ? inserted[0] : inserted, error: null };
            }
            const matches = rows.filter(row => filters.every(filter => filter(row)));
            if (operation === 'update') matches.forEach(row => Object.assign(row, values));
            return { data: single ? matches[0] || null : matches, error: null };
          }
          if (Object.hasOwn(extraTables, table)) {
            assert.equal(operation, 'select', 'source test must not mutate event or survey records');
            const rows = extraTables[table].filter(row => filters.every(filter => filter(row)));
            return { data: single ? rows[0] || null : rows, error: null };
          }
          if (table === 'tenant') {
            return {
              data: {
                id: 'tenant-fixture',
                slug: 'fixture',
                name: 'Fixture Tenant',
                plan_code: 'fixture-plan',
                settings: {
                  email_domain: {
                    status: 'verified',
                    domain: 'mail.fixture.test',
                    from_email: 'sender@mail.fixture.test',
                    from_name: 'Fixture Tenant',
                  },
                },
              },
              error: null,
            };
          }
          if (table === 'plan') return { data: { quotas: {} }, error: null };
          if (table === 'system_settings') {
            if (filters.length && selected === 'setting_value') {
              return { data: { setting_value: RUNTIME_FOOTER }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === 'member_group_assignment') {
            return {
              data: [{
                member_id: 'member-fixture',
                group_role: 'Chair',
                expires_at: null,
                is_group_admin: true,
              }],
              error: null,
            };
          }
          if (table === 'member') {
            if (selected.includes('communications_opted_out_all')) {
              return {
                data: [{
                  id: 'member-fixture',
                  email: 'grace@example.test',
                  first_name: 'Grace',
                  last_name: 'Hopper',
                  communications_opted_out_all: false,
                }],
                error: null,
              };
            }
            return { data: [], error: null };
          }
          if (table === 'email_template') {
            return {
              data: {
                id: 'template-fixture',
                member_group_opt_in: true,
                member_group_classification_ids: [],
              },
              error: null,
            };
          }
          if (table === 'email_campaign') {
            const rows = state.campaign && filters.every((filter) => filter(state.campaign))
              ? [state.campaign]
              : [];
            if (operation === 'update' && rows.length) {
              Object.assign(state.campaign, values);
            }
            const data = rows.map((row) => structuredClone(row));
            return { data: single ? data[0] || null : data, error: null };
          }
          if (table === 'email_campaign_recipient') {
            if (operation === 'insert') state.recipients.push(...values.map((row) => ({ ...row })));
            const rows = state.recipients.filter((row) => filters.every((filter) => filter(row)));
            if (operation === 'update') rows.forEach((row) => Object.assign(row, values));
            const data = rows.map((row) => selected === 'id' ? { id: row.id } : structuredClone(row));
            return {
              data: countOptions?.head ? null : (single ? data[0] || null : data),
              count: countOptions?.head ? rows.length : null,
              error: null,
            };
          }
          throw new Error(`Unexpected entry-point fixture query: ${table} (${selected})`);
        }).then(resolve, reject);
      },
    };
    return query;
  };
  supabase.rpc = async () => ({ data: null, error: null });
  return state;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(body = {}) {
  return {
    method: 'POST',
    body,
    headers: { host: 'fixture.example.test' },
  };
}

test('source lookup is paginated and test envelope uses source content without delivery state', async () => {
  const saved = campaign('draft', 'campaign-fixture', {
    subject: 'Hello {{first_name}} [[member.email]]',
    html_content: '<p>{{recipient_name}} {{email}} [[member.email]]</p>',
  });
  const state = fixtureDatabase(saved);
  const lookup = responseRecorder();
  await tenantTestHandler(request({ campaignId: saved.id, action: 'search-sources', search: 'grace' }), lookup);
  assert.equal(lookup.statusCode, 200);
  assert.deepEqual(lookup.body.recipients, [{ email: 'grace@example.test', first_name: 'Grace', last_name: 'Hopper' }]);
  const payload = await capture(async () => {
    const res = responseRecorder();
    await tenantTestHandler(request({
      campaignId: saved.id, sourceRecipientEmail: 'grace@example.test', testEmail: 'reviewer@example.test',
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });
  assert.deepEqual(payload.to, ['reviewer@example.test']);
  assert.match(payload.subject, /Hello Grace grace@example.test/);
  assert.match(payload.html, /Grace Hopper grace@example.test grace@example.test/);
  assert.equal(payload['h:List-Unsubscribe'], undefined);
  assert.equal(payload['o:tracking'], undefined);
  assert.equal(state.recipients.length, 0);
  assert.deepEqual(state.campaign, saved);
});

test('source outside current audience and foreign-tenant campaigns are rejected before transport', async () => {
  const before = transportCalls.length;
  fixtureDatabase(campaign());
  const unauthorized = responseRecorder();
  const unauthorizedRequest = request({ campaignId: 'campaign-fixture', action: 'search-sources' });
  unauthorizedRequest.headers['x-fixture-unauthorized'] = 'true';
  await tenantTestHandler(unauthorizedRequest, unauthorized);
  assert.equal(unauthorized.statusCode, 403);
  const invalidSource = responseRecorder();
  await tenantTestHandler(request({
    campaignId: 'campaign-fixture', sourceRecipientEmail: 'outsider@example.test', testEmail: 'reviewer@example.test',
  }), invalidSource);
  assert.equal(invalidSource.statusCode, 400);
  assert.match(invalidSource.body.error, /campaign audience/);
  fixtureDatabase(campaign('draft', 'campaign-fixture', { tenant_id: 'other-tenant' }));
  for (const action of [undefined, 'search-sources']) {
    const res = responseRecorder();
    await tenantTestHandler(request({
      campaignId: 'campaign-fixture', action, sourceRecipientEmail: 'grace@example.test', testEmail: 'reviewer@example.test',
    }), res);
    assert.equal(res.statusCode, 404);
  }
  assert.equal(transportCalls.length, before);
});

test('source search pages large audiences and does not accept member IDs or stale source emails', async () => {
  const { searchCampaignTestSources, selectCampaignTestSource, campaignTestAudience } = await import('./campaignTestSource.js');
  const audience = Array.from({ length: 61 }, (_, index) => ({
    id: `member-${index}`, first_name: 'Audience', last_name: `${index}`, email: `person${index}@example.test`,
  }));
  const first = searchCampaignTestSources(audience, 'audience');
  const second = searchCampaignTestSources(audience, 'audience', 25);
  const last = searchCampaignTestSources(audience, 'audience', 50);
  assert.equal(first.recipients.length, 25);
  assert.equal(second.recipients.length, 25);
  assert.equal(last.recipients.length, 11);
  assert.equal(first.hasMore, true);
  assert.equal(last.hasMore, false);
  assert.notEqual(first.recipients[0].email, second.recipients[0].email);
  assert.equal(searchCampaignTestSources(audience, 'nobody').recipients.length, 0);
  assert.throws(() => selectCampaignTestSource(audience, 'member-1'), /campaign audience/);
  assert.throws(() => selectCampaignTestSource([], 'person1@example.test'), /campaign audience/);
  assert.equal(selectCampaignTestSource(audience, 'PERSON1@example.test').member_id, 'member-1');
  assert.equal(selectCampaignTestSource([{ id: 'external-contact', member_id: null, email: 'external@example.test' }], 'external@example.test').member_id, null);
  await assert.rejects(campaignTestAudience({ tenant_id: 'other' }, 'tenant-fixture'), /Campaign not found/);
});

test('source test personalization failure does not touch campaign or recipient delivery state', async () => {
  const saved = campaign('draft', 'campaign-fixture', {
    html_content: '<a href="{{event_survey_url}}">Survey</a>',
    event_survey_context: null,
  });
  const state = fixtureDatabase(saved);
  const before = transportCalls.length;
  const res = responseRecorder();
  await tenantTestHandler(request({
    campaignId: saved.id, sourceRecipientEmail: 'grace@example.test', testEmail: 'reviewer@example.test',
  }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.failures[0].error, /Event context/);
  assert.equal(transportCalls.length, before);
  assert.equal(state.recipients.length, 0);
  assert.deepEqual(state.campaign, saved);
});

test('shared live personalization resolves source booking, QR and explicit survey context, with test-only envelope', async () => {
  const { sendToRecipient } = await import('./campaignService.js');
  const saved = campaign('draft', 'campaign-fixture', {
    target_type: 'event_attendees', target_ids: ['event-fixture'],
    subject: '{{first_name}} [[booking.id]]',
    html_content: '<p>[[booking.id]] {{email}}</p><img src="{{event_qr_image_url}}"><a href="{{event_survey_url}}">Survey</a>',
    event_survey_context: { event_type: 'event', event_id: 'event-fixture' },
  });
  const state = fixtureDatabase(saved, {
    event: [{ id: 'event-fixture', tenant_id: 'tenant-fixture', is_online: false }],
    booking: [{
      id: 'source-booking', tenant_id: 'tenant-fixture', event_id: 'event-fixture',
      attendee_email: 'grace@example.test', member_id: 'member-fixture', status: 'confirmed', check_in_token: 'source-qr',
    }, {
      id: 'wrong-booking', tenant_id: 'other-tenant', event_id: 'event-fixture',
      attendee_email: 'grace@example.test', status: 'confirmed', check_in_token: 'wrong-qr',
    }],
    event_survey_assignment: [{
      id: 'assignment', tenant_id: 'tenant-fixture', event_type: 'event', event_id: 'event-fixture',
      status: 'active', token: 'survey-token', form_id: 'form-fixture',
    }],
    form: [{
      id: 'form-fixture', tenant_id: 'tenant-fixture', is_active: true, form_type: 'survey',
      survey_settings: { status: 'published', current_version: 1 },
    }],
    survey_version: [{ id: 'version', tenant_id: 'tenant-fixture', form_id: 'form-fixture', version_number: 1 }],
  });
  const payload = await capture(async () => {
    const result = await sendToRecipient({
      id: 'test-source', member_id: 'member-fixture', email: 'grace@example.test', first_name: 'Grace',
    }, saved, 'tenant-fixture', 'fixture', 'fixture.example.test', { skipFooter: false }, 'reviewer@example.test');
    assert.equal(result.success, true, result.error);
  });
  assert.deepEqual(payload.to, ['reviewer@example.test']);
  assert.match(payload.subject, /Grace source-booking/);
  assert.match(payload.html, /source-booking grace@example.test/);
  assert.match(payload.html, /checkin-qr\?token=source-qr/);
  assert.match(payload.html, /\/survey\/survey-token/);
  assert.match(payload.html, /#certificate_grant=/);
  assert.equal(payload['o:tracking'], 'no');
  assert.equal(state.surveyRows.campaign_survey_delivery[0].purpose, 'test');
  assert.equal(state.surveyRows.campaign_survey_delivery[0].status, 'accepted');
  assert.doesNotMatch(payload.html, /wrong-booking|wrong-qr|\{\{event_|\[\[booking/);
  assert.equal(state.recipients.length, 0);
  assert.deepEqual(state.campaign, saved);
});

function normalizedPayload(payload) {
  const normalize = (value) => String(value || '')
    .replace(/\[TEST\]\s*/g, '')
    .replace(/\b(?:Admin|Test|Grace)\b/g, 'RECIPIENT')
    .replace(/t=[^"&\s)]+/g, 't=TOKEN')
    .replace(/\/api\/email-campaigns\/click\?t=[^"&\s)]+/g, '/api/email-campaigns/click?t=TOKEN')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    subject: normalize(payload.subject),
    html: normalize(payload.html),
    text: normalize(payload.text),
  };
}

function assertGsfFooterContract(payload, { actionable }) {
  assert.equal((payload.html.match(/data-fixture="gsf-branded-footer"/g) || []).length, 1);
  assert.equal((payload.html.match(/data-fixture="runtime-tenant-footer"/g) || []).length, 0);
  assert.equal((payload.html.match(/Manage email preferences/g) || []).length, 1);
  assert.match(payload.text, /Manage email preferences/);
  if (actionable) {
    assert.match(payload.html, /email-preferences\?t=/);
    assert.match(payload.text, /email-preferences\?t=/);
  } else {
    assert.match(payload.html, /href="#"/);
    assert.doesNotMatch(`${payload.html}\n${payload.text}`, /email-preferences\?t=|(?:member-)?test-/);
    assert.equal(payload['h:List-Unsubscribe'], undefined);
    assert.equal(payload['h:List-Unsubscribe-Post'], undefined);
  }
}

function visualPreferenceFixture(alias, serializedDesign = false) {
  const nestedDesign = {
    blocks: [{
      type: 'section',
      columns: [{
        blocks: [{
          type: 'container',
          children: [{ type: 'unsubscribe' }],
        }],
      }],
    }],
    globalStyles: { contentWidth: '640px' },
  };
  return {
    html_content: [
      '<main data-fixture="visual-body">Hello {{first_name}}</main>',
      `<a data-fixture="visual-preference" href="{{${alias}}}">Visual preference control</a>`,
    ].join(''),
    design_json: serializedDesign ? JSON.stringify(nestedDesign) : nestedDesign,
  };
}

function preferenceDestination(payload) {
  const href = payload.html.match(/data-fixture="visual-preference"[^>]*href="([^"]+)"/)?.[1];
  assert.ok(href, `visual preference href missing from ${payload.html}`);
  return href;
}

function assertVisualPreferenceContract(payload, { providerTracking, actionable }) {
  const href = preferenceDestination(payload);
  assert.doesNotMatch(payload.html, /\{\{(?:unsubscribe|communication_preferences)_(?:link|url)\}\}|%7B%7B/i);
  assert.equal((payload.html.match(/data-fixture="visual-preference"/g) || []).length, 1);
  assert.equal((payload.html.match(/data-fixture="runtime-tenant-footer"/g) || []).length, 0);
  assert.equal((payload.html.match(/Manage email preferences/g) || []).length, 0);
  assert.match(payload.text, /Visual preference control/);
  if (actionable) {
    assert.match(href, /^https:\/\/fixture\.example\.test\/email-preferences\?t=[^&"]+$/);
    assert.doesNotMatch(href, /\/api\/email-campaigns\/click/i);
    assert.equal((payload.html.match(/email-preferences\?t=/g) || []).length, 1);
    assert.ok(payload.text.includes(href), 'plain-text alternative must include the direct recipient preference URL');
    const oneClick = payload['h:List-Unsubscribe'];
    assert.match(oneClick || '', /^<mailto:unsubscribe@mail\.fixture\.test>, <https:\/\/fixture\.example\.test\/api\/email-campaigns\/unsubscribe\?t=[^&>]+&confirm=true>$/);
    assert.equal(payload['h:List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const headerToken = oneClick.match(/[?&]t=([^&>]+)/)?.[1];
    assert.equal(new URL(href).searchParams.get('t'), headerToken);
  } else {
    assert.equal(href, '#');
    assert.doesNotMatch(`${payload.html}\n${payload.text}`, /email-preferences\?t=|api\/email-campaigns\/unsubscribe|(?:member-)?test-/);
    assert.equal(payload['h:List-Unsubscribe'], undefined);
    assert.equal(payload['h:List-Unsubscribe-Post'], undefined);
  }
  assert.equal(payload['o:tracking'], providerTracking ? 'yes' : undefined);
  assert.equal(payload['o:tracking-clicks'], providerTracking ? 'htmlonly' : undefined);
}

async function capture(run) {
  const before = transportCalls.length;
  await run();
  assert.equal(transportCalls.length, before + 1);
  return transportCalls.at(-1).payload;
}

after(() => {
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
  Mailgun.prototype.client = originalMailgunClient;
});

test('actual tenant and group test-send handlers render the GSF structural fixture identically', async () => {
  const tenantState = fixtureDatabase(campaign('draft'));
  const tenantPayload = await capture(async () => {
    const res = responseRecorder();
    await tenantTestHandler(request({
      campaignId: 'campaign-fixture',
      testEmail: 'tenant-test@example.test',
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });

  const groupState = fixtureDatabase(campaign('draft'));
  const groupPayload = await capture(async () => {
    const res = responseRecorder();
    await groupTestHandler(request({
      campaignId: 'campaign-fixture',
      testEmail: 'group-test@example.test',
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });

  assert.equal(tenantState.recipients.length, 0, 'tenant test-send must not persist a recipient row');
  assert.equal(groupState.recipients.length, 0, 'group test-send must not persist a recipient row');
  assertGsfFooterContract(tenantPayload, { actionable: false });
  assertGsfFooterContract(groupPayload, { actionable: false });
  assert.deepEqual(normalizedPayload(tenantPayload), normalizedPayload(groupPayload));
});

test('actual immediate endpoint and scheduled continuation worker render the same final payload', async () => {
  fixtureDatabase(campaign('draft'));
  const immediatePayload = await capture(async () => {
    const res = responseRecorder();
    await immediateHandler(request({ campaignId: 'campaign-fixture' }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });

  fixtureDatabase(campaign('sending'));
  const scheduledPayload = await capture(async () => {
    const result = await processScheduledCampaigns();
    assert.equal(result.success, true);
  });

  assertGsfFooterContract(immediatePayload, { actionable: true });
  assertGsfFooterContract(scheduledPayload, { actionable: true });
  assert.deepEqual(normalizedPayload(immediatePayload), normalizedPayload(scheduledPayload));
});

for (const fixture of [
  {
    name: 'unsubscribe URL alias with object design',
    alias: 'unsubscribe_url',
    serializedDesign: false,
  },
  {
    name: 'communication preferences URL alias with string design',
    alias: 'communication_preferences_url',
    serializedDesign: true,
  },
]) {
  test(`actual campaign entry points preserve direct Visual Builder ${fixture.name}`, async () => {
    const id = `campaign-${fixture.alias}`;
    const overrides = visualPreferenceFixture(fixture.alias, fixture.serializedDesign);

    const tenantState = fixtureDatabase(campaign('draft', id, overrides));
    const tenantPayload = await capture(async () => {
      const res = responseRecorder();
      await tenantTestHandler(request({
        campaignId: id,
        testEmail: 'tenant-test@example.test',
      }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });

    const groupState = fixtureDatabase(campaign('draft', id, overrides));
    const groupPayload = await capture(async () => {
      const res = responseRecorder();
      await groupTestHandler(request({
        campaignId: id,
        testEmail: 'group-test@example.test',
      }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });

    fixtureDatabase(campaign('draft', id, overrides));
    const immediatePayload = await capture(async () => {
      const res = responseRecorder();
      await immediateHandler(request({ campaignId: id }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });

    fixtureDatabase(campaign('sending', id, overrides));
    const scheduledPayload = await capture(async () => {
      const result = await processScheduledCampaigns();
      assert.equal(result.success, true);
    });

    assert.equal(tenantState.recipients.length, 0, 'tenant test-send must not persist a recipient row');
    assert.equal(groupState.recipients.length, 0, 'group test-send must not persist a recipient row');
    assertVisualPreferenceContract(tenantPayload, { providerTracking: false, actionable: false });
    assertVisualPreferenceContract(groupPayload, { providerTracking: false, actionable: false });
    assertVisualPreferenceContract(immediatePayload, { providerTracking: true, actionable: true });
    assertVisualPreferenceContract(scheduledPayload, { providerTracking: true, actionable: true });

    const normalized = [
      tenantPayload,
      groupPayload,
      immediatePayload,
      scheduledPayload,
    ].map(normalizedPayload);
    assert.deepEqual(normalized[1], normalized[0]);
    assert.deepEqual(normalized[3], normalized[2]);
    assert.notDeepEqual(normalized[2], normalized[0], 'test and live payloads deliberately differ in preference credentials');
  });
}

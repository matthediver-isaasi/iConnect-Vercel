import assert from 'node:assert/strict';
import test from 'node:test';

// A syntactically valid but non-routable URL creates an inert client whose
// query entry point is replaced below. The isolation runner additionally
// rejects any accidental network/provider submission.
process.env.SUPABASE_URL = 'https://campaign-send-gate.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';

const { supabase } = await import('./database.js');
const { resumeCampaign, sendBatch, processScheduledCampaigns } = await import('./campaignService.js');

test('scheduled/retry batch with a survey token and no explicit event fails before recipient claims', async () => {
  const campaign = {
    id: 'campaign-1', status: 'sending', from_email: 'sender@example.com',
    subject: '{{event_survey_url}}', html_content: '<a href="[[event.survey_url]]">Survey</a>',
  };
  const mock = installCampaignMock(campaign);
  try {
    const result = await sendBatch('campaign-1', 'tenant-1', campaign, 'fixture', null);
    assert.equal(result.success, false);
    assert.match(result.error, /select an event/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

function installCampaignMock(campaign) {
  const calls = [];
  const originalFrom = supabase.from;

  supabase.from = (table) => {
    calls.push({ table, method: 'from' });
    const query = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'not']) {
      query[method] = (...args) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    for (const method of ['update', 'insert', 'upsert', 'delete']) {
      query[method] = (...args) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    query.single = async () => {
      calls.push({ table, method: 'single' });
      return table === 'email_campaign'
        ? { data: campaign, error: null }
        : { data: null, error: new Error(`Unexpected table: ${table}`) };
    };
    query.then = resolve => resolve({ count: 0, data: [], error: null });
    return query;
  };

  return {
    calls,
    restore() {
      supabase.from = originalFrom;
    },
  };
}

test('resumeCampaign rejects an invalid stored sender without mutating campaign or recipients', async () => {
  const mock = installCampaignMock({
    id: 'campaign-1',
    status: 'paused',
    name: 'Legacy campaign',
    from_email: 'test',
    category_review_required: false,
    target_type: 'all_members',
    target_ids: [],
    target_audiences: [],
  });

  try {
    const result = await resumeCampaign('campaign-1', 'tenant-1', 'operator-1');

    assert.equal(result.success, false);
    assert.equal(result.code, 'INVALID_SENDER_EMAIL');
    assert.match(result.error, /Sender Information/);
    assert.equal(
      mock.calls.some(({ method }) => ['update', 'insert', 'upsert', 'delete'].includes(method)),
      false,
    );
    assert.equal(mock.calls.some(({ table }) => table === 'email_campaign_recipient'), false);
  } finally {
    mock.restore();
  }
});

test('sendBatch rejects an invalid sender before recipient claims or provider submissions', async () => {
  const malformedCampaign = {
    id: 'campaign-2',
    status: 'sending',
    from_email: 'not-an-email',
  };
  const mock = installCampaignMock({
    id: malformedCampaign.id,
    status: 'sending',
    from_email: malformedCampaign.from_email,
    category_review_required: false,
  });

  try {
    const result = await sendBatch(
      malformedCampaign.id,
      'tenant-1',
      malformedCampaign,
      'tenant',
      null,
    );

    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'INVALID_SENDER_EMAIL');
    assert.match(result.error, /save the campaign/i);
    assert.equal(
      mock.calls.some(({ method }) => ['update', 'insert', 'upsert', 'delete'].includes(method)),
      false,
    );
    // sendToRecipient (and therefore sendEmail) is only reachable after a
    // recipient claim. No recipient-table access proves neither occurred.
    assert.equal(mock.calls.some(({ table }) => table === 'email_campaign_recipient'), false);
  } finally {
    mock.restore();
  }
});

test('worker refuses to claim recipients after member group administrator access is revoked', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'sending',
    from_email: 'sender@example.com', category_review_required: false,
    member_group_id: 'group-1', created_by_member_id: 'former-admin',
  };
  const mock = installCampaignMock(campaign);
  try {
    // No live group-admin assignment is returned by the mocked DB.
    const result = await sendBatch(campaign.id, campaign.tenant_id, campaign, 'tenant', null);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'MEMBER_GROUP_AUTHORITY_REVOKED');
    assert.equal(mock.calls.some(call => call.table === 'email_campaign_recipient'), false);
  } finally {
    mock.restore();
  }
});

test('worker revalidates a still-admin member campaign when its template opt-in is revoked', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'sending',
    from_email: 'sender@example.com', category_review_required: false,
    member_group_id: 'group-1', created_by_member_id: 'admin-1',
    email_template_id: 'template-1', target_type: 'member_group',
    target_ids: ['group-1'], target_audiences: [{ type: 'member_group', ids: ['group-1'] }],
  };
  const mock = installCampaignMock(campaign);
  const originalFrom = supabase.from;
  supabase.from = table => {
    if (table === 'member_group_assignment' || table === 'member_group' || table === 'email_template') {
      const data = table === 'member_group_assignment'
        ? [{ group_id: 'group-1', group_role: 'Member', is_group_admin: true }]
        : table === 'member_group'
          ? [{ id: 'group-1', is_active: true, roles: ['Member'], tenant_id: 'tenant-1' }]
          : [{ id: 'template-1', member_group_opt_in: false }];
      const q = { select() { return this; }, eq() { return this; }, in() { return this; },
        single: async () => ({ data: data[0], error: null }),
        then: resolve => resolve({ data, error: null }) };
      return q;
    }
    return originalFrom(table);
  };
  try {
    const result = await sendBatch(campaign.id, campaign.tenant_id, campaign, 'tenant', null);
    assert.equal(result.code, 'MEMBER_CAMPAIGN_AUTHORITY_CHANGED');
    assert.equal(mock.calls.some(call => call.table === 'email_campaign_recipient'), false);
  } finally {
    supabase.from = originalFrom;
    mock.restore();
  }
});

test('shared creator-null group campaign stops when the opted-in template is revoked', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'sending',
    from_email: 'sender@example.com', category_review_required: false,
    member_group_id: 'group-1', created_by_member_id: null,
    email_template_id: 'template-1', target_type: 'member_group',
    target_ids: ['group-1'], target_audiences: [{ type: 'member_group', ids: ['group-1'] }],
  };
  const mock = installCampaignMock(campaign);
  const mockedFrom = supabase.from;
  supabase.from = table => {
    if (table === 'member_group' || table === 'email_template') {
      const row = table === 'member_group'
        ? { id: 'group-1', is_active: true, roles: [], classification_id: null }
        : { id: 'template-1', member_group_opt_in: false, member_group_classification_ids: [] };
      return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: row, error: null }) };
    }
    return mockedFrom(table);
  };
  try {
    const result = await sendBatch(campaign.id, campaign.tenant_id, campaign, 'tenant', null);
    assert.equal(result.code, 'MEMBER_CAMPAIGN_AUTHORITY_CHANGED');
    assert.equal(mock.calls.some(call => call.table === 'email_campaign_recipient'), false);
  } finally {
    supabase.from = mockedFrom;
    mock.restore();
  }
});

test('tenant-admin group campaigns outside member-shaped scope retain their ordinary worker path', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'sending',
    from_email: 'sender@example.com', category_review_required: false,
    member_group_id: 'group-1', created_by_member_id: null,
    email_template_id: 'tenant-template', target_type: 'all_members',
    target_ids: [], target_audiences: [],
  };
  const mock = installCampaignMock(campaign);
  const mockedFrom = supabase.from;
  supabase.from = table => {
    if (table === 'member_group' || table === 'email_template') {
      const row = table === 'member_group'
        ? { id: 'group-1', is_active: true, roles: [] }
        : { id: 'tenant-template', member_group_opt_in: false };
      return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: row, error: null }) };
    }
    return mockedFrom(table);
  };
  try {
    const result = await sendBatch(campaign.id, campaign.tenant_id, campaign, 'tenant', null, 1,
      { deadline: Date.now() - 1 });
    assert.notEqual(result.code, 'MEMBER_CAMPAIGN_AUTHORITY_CHANGED');
  } finally {
    supabase.from = mockedFrom;
    mock.restore();
  }
});

test('real sendBatch with an expired invocation budget never claims a recipient', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'sending',
    from_email: 'sender@example.com', category_review_required: false,
    subject: 'Hello', html_content: '<p>Hello</p>',
  };
  const mock = installCampaignMock(campaign);
  try {
    // Outcome counting may fail in this intentionally minimal DB mock, but
    // provider ownership must still be untouched by the expired worker.
    await sendBatch(campaign.id, 'tenant-1', campaign, 'fixture', null, 100, { deadline: Date.now() - 1 });
    assert.equal(mock.calls.some(({ table, method, args }) =>
      table === 'email_campaign_recipient' && method === 'update'
      && args[0]?.status === 'processing'), false);
  } finally {
    mock.restore();
  }
});

test('resume rejects processing-only recipients for explicit provider reconciliation', async () => {
  const campaign = {
    id: 'campaign-1', tenant_id: 'tenant-1', status: 'paused',
    from_email: 'sender@example.com', category_review_required: false,
    target_type: 'all_members', target_ids: [], target_audiences: [],
  };
  const originalFrom = supabase.from;
  const writes = [];
  supabase.from = table => {
    const filters = {};
    const q = {
      select() { return this; },
      eq(key, value) { filters[key] = value; return this; },
      update(value) { writes.push(value); return this; },
      single: async () => ({ data: campaign, error: null }),
      then(resolve) {
        resolve({ count: filters.status === 'processing' ? 2 : 0, error: null });
      },
    };
    assert.ok(['email_campaign', 'email_campaign_recipient'].includes(table));
    return q;
  };
  try {
    const result = await resumeCampaign(campaign.id, campaign.tenant_id);
    assert.equal(result.success, false);
    assert.match(result.error, /2 processing recipients require provider reconciliation/);
    assert.equal(writes.length, 0);
  } finally {
    supabase.from = originalFrom;
  }
});

test('scheduled cron reports a worker DB failure rather than green success', async () => {
  const originalFrom = supabase.from;
  supabase.from = table => {
    assert.equal(table, 'email_campaign');
    let status;
    return {
      select() { return this; },
      eq(key, value) { if (key === 'status') status = value; return this; },
      lte() { return this; },
      lt() { return this; },
      order() { return this; },
      then(resolve) {
        resolve(status === 'sending'
          ? { data: null, error: new Error('Worker database unavailable') }
          : { data: [], error: null });
      },
    };
  };
  try {
    const result = await processScheduledCampaigns();
    assert.equal(result.success, false);
    assert.match(result.error, /Worker database unavailable/);
  } finally {
    supabase.from = originalFrom;
  }
});
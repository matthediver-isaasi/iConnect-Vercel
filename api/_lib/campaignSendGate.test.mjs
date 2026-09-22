import assert from 'node:assert/strict';
import test from 'node:test';

// A syntactically valid but non-routable URL creates an inert client whose
// query entry point is replaced below. The isolation runner additionally
// rejects any accidental network/provider submission.
process.env.SUPABASE_URL = 'https://campaign-send-gate.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';

const { supabase } = await import('./database.js');
const { resumeCampaign, sendBatch } = await import('./campaignService.js');

function installCampaignMock(campaign) {
  const calls = [];
  const originalFrom = supabase.from;

  supabase.from = (table) => {
    calls.push({ table, method: 'from' });
    const query = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
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
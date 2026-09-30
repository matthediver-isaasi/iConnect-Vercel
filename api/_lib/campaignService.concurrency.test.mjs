import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://campaign-concurrency.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
const { supabase } = await import('./database.js');
const {
  updateCampaign, deleteCampaign, sendCampaign, scheduleCampaign,
  returnScheduledCampaignToDraft, processScheduledCampaigns, resumeCampaign, pauseCampaign, cancelCampaign,
} = await import('./campaignService.js');

// Execute filters against the current row at mutation time, not read time.
// Hooks deterministically place the competing request at the race boundary.
function database(t, overrides = {}) {
  const state = {
    row: {
      id: 'campaign', tenant_id: 'tenant', name: 'Campaign', status: 'draft',
      updated_at: '2020-01-01T00:00:00.000Z', scheduled_at: null,
      category_review_required: false, from_email: 'sender@example.com',
      subject: 'Original', target_type: 'member_group', target_ids: ['group'],
      target_audiences: [], ...overrides,
    },
    claims: [], childWrites: 0, recipients: [], submissionClaims: 0,
  };
  const original = supabase.from;
  const originalRpc = supabase.rpc;
  supabase.rpc = () => {
    state.submissionClaims++;
    throw new Error('Unexpected provider-batch claim');
  };
  t.after(() => { supabase.from = original; supabase.rpc = originalRpc; });
  supabase.from = (table) => {
    let operation = 'read', values, single = false, fields;
    const filters = [];
    const query = {
      select(value) { fields = value; return this; },
      update(value) { operation = 'update'; values = value; return this; },
      insert(value) { operation = 'insert'; values = value; return this; },
      delete() { operation = 'delete'; return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      lt(key, value) { filters.push(row => row[key] < value); return this; },
      lte(key, value) { filters.push(row => row[key] <= value); return this; },
      limit() { return this; },
      order() { return this; },
      range() { return this; },
      not() { return this; },
      single() { single = true; return this; },
      maybeSingle() { single = true; return this; },
      async then(resolve, reject) {
        try {
          if (table !== 'email_campaign') {
            if (state.allowRecipients) {
              if (table === 'member_group_assignment') {
                resolve({ data: state.emptyAudience ? [] : [{ member_id: 'member' }], error: null });
                return;
              }
              if (table === 'member') {
                resolve({ data: [{ id: 'member', email: 'recipient@example.com' }], error: null });
                return;
              }
              if (table === 'tenant' && fields === 'plan_code') {
                resolve({ data: { plan_code: 'test' }, error: null }); return;
              }
              if (table === 'plan') {
                resolve({ data: { quotas: {} }, error: null }); return;
              }
              if (table === 'email_campaign_recipient') {
                if (operation === 'update' && values.status === 'processing') {
                  state.submissionClaims++;
                  throw new Error('Unexpected provider-batch claim');
                }
                if (operation === 'insert') {
                  if (state.beforeInsert) await state.beforeInsert();
                  state.recipients.push(...values.map(row => ({ ...row })));
                  if (state.insertError) throw new Error('Recipient insert failed');
                }
                const rows = state.recipients.filter(row => filters.every(filter => filter(row)));
                if (operation === 'update') rows.forEach(row => Object.assign(row, values));
                resolve({ data: structuredClone(rows), count: rows.length, error: null }); return;
              }
            }
            if (table === 'email_campaign_recipient' && operation === 'read' && state.pendingCount) {
              resolve({ count: state.pendingCount, error: null });
              return;
            }
            if (operation !== 'read') state.childWrites++;
            throw new Error(`Stopped before recipient/provider work: ${table}`);
          }
          if (operation === 'update' && values.status === 'preparing' && state.beforeClaim) {
            const hook = state.beforeClaim; state.beforeClaim = null; await hook();
          }
          if (operation === 'update' && values.status === 'scheduled' && state.beforeSchedule) {
            const hook = state.beforeSchedule; state.beforeSchedule = null; await hook();
          }
          if (operation === 'update' && values.status === 'sending' && state.beforeResume) {
            const hook = state.beforeResume; state.beforeResume = null; await hook();
          }
          const matches = state.row && filters.every(filter => filter(state.row));
          let data = matches ? structuredClone(state.row) : null;
          if (matches && operation === 'update') {
            Object.assign(state.row, values);
            data = structuredClone(state.row);
            if (values.status === 'preparing') {
              state.claims.push(data);
              if (state.afterClaim) await state.afterClaim();
            }
          } else if (matches && operation === 'delete') {
            state.row = null;
          }
          if (operation === 'read' && fields?.includes('scheduled_at, updated_at') && state.afterSelection) {
            await state.afterSelection();
          }
          resolve({ data: single ? data : data ? [data] : [], error: null });
        } catch (error) { reject(error); }
      },
    };
    return query;
  };
  return state;
}

const draft = { expectedStatus: 'draft' };

for (const timing of ['before reload', 'at transition']) {
  for (const field of ['status', 'updated_at']) {
    test(`resume rejects changed ${field} ${timing}`, async t => {
      const state = database(t, { status: 'paused' });
      state.pendingCount = 1;
      const options = { expectedStatus: 'paused', expectedUpdatedAt: state.row.updated_at };
      const change = () => { state.row[field] = field === 'status' ? 'cancelled' : '2026-01-01T00:00:00.000Z'; };
      if (timing === 'before reload') change();
      else state.beforeResume = change;
      const result = await resumeCampaign('campaign', 'tenant', 'member', options);
      assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
      assert.notEqual(state.row.status, 'sending');
      assert.equal(state.childWrites, 0);
    });
  }
}

test('two resumes of the validated version cannot both win', async t => {
  const state = database(t, { status: 'paused' });
  state.pendingCount = 1;
  const options = { expectedStatus: 'paused', expectedUpdatedAt: state.row.updated_at };
  state.beforeResume = async () => {
    assert.equal((await resumeCampaign('campaign', 'tenant', 'other', options)).success, true);
  };
  assert.equal((await resumeCampaign('campaign', 'tenant', 'member', options)).code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row.status, 'sending');
});

test('edit winning after send read invalidates the content snapshot', async t => {
  const state = database(t);
  state.beforeClaim = async () => {
    assert.equal((await updateCampaign('campaign', { subject: 'Edited' }, 'tenant', draft)).success, true);
  };
  const result = await sendCampaign('campaign', 'tenant', null, draft);
  assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row.subject, 'Edited');
  assert.equal(state.row.status, 'draft');
  assert.equal(state.claims.length, 0);
  assert.equal(state.childWrites, 0);
});

test('send claim winning blocks draft edit, delete, and scheduled-to-draft', async t => {
  const state = database(t);
  state.afterClaim = async () => {
    for (const result of [
      await updateCampaign('campaign', { subject: 'Too late' }, 'tenant', draft),
      await deleteCampaign('campaign', 'tenant', draft),
      await returnScheduledCampaignToDraft('campaign', 'tenant'),
    ]) assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
    assert.equal(state.row.status, 'preparing');
    assert.equal(state.row.subject, 'Original');
    assert.equal(state.childWrites, 0);
  };
  await sendCampaign('campaign', 'tenant', null, draft);
  assert.equal(state.claims.length, 1);
});

test('delete winning after send read prevents the claim without pre-deleting recipients', async t => {
  const state = database(t);
  state.beforeClaim = async () => {
    assert.equal((await deleteCampaign('campaign', 'tenant', draft)).success, true);
  };
  assert.equal((await sendCampaign('campaign', 'tenant', null, draft)).code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row, null);
  assert.equal(state.claims.length, 0);
  assert.equal(state.childWrites, 0);
});

test('schedule claim loses to a competing draft edit', async t => {
  const state = database(t);
  state.beforeSchedule = async () => {
    assert.equal((await updateCampaign('campaign', { subject: 'Edited' }, 'tenant', draft)).success, true);
  };
  assert.equal((await scheduleCampaign('campaign', 'tenant', new Date('2099-01-01'), draft)).code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row.status, 'draft');
});

for (const operation of ['send', 'schedule']) {
  test(`${operation} rejects endpoint-validated snapshot changed before service reload`, async t => {
    const state = database(t);
    const validatedOptions = { expectedStatus: 'draft', expectedUpdatedAt: state.row.updated_at };
    assert.equal((await updateCampaign('campaign', { subject: 'Not validated by endpoint' }, 'tenant', draft)).success, true);
    const result = operation === 'send'
      ? await sendCampaign('campaign', 'tenant', null, validatedOptions)
      : await scheduleCampaign('campaign', 'tenant', new Date('2099-01-01'), validatedOptions);
    assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
    assert.equal(state.row.status, 'draft');
    assert.equal(state.claims.length, 0);
    assert.equal(state.childWrites, 0);
  });

  test(`${operation} binds endpoint-validated version through atomic claim`, async t => {
    const state = database(t);
    const validatedOptions = { expectedStatus: 'draft', expectedUpdatedAt: state.row.updated_at };
    state[operation === 'send' ? 'beforeClaim' : 'beforeSchedule'] = async () => {
      assert.equal((await updateCampaign('campaign', { subject: 'Changed during claim' }, 'tenant', draft)).success, true);
    };
    const result = operation === 'send'
      ? await sendCampaign('campaign', 'tenant', null, validatedOptions)
      : await scheduleCampaign('campaign', 'tenant', new Date('2099-01-01'), validatedOptions);
    assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
    assert.equal(state.row.status, 'draft');
    assert.equal(state.claims.length, 0);
    assert.equal(state.childWrites, 0);
  });
}

test('schedule winner blocks subsequent draft mutation and is explicitly returnable', async t => {
  const state = database(t);
  assert.equal((await scheduleCampaign('campaign', 'tenant', new Date('2099-01-01'), draft)).success, true);
  assert.equal((await updateCampaign('campaign', { subject: 'No' }, 'tenant', draft)).code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal((await deleteCampaign('campaign', 'tenant', draft)).code, 'CAMPAIGN_STATE_CONFLICT');
  const result = await returnScheduledCampaignToDraft('campaign', 'tenant');
  assert.equal(result.success, true);
  assert.equal(state.row.status, 'draft');
  assert.equal(state.row.scheduled_at, null);
});

test('return-to-draft winning after worker read prevents preparation', async t => {
  const state = database(t, { status: 'scheduled', scheduled_at: '2020-02-01T00:00:00.000Z' });
  state.beforeClaim = async () => {
    assert.equal((await returnScheduledCampaignToDraft('campaign', 'tenant')).success, true);
  };
  const result = await sendCampaign('campaign', 'tenant', null, {
    expectedStatus: 'scheduled',
    expectedScheduledAt: state.row.scheduled_at,
    expectedUpdatedAt: state.row.updated_at,
  });
  assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row.status, 'draft');
  assert.equal(state.row.scheduled_at, null);
  assert.equal(state.claims.length, 0);
});

test('return and reschedule advance the generation even with a clock behind the row', async t => {
  const state = database(t, {
    status: 'scheduled', scheduled_at: '2099-02-01T00:00:00.000Z',
    updated_at: '2099-01-01T00:00:00.000Z',
  });
  const selectedVersion = state.row.updated_at;
  assert.equal((await returnScheduledCampaignToDraft('campaign', 'tenant')).success, true);
  assert.ok(state.row.updated_at > selectedVersion);
  const draftVersion = state.row.updated_at;
  assert.equal((await scheduleCampaign('campaign', 'tenant', new Date('2099-02-01'), draft)).success, true);
  assert.ok(state.row.updated_at > draftVersion);
});

for (const change of ['draft', 'rescheduled', 'same-time-rescheduled']) {
  test(`scheduled worker rejects a stale selected row: ${change}`, async t => {
    const state = database(t, { status: 'scheduled', scheduled_at: '2020-02-01T00:00:00.000Z' });
    state.afterSelection = async () => {
      state.row.status = change === 'draft' ? 'draft' : 'scheduled';
      state.row.scheduled_at = change === 'draft' ? null
        : change === 'rescheduled' ? '2099-01-01T00:00:00.000Z' : state.row.scheduled_at;
      state.row.updated_at = '2025-01-01T00:00:00.000Z';
    };
    const result = await processScheduledCampaigns();
    assert.equal(result.campaigns[0].code, 'CAMPAIGN_STATE_CONFLICT');
    assert.equal(state.claims.length, 0);
    assert.equal(state.childWrites, 0);
  });
}

test('claim uses freshly returned content even if two writes share a timestamp', async t => {
  const state = database(t);
  state.beforeClaim = async () => {
    state.row.subject = 'Fresh';
    // Invalid sender ensures the fresh claimed row is revalidated, and no
    // recipient resolution or provider operation occurs.
    state.row.from_email = 'invalid';
  };
  const result = await sendCampaign('campaign', 'tenant', null, draft);
  assert.equal(state.claims[0].subject, 'Fresh');
  assert.match(result.error, /Sender Information/);
  assert.equal(state.row.status, 'draft');
  assert.equal(state.childWrites, 0);
});

test('guarded mutations cannot affect another tenant', async t => {
  const state = database(t, { status: 'scheduled' });
  assert.equal((await returnScheduledCampaignToDraft('campaign', 'other')).success, false);
  assert.equal((await deleteCampaign('campaign', 'other', { expectedStatus: 'scheduled' })).success, false);
  assert.equal(state.row.status, 'scheduled');
});

for (const status of ['paused', 'cancelled']) {
  for (const timing of ['afterClaim', 'beforeInsert', 'beforeResume']) {
    test(`${status} ${timing} preserves operator state and never submits newly prepared recipients`, async t => {
      const state = database(t, { ignore_opt_outs: true });
      state.allowRecipients = true;
      state[timing] = async () => {
        const result = status === 'paused'
          ? await pauseCampaign('campaign', 'tenant')
          : await cancelCampaign('campaign', 'tenant');
        assert.equal(result.success, true);
      };
      const result = await sendCampaign('campaign', 'tenant', null, draft);
      assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
      assert.equal(result.status, status);
      assert.equal(state.row.status, status);
      assert.equal(state.recipients.length, 1);
      assert.equal(state.recipients[0].status, status === 'cancelled' ? 'cancelled' : 'pending');
      assert.equal(state.submissionClaims, 0);
    });
  }
  for (const failure of ['empty', 'resolution', 'insert']) {
    test(`${status} during preparation survives ${failure} failure`, async t => {
      const state = database(t, { ignore_opt_outs: true });
      state.allowRecipients = failure !== 'resolution';
      state.emptyAudience = failure === 'empty';
      state.insertError = failure === 'insert';
      state.afterClaim = async () => {
        // Model the committed operator transition. For resolution failures
        // the mock intentionally rejects all subsequent recipient queries.
        state.row.status = status;
        state.row.updated_at = '2099-01-01T00:00:00.000Z';
      };
      await sendCampaign('campaign', 'tenant', null, draft);
      assert.equal(state.row.status, status);
      assert.equal(state.submissionClaims, 0);
      if (failure === 'insert') {
        assert.equal(state.recipients[0].status, status === 'cancelled' ? 'cancelled' : 'pending');
      }
    });
  }
}

test('preparation finalization rejects a newer generation even with the same preparing status', async t => {
  const state = database(t, { ignore_opt_outs: true });
  state.allowRecipients = true;
  state.beforeResume = async () => {
    state.row.updated_at = '2099-01-01T00:00:00.000Z';
  };
  const result = await sendCampaign('campaign', 'tenant', null, draft);
  assert.equal(result.code, 'CAMPAIGN_STATE_CONFLICT');
  assert.equal(state.row.status, 'preparing');
  assert.equal(state.row.updated_at, '2099-01-01T00:00:00.000Z');
  assert.equal(state.submissionClaims, 0);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Import the actual campaign helper, including from data: handler modules.
// Everything capable of accessing a database/provider is replaced below.
const helperUrl = new URL('../../_lib/campaignInbox.js', import.meta.url).href;
const { campaignInboxUnreadSummary, verifyCampaignInboxRecipients } = await import(helperUrl);
const stateKey = '__campaignEligibility5161';
const handlers = {};
for (const name of ['index', 'search', '[id]', 'unread-count']) {
  const source = (await readFile(new URL(`./${name}.js`, import.meta.url), 'utf8'))
    .replace(/import \{ supabase \} from '[^']+';/, `const supabase = globalThis.${stateKey}.db;`)
    .replace(/from '\.\.\/\.\.\/_lib\/campaignInbox\.js'/g, `from '${helperUrl}'`)
    .replace(/import \{ getTenantContext, hasFeatureAccess \} from '[^']+';/,
      `const getTenantContext = async () => globalThis.${stateKey}.ctx;
       const hasFeatureAccess = async () => globalThis.${stateKey}.access;`)
    .replace(/import \{ stripHiddenDynamicRegions, applyDynamicSlotValues \} from '[^']+';/,
      'const stripHiddenDynamicRegions = html => html; const applyDynamicSlotValues = html => html;')
    .replace(/import \{ resolveTransactionalInboxLabel \} from '[^']+';/,
      "const resolveTransactionalInboxLabel = (key, category) => category || key || 'Notification';")
    .replace(/import \{ ([^}]+) \} from '[^']*projectMainInbox\.js';/,
      (_, names) => `const { ${names} } = globalThis.${stateKey}.project;`);
  handlers[name] = `const console = { error: (...args) => globalThis.${stateKey}.errors.push(args) };\n${source}`;
}

const tenantId = 'tenant-self';
const memberId = 'member-self';
const projectId = '10000000-0000-0000-0000-000000000001';
const sentAt = '2026-10-01T10:00:00.000Z';
const valueAt = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
const recipient = (id, extra = {}, campaign = {}) => ({
  id, campaign_id: `campaign-${id}`, member_id: memberId, sent_at: sentAt,
  delivery_is_test: false, status: 'sent', first_name: 'Ada', last_name: 'Lovelace',
  email: 'ada@example.invalid',
  email_campaign: {
    id: `campaign-${id}`, tenant_id: tenantId, subject: `Subject ${id}`,
    html_content: '<p>needle {{first_name}}</p>', is_test_mode: false,
    sent_at: sentAt, status: 'sent', ...campaign,
  },
  ...extra,
});
const messageState = (id, extra = {}) => ({
  tenant_id: tenantId, member_id: memberId, recipient_id: id,
  is_read: false, is_archived: false, is_pinned: false, is_favourite: false,
  folder_id: null, ...extra,
});
const transactional = (extra = {}) => ({
  id: 'txn-self', tenant_id: tenantId, member_id: memberId, subject: 'Transaction',
  body_html: '<p>needle transactional</p>', sent_at: sentAt, is_read: false,
  is_archived: false, is_favourite: true, folder_id: 'folder-self', ...extra,
});
// A strict, capped PostgREST model. The view is modeled separately from the
// base table so accidentally switching to the base table exposes excluded rows.
function fixture() {
  const f = {
    ctx: { tenantId, memberId }, access: true, reads: [], writes: [], rpcs: [], errors: [],
    missingView: false, rpcError: null,
    summary: [{ unread_count: '0', latest_recipient_id: null }],
    tables: {
      email_campaign_recipient: [
        recipient('live'),
        recipient('dry-run', { delivery_is_test: true }),
        recipient('unknown', { delivery_is_test: null }),
        recipient('unsent', { sent_at: null }),
        recipient('foreign-member', { member_id: 'other' }),
        recipient('foreign-tenant', {}, { tenant_id: 'other' }),
      ],
      member_inbox_message_state: [],
      member_inbox_folder: [{ id: 'folder-self', tenant_id: tenantId, member_id: memberId, name: 'Saved' }],
      member_transactional_message: [transactional()],
      communication_category: [],
    },
    projectRows: [{
      recipient_id: projectId, subject: 'Project needle', preheader: 'Mention',
      sent_at: sentAt, source: 'project', is_read: false, is_archived: false,
    }],
    projectSummary: { count: 1, latest: null },
  };
  function query(table) {
    const q = { table, filters: [], orders: [], operation: 'select', payload: null };
    const chain = {
      select(columns, options) { q.columns = columns; q.options = options; return this; },
      eq(key, value) { q.filters.push([key, value]); return this; },
      in(key, values) { q.filters.push([key, values]); return this; },
      order(key, options) { q.orders.push([key, options]); return this; },
      range(start, end) { q.range = [start, end]; return this; },
      limit(limit) { q.limit = limit; return this; },
      maybeSingle() { q.single = true; return this; },
      upsert(payload, options) { q.operation = 'upsert'; q.payload = payload; q.conflict = options; return this; },
      update(payload) { q.operation = 'update'; q.payload = payload; return this; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          f.reads.push(structuredClone(q));
          if (table === 'campaign_inbox_recipient' && f.missingView) {
            return { data: null, error: new Error('relation campaign_inbox_recipient does not exist') };
          }
          let rows;
          if (table === 'campaign_inbox_recipient') {
            rows = f.tables.email_campaign_recipient.filter(r => r.sent_at !== null && r.delivery_is_test === false);
          } else {
            assert.ok(table in f.tables, `Unexpected table ${table}`);
            rows = f.tables[table];
          }
          rows = rows.filter(row => q.filters.every(([key, value]) =>
            Array.isArray(value) ? value.includes(valueAt(row, key)) : valueAt(row, key) === value));
          if (q.operation !== 'select') {
            f.writes.push(structuredClone(q));
            if (q.operation === 'upsert') {
              rows = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(patch => {
                let row = f.tables[table].find(r => r.member_id === patch.member_id && r.recipient_id === patch.recipient_id);
                if (!row) {
                  row = messageState(patch.recipient_id);
                  f.tables[table].push(row);
                }
                Object.assign(row, patch);
                return row;
              });
            } else {
              rows.forEach(row => Object.assign(row, q.payload));
            }
          }
          rows = [...rows].sort((a, b) => {
            for (const [key, options] of q.orders) {
              const delta = String(valueAt(a, key)).localeCompare(String(valueAt(b, key)));
              if (delta) return options?.ascending === false ? -delta : delta;
            }
            return 0;
          });
          const count = rows.length;
          const [start, end] = q.range || [0, (q.limit || 1000) - 1];
          rows = rows.slice(start, end + 1);
          return { data: q.options?.head ? null : structuredClone(q.single ? rows[0] || null : rows), count, error: null };
        }).then(resolve, reject);
      },
    };
    return chain;
  }
  f.db = {
    from: query,
    rpc: async (name, params) => {
      f.rpcs.push({ name, params });
      assert.equal(name, 'campaign_inbox_unread_summary');
      return { data: f.summary, error: f.rpcError };
    },
  };
  f.project = {
    fetchProjectMessages: async () => structuredClone(f.projectRows),
    projectInboxScope: async () => ({ query: () => query('project_fixture') }),
    verifyProjectMessages: async (_scope, ids) => {
      if (ids.some(id => !f.projectRows.some(r => r.recipient_id === id))) {
        throw Object.assign(new Error('Message not found'), { status: 404 });
      }
    },
    updateProjectMessages: async (_db, _scope, ids, action, folder) => {
      f.writes.push({ table: 'project', ids, action, folder });
      return ids.map(id => ({ recipient_id: id, is_read: action === 'read' }));
    },
    projectMessage: row => ({ ...row, recipient_id: row.id, source: 'project' }),
    projectMessageHtml: content => `<p>${content}</p>`,
    projectUnreadSummary: async () => f.projectSummary,
  };
  // Detail's project path uses its own already-scoped relation.
  f.tables.project_fixture = [{ id: projectId, content: 'Project body' }];
  globalThis[stateKey] = f;
  return f;
}
let moduleSequence = 0;
async function call(f, route, { method = 'GET', query = {}, body } = {}) {
  globalThis[stateKey] = f;
  const source = `${handlers[route]}\n// isolated fixture ${moduleSequence++}`;
  const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const res = {
    code: 200, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method, query, body }, res);
  return res;
}
function assertNoBaseReads(f) {
  assert.equal(f.reads.some(r => r.table === 'email_campaign_recipient' || r.table === 'email_campaign'), false);
}
function assertScoped(f, table, tenantKey = 'tenant_id') {
  const reads = f.reads.filter(r => r.table === table);
  assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.ok(read.filters.some(([k, v]) => k === 'member_id' && v === memberId));
    assert.ok(read.filters.some(([k, v]) => k === tenantKey && v === tenantId));
  }
}

test('SQL contract: service-only eligibility excludes NULL and backfills legacy NULL campaign flags as live', async () => {
  const sql = await readFile(new URL('../../../supabase/migrations/20261018_campaign_inbox_delivery_mode.sql', import.meta.url), 'utf8');
  assert.match(sql, /SET delivery_is_test = \(c\.is_test_mode IS TRUE\)/);
  const view = sql.match(/CREATE OR REPLACE VIEW public\.campaign_inbox_recipient[\s\S]*?;/)?.[0];
  assert.match(view, /WHERE r\.sent_at IS NOT NULL AND r\.delivery_is_test IS FALSE/);
  assert.doesNotMatch(view, /is_test_mode|COALESCE/i);
  assert.match(sql, /REVOKE ALL ON public\.campaign_inbox_recipient FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT ON public\.campaign_inbox_recipient TO service_role/);
  assert.match(sql, /FROM public\.campaign_inbox_recipient r/);
  assert.match(sql, /s\.member_id = p_member AND s\.tenant_id = p_tenant/);
});

test('list includes only eligible owned campaigns, preserving folder/favourite/archive state and other sources', async () => {
  const f = fixture();
  f.tables.member_inbox_message_state = [
    messageState('live', { is_favourite: true, is_archived: true, is_pinned: true, folder_id: 'folder-self' }),
    messageState('dry-run', { is_favourite: true, folder_id: 'folder-self' }),
    messageState('unknown', { is_archived: true }),
    messageState('orphan', { is_read: true }),
  ];
  const res = await call(f, 'index');
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.messages.map(m => m.recipient_id).sort(), [projectId, 'live', 'txn-self'].sort());
  const live = res.body.messages.find(m => m.recipient_id === 'live');
  assert.deepEqual([live.is_favourite, live.is_archived, live.is_pinned, live.folder_id], [true, true, true, 'folder-self']);
  assert.equal(res.body.folders[0].id, 'folder-self');
  assert.equal(res.body.unreadCount, 2);
  assert.equal(f.writes.length, 0);
  assertScoped(f, 'campaign_inbox_recipient', 'email_campaign.tenant_id');
  assertScoped(f, 'member_inbox_message_state');
  assertScoped(f, 'member_transactional_message');
  assertNoBaseReads(f);
});

test('search excludes test/unknown/unsent/foreign campaigns and keeps transactional/project matches', async () => {
  const f = fixture();
  const res = await call(f, 'search', { query: { q: 'needle' } });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.recipientIds.sort(), [projectId, 'live', 'txn-self'].sort());
  const personal = await call(f, 'search', { query: { q: 'needle Ada' } });
  assert.deepEqual(personal.body.recipientIds, ['live']);
  assertScoped(f, 'campaign_inbox_recipient', 'email_campaign.tenant_id');
  assertScoped(f, 'member_transactional_message');
  assertNoBaseReads(f);
  assert.equal(f.writes.length, 0);
});

test('detail auto-read writes only the eligible recipient and preserves existing flags', async () => {
  const f = fixture();
  f.tables.member_inbox_message_state = [messageState('live', { is_favourite: true, folder_id: 'folder-self' })];
  const res = await call(f, '[id]', { query: { id: 'live' } });
  assert.equal(res.code, 200);
  assert.equal(res.body.message.html, '<p>needle Ada</p>');
  assert.equal(res.body.message.is_read, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].table, 'member_inbox_message_state');
  assert.deepEqual(f.writes[0].conflict, { onConflict: 'member_id,recipient_id', ignoreDuplicates: false });
  const saved = f.tables.member_inbox_message_state[0];
  assert.equal(saved.is_read, true);
  assert.ok(Number.isFinite(Date.parse(saved.read_at)));
  assert.equal(saved.is_favourite, true);
  assert.equal(saved.folder_id, 'folder-self');
  assertScoped(f, 'campaign_inbox_recipient', 'email_campaign.tenant_id');
  assertNoBaseReads(f);
});

for (const id of ['dry-run', 'unknown', 'unsent', 'foreign-member', 'foreign-tenant', 'absent']) {
  test(`excluded recipient ${id}: detail and every single action reject without any write`, async () => {
    const f = fixture();
    assert.equal((await call(f, '[id]', { query: { id } })).code, 404);
    for (const action of ['read', 'unread', 'pin', 'unpin', 'archive', 'unarchive', 'favourite', 'unfavourite', 'move']) {
      const res = await call(f, 'index', { method: 'POST', body: { recipient_id: id, action, folder_id: 'folder-self' } });
      assert.equal(res.code, 404, action);
    }
    assert.equal(f.writes.length, 0);
    assertNoBaseReads(f);
  });
}

const actions = {
  read: ['is_read', true], unread: ['is_read', false],
  pin: ['is_pinned', true], unpin: ['is_pinned', false],
  archive: ['is_archived', true], unarchive: ['is_archived', false],
  favourite: ['is_favourite', true], unfavourite: ['is_favourite', false],
  move: ['folder_id', 'folder-self'],
};
for (const [action, [field, expected]] of Object.entries(actions)) {
  test(`eligible single and mixed bulk ${action} preserve campaign/transactional/project action semantics`, async () => {
    const f = fixture();
    const single = await call(f, 'index', { method: 'POST', body: { recipient_id: 'live', action, folder_id: 'folder-self' } });
    assert.equal(single.code, 200);
    assert.equal(single.body.state[field], expected);
    assert.equal('states' in single.body, false);
    const res = await call(f, 'index', { method: 'POST', body: {
      recipient_ids: ['live', 'live'], transactional_ids: ['txn-self'], project_ids: [projectId],
      action, folder_id: 'folder-self',
    } });
    assert.equal(res.code, 200);
    assert.equal(res.body.updated, 3);
    assert.equal(res.body.states.find(s => s.recipient_id === 'live')[field], expected);
    assert.equal(res.body.states.find(s => s.recipient_id === 'txn-self')[field], expected);
    assert.deepEqual(f.writes.at(-1), { table: 'project', ids: [projectId], action, folder: 'folder-self' });
    if (action === 'read') assert.ok(Number.isFinite(Date.parse(single.body.state.read_at)));
    if (action === 'unread') assert.equal(single.body.state.read_at, null);
    assertScoped(f, 'campaign_inbox_recipient', 'email_campaign.tenant_id');
    assertScoped(f, 'member_transactional_message');
    assertNoBaseReads(f);
  });
}

test('every mixed bulk action validates excluded campaign rows before ANY source write', async () => {
  for (const id of ['dry-run', 'unknown', 'unsent', 'foreign-member', 'foreign-tenant', 'absent']) {
    for (const action of Object.keys(actions)) {
      const f = fixture();
      const original = structuredClone(f.tables);
      const res = await call(f, 'index', { method: 'POST', body: {
        recipient_ids: ['live', id], transactional_ids: ['txn-self'], project_ids: [projectId],
        action, folder_id: 'folder-self',
      } });
      assert.equal(res.code, 404, `${id}/${action}`);
      assert.deepEqual(f.writes, [], `${id}/${action}`);
      assert.deepEqual(f.tables, original);
      assertNoBaseReads(f);
    }
  }
});

test('transactional ownership and folder ownership reject mixed batches before campaign writes', async () => {
  for (const extra of [{ member_id: 'other' }, { tenant_id: 'other' }]) {
    const f = fixture();
    Object.assign(f.tables.member_transactional_message[0], extra);
    const res = await call(f, 'index', { method: 'POST', body: {
      recipient_ids: ['live'], transactional_ids: ['txn-self'], project_ids: [projectId], action: 'read',
    } });
    assert.equal(res.code, 404);
    assert.deepEqual(f.writes, []);
  }
  for (const extra of [{ member_id: 'other' }, { tenant_id: 'other' }]) {
    const f = fixture();
    Object.assign(f.tables.member_inbox_folder[0], extra);
    const res = await call(f, 'index', { method: 'POST', body: {
      recipient_ids: ['live'], transactional_ids: ['txn-self'], project_ids: [projectId],
      action: 'move', folder_id: 'folder-self',
    } });
    assert.equal(res.code, 404);
    assert.deepEqual(f.writes, []);
  }
});

test('list/search/state paging and chunked all-message actions cover more than 1000 eligible recipients', async () => {
  const f = fixture();
  const rows = Array.from({ length: 1105 }, (_, i) => recipient(`row-${String(i).padStart(4, '0')}`));
  f.tables.email_campaign_recipient.push(...rows);
  f.tables.member_inbox_message_state = rows.map(r => messageState(r.id, { is_read: true, is_favourite: true }));
  const list = await call(f, 'index');
  assert.equal(list.code, 200);
  assert.equal(list.body.messages.filter(m => m.campaign_id).length, 1106);
  assert.equal(list.body.messages.find(m => m.recipient_id === rows.at(-1).id).is_favourite, true);
  assert.equal(list.body.unreadCount, 3);
  const search = await call(f, 'search', { query: { q: 'needle' } });
  assert.equal(search.body.recipientIds.length, 1108);
  assert.ok(search.body.recipientIds.includes(rows.at(-1).id));
  const ids = ['live', ...rows.map(r => r.id)];
  const updated = await call(f, 'index', { method: 'POST', body: { recipient_ids: ids, action: 'archive' } });
  assert.equal(updated.code, 200);
  // PostgREST caps mutation representations too; validate ALL persisted rows,
  // not merely the capped states returned to the caller.
  assert.equal(f.writes.at(-1).payload.length, ids.length);
  assert.ok(ids.every(id => f.tables.member_inbox_message_state.find(s => s.recipient_id === id)?.is_archived));
  const pages = f.reads.filter(r => r.table === 'campaign_inbox_recipient' && r.range);
  assert.deepEqual(pages.map(r => r.range), [[0, 999], [1000, 1999], [0, 999], [1000, 1999]]);
  assert.deepEqual(f.reads.filter(r => r.table === 'member_inbox_message_state' && r.range).map(r => r.range), [[0, 999], [1000, 1999]]);
  const checks = f.reads.filter(r => r.table === 'campaign_inbox_recipient' && r.filters.some(([k]) => k === 'id'));
  assert.equal(checks.length, 12);
  assert.ok(checks.every(r => r.filters.find(([k]) => k === 'id')[1].length <= 100));
  assertNoBaseReads(f);
});

test('invalid recipient in a late validation chunk prevents even earlier valid batch writes', async () => {
  const f = fixture();
  const rows = Array.from({ length: 1105 }, (_, i) => recipient(`bulk-${i}`));
  f.tables.email_campaign_recipient.push(...rows);
  const res = await call(f, 'index', { method: 'POST', body: {
    recipient_ids: [...rows.map(r => r.id), 'unknown'],
    transactional_ids: ['txn-self'], project_ids: [projectId], action: 'read',
  } });
  assert.equal(res.code, 404);
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads.filter(r => r.table === 'campaign_inbox_recipient').length, 12);
});

test('mutable campaign test/status flags never change recorded live/test eligibility', async () => {
  const f = fixture();
  for (const mode of [true, false, null]) {
    for (const row of f.tables.email_campaign_recipient) {
      row.email_campaign.is_test_mode = mode;
      row.email_campaign.status = 'draft';
    }
    const list = await call(f, 'index');
    assert.deepEqual(list.body.messages.filter(m => m.campaign_id).map(m => m.recipient_id), ['live']);
    const search = await call(f, 'search', { query: { q: 'needle Ada' } });
    assert.deepEqual(search.body.recipientIds, ['live']);
    assert.equal((await call(f, '[id]', { query: { id: 'live' } })).code, 200);
    assert.equal((await call(f, '[id]', { query: { id: 'dry-run' } })).code, 404);
    assert.equal((await call(f, 'index', { method: 'POST', body: { recipient_id: 'live', action: 'pin' } })).code, 200);
    assert.equal((await call(f, 'index', { method: 'POST', body: { recipient_id: 'dry-run', action: 'pin' } })).code, 404);
  }
  assertNoBaseReads(f);
});

test('missing eligibility schema fails closed for list/search/detail and mixed writes without base fallback', async () => {
  const f = fixture();
  f.missingView = true;
  for (const [route, options] of [
    ['index', {}], ['search', { query: { q: 'needle' } }], ['[id]', { query: { id: 'live' } }],
    ['index', { method: 'POST', body: {
      recipient_ids: ['live'], transactional_ids: ['txn-self'], project_ids: [projectId], action: 'read',
    } }],
  ]) {
    const res = await call(f, route, options);
    assert.equal(res.code, 500, route);
    assert.ok(res.body.error);
    assert.equal('messages' in res.body, false);
  }
  await assert.rejects(verifyCampaignInboxRecipients(f.db, ['live'], memberId, tenantId), /does not exist/);
  assert.deepEqual(f.writes, []);
  assertNoBaseReads(f);
});

test('unread uses authoritative RPC bigint count and latest preview, adding unchanged transactional/project summaries', async () => {
  const f = fixture();
  f.summary = [{
    unread_count: '12345', latest_subject: 'Campaign newest', latest_recipient_id: 'rpc-only-id',
    latest_sent_at: '2026-10-03T00:00:00Z',
  }];
  f.projectSummary = { count: 7, latest: { subject: 'Project older', recipientId: projectId, sentAt } };
  f.tables.member_transactional_message.push(
    transactional({ id: 'foreign', member_id: 'other' }),
    transactional({ id: 'foreign-tenant', tenant_id: 'other' }),
    transactional({ id: 'archived', is_archived: true }),
    transactional({ id: 'read', is_read: true }),
  );
  const res = await call(f, 'unread-count');
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, {
    unreadCount: 12353, latestSubject: 'Campaign newest',
    latestMessageId: 'rpc-only-id', latestSentAt: '2026-10-03T00:00:00Z',
  });
  assert.deepEqual(f.rpcs, [{ name: 'campaign_inbox_unread_summary', params: { p_tenant: tenantId, p_member: memberId } }]);
  assertScoped(f, 'member_transactional_message');
  assert.equal(f.reads.some(r => r.table === 'campaign_inbox_recipient' || r.table === 'member_inbox_message_state'), false);
  assert.equal(f.writes.length, 0);
  assertNoBaseReads(f);
});

test('unread picks latest of campaign/transactional/project and returns null preview for an empty inbox', async () => {
  for (const source of ['transactional', 'project', 'empty']) {
    const f = fixture();
    f.projectSummary = { count: 0, latest: null };
    f.tables.member_transactional_message = source === 'transactional' ? [transactional()] : [];
    if (source === 'project') f.projectSummary = {
      count: 1, latest: { subject: 'Project latest', recipientId: projectId, sentAt },
    };
    const res = await call(f, 'unread-count');
    assert.equal(res.code, 200);
    assert.equal(res.body.unreadCount, source === 'empty' ? 0 : 1);
    assert.equal(res.body.latestMessageId, source === 'empty' ? null : source === 'project' ? projectId : 'txn-self');
    assert.equal(res.body.latestSubject, source === 'empty' ? null : source === 'project' ? 'Project latest' : 'Transaction');
    assert.equal(res.body.latestSentAt, source === 'empty' ? null : sentAt);
  }
});

test('unread missing RPC or empty RPC response fails closed, never recomputing from capped tables', async () => {
  for (const missing of ['rpc', 'row']) {
    const f = fixture();
    if (missing === 'rpc') f.rpcError = new Error('function campaign_inbox_unread_summary does not exist');
    else f.summary = [];
    await assert.rejects(campaignInboxUnreadSummary(f.db, memberId, tenantId));
    const res = await call(f, 'unread-count');
    assert.equal(res.code, 500);
    assert.deepEqual(res.body, { error: 'Failed to compute unread count' });
    assertNoBaseReads(f);
    assert.equal(f.reads.some(r => r.table === 'campaign_inbox_recipient'), false);
    assert.deepEqual(f.writes, []);
  }
});

test('transactional and project detail paths remain independent of unavailable campaign eligibility schema', async () => {
  const f = fixture();
  f.missingView = true;
  const txn = await call(f, '[id]', { query: { id: 'txn-self', source: 'transactional' } });
  assert.equal(txn.code, 200);
  assert.equal(txn.body.message.html, '<p>needle transactional</p>');
  assert.equal(txn.body.message.source, 'transactional');
  assert.equal(f.tables.member_transactional_message[0].is_read, true);
  const project = await call(f, '[id]', { query: { id: projectId, source: 'project' } });
  assert.equal(project.code, 200);
  assert.equal(project.body.message.html, '<p>Project body</p>');
  assert.equal(project.body.message.is_read, true);
  assert.equal(f.writes.at(-1).table, 'project');
  assert.equal(f.reads.some(r => r.table === 'campaign_inbox_recipient'), false);
});

test('transactional/project-only actions and move-to-inbox stay independent of campaign eligibility', async () => {
  const f = fixture();
  f.missingView = true;
  const txn = await call(f, 'index', { method: 'POST', body: { transactional_id: 'txn-self', action: 'read' } });
  assert.equal(txn.code, 200);
  assert.equal(txn.body.state.is_read, true);
  const project = await call(f, 'index', { method: 'POST', body: { project_id: projectId, action: 'archive' } });
  assert.equal(project.code, 200);
  assert.equal(project.body.state.recipient_id, projectId);
  const moved = await call(f, 'index', { method: 'POST', body: { transactional_id: 'txn-self', action: 'move' } });
  assert.equal(moved.code, 200);
  assert.equal(moved.body.state.folder_id, null);
  assert.equal(f.reads.some(r => r.table === 'campaign_inbox_recipient'), false);
});

test('foreign transactional detail and unowned project bulk selections cannot write', async () => {
  for (const extra of [{ member_id: 'other' }, { tenant_id: 'other' }]) {
    const f = fixture();
    Object.assign(f.tables.member_transactional_message[0], extra);
    const res = await call(f, '[id]', { query: { id: 'txn-self', source: 'transactional' } });
    assert.equal(res.code, 404);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.projectRows = [];
  const res = await call(f, 'index', { method: 'POST', body: {
    recipient_ids: ['live'], transactional_ids: ['txn-self'], project_ids: [projectId], action: 'read',
  } });
  assert.equal(res.code, 404);
  assert.deepEqual(f.writes, []);
});

test('every handler rejects unauthenticated/memberless/feature-denied sessions without reads or writes', async () => {
  for (const route of Object.keys(handlers)) {
    for (const [ctx, access, status] of [
      [null, true, 401], [{ tenantId }, true, 401],
      [{ tenantId, memberId, roleId: 'blocked' }, false, 403],
    ]) {
      const f = fixture();
      f.ctx = ctx;
      f.access = access;
      const res = await call(f, route, { query: { id: 'live', q: 'needle' } });
      assert.equal(res.code, status, route);
      assert.deepEqual(f.reads, []);
      assert.deepEqual(f.rpcs, []);
      assert.deepEqual(f.writes, []);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArticlePreviewHandler, limitPreviewAttempts } from './article-preview.js';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(options = {}) {
  const reads = [];
  const row = { tenant_id: 'tenant-a', id, share_password: '1234', title: 'Private draft', content: '<p>Draft</p>', author_id: 'author', ...options.row };
  let articleReads = 0;
  const db = { from(table) {
    const filters = {};
    let columns;
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters[key] = value; return query; },
      async maybeSingle() {
        reads.push({ table, columns, filters });
        if (options.error) return { error: new Error('private detail') };
        if (table === 'blog_post') {
          articleReads++;
          if (options.missing || filters.tenant_id !== row.tenant_id) return { data: null };
          const source = options.revokeDuringRead && articleReads === 2 ? { ...row, share_password: null } : row;
          return { data: Object.fromEntries(columns.split(',').map(k => [k, source[k]])) };
        }
        return { data: table === 'member' ? { first_name: 'Member', last_name: 'Author' } : { full_name: 'Guest Author' } };
      },
    };
    return query;
  } };
  const handler = createArticlePreviewHandler({
    db, resolveTenant: async () => options.noTenant ? null : { id: 'tenant-a' },
    limit: async () => { if (options.limitError) throw Error('counter'); return !!options.limited; },
  });
  async function call(password = '1234', method = 'POST') {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body: { id, password }, headers: {} }, res);
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.match(res.headers['X-Robots-Tag'], /noindex/);
    assert.equal(res.headers['X-Session-Status'], undefined);
    assert.ok(!JSON.stringify(res.body).includes('share_password'));
    return res;
  }
  return { call, reads, row };
}
test('password verification returns only draft presentation and tenant-scoped author name', async () => {
  for (const guest of [false, true]) {
    const f = fixture({ row: guest ? { guest_writer_id: 'guest' } : {} });
    const r = await f.call();
    assert.equal(r.code, 200);
    assert.equal(r.body.authorName, guest ? 'Guest Author' : 'Member Author');
    assert.equal(r.body.article.title, 'Private draft');
    assert.ok(!('author_id' in r.body.article));
    assert.ok(f.reads.every(r => r.filters.tenant_id === 'tenant-a'));
    assert.ok(!f.reads.some(r => r.columns.includes('email')));
  }
});
test('wrong, revoked, absent, foreign and unknown previews never disclose content or authors', async () => {
  for (const options of [{}, { row: { share_password: null } }, { row: { share_password: '' } }, { row: { tenant_id: 'other' } }, { missing: true }, { noTenant: true }]) {
    const f = fixture(options);
    const r = await f.call('wrong');
    assert.ok([403, 404].includes(r.code));
    assert.equal(r.body.article, undefined);
    assert.ok(f.reads.every(r => r.table === 'blog_post' && r.columns === 'share_password'));
  }
});
test('revocation is checked on every subsequent access and concurrent content read', async () => {
  const f = fixture();
  assert.equal((await f.call()).code, 200);
  f.row.share_password = null;
  assert.equal((await f.call()).code, 403);
  assert.equal((await fixture({ revokeDuringRead: true }).call()).code, 403);
});
test('service, limiter and malformed requests are bounded and safe', async () => {
  for (const options of [{ error: true }, { limitError: true }]) {
    const r = await fixture(options).call();
    assert.equal(r.code, 503);
    assert.ok(!JSON.stringify(r.body).includes('private detail'));
  }
  assert.equal((await fixture({ limited: true }).call()).code, 429);
  assert.equal((await fixture().call('', 'GET')).code, 405);
  assert.equal((await fixture().call({})).code, 400);
});
test('durable limiter scopes article/client, article aggregate and tenant/client and fails closed', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push({ name, ...args }); return { data: false }; } };
  assert.equal(await limitPreviewAttempts(db, 'tenant', id, { headers: {}, socket: { remoteAddress: 'ip' } }), false);
  assert.deepEqual(calls.map(c => c.p_limit), [10, 100, 30]);
  assert.equal(new Set(calls.map(c => c.p_token_hash_hex)).size, 2);
  assert.equal(await limitPreviewAttempts({ rpc: async () => ({ data: true }) }, 'tenant', id, {}), true);
  await assert.rejects(limitPreviewAttempts({ rpc: async () => ({ error: Error('offline') }) }, 'tenant', id, {}));
});
test('route identity, hybrid default, public transport and generic protections remain explicit', () => {
  const read = path => readFileSync(path, 'utf8');
  assert.match(read('client/src/pages/index.jsx'), /'article-preview'\) return 'ArticlePreview'/);
  assert.match(read('client/src/pages/Layout.jsx'), /hybridPages\.push\([^;]*"ArticlePreview"/);
  const page = read('client/src/pages/ArticlePreview.jsx');
  assert.doesNotMatch(page, /base44|useQuery|share_password|localStorage|sessionStorage/);
  assert.match(page, /DOMPurify\.sanitize/);
  assert.match(read('api/entities/[entity]/index.js'), /X-Session-Status/);
  assert.match(read('api/_lib/tenantContext.js'), /'BlogPost': TENANT_SCOPE.TENANT/);
});

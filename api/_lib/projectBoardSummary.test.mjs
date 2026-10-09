import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let db;
globalThis.__boardSummaryDb = () => db;
const output = await build({
  entryPoints: ['api/projects/boards/[boardId].js'], bundle: true, write: false,
  format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'isolated-board-summary', setup(b) {
    b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase={from(...a){return globalThis.__boardSummaryDb().from(...a)}};' }));
    b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession=async()=>({data:{identityId:"actor",tenantId:"tenant"}});' }));
    b.onLoad({ filter: /\/_lib\/salesLinkedProjectGuard\.js$/ }, () => ({ contents: 'export const guardSalesLinkedProject=async()=>true;' }));
  } }],
});
const mod = new Module(`${process.cwd()}/board-summary-test.cjs`);
mod.filename = `${process.cwd()}/board-summary-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(output.outputFiles[0].text, mod.filename);

async function request({ failTable, member = true, searchIndex = false, cardCount = 1 } = {}) {
  const calls = [];
  db = { from(table) {
    const call = { table, filters: [], order: [] }; calls.push(call);
    let single = false, start = 0, end = 499;
    const q = {
      select(fields) { call.select = fields; return q; },
      eq(k, v) { call.filters.push([k, v]); return q; },
      in(k, v) { call.filters.push([k, v]); return q; },
      order(k) { call.order.push(k); return q; },
      range(a, b) { start = a; end = b; call.range = [a, b]; return q; },
      single() { single = true; return q; },
      then(resolve) {
        const rows = table === 'project_board_member' ? (single ? (member ? { role: 'member' } : null) : [])
          : table === 'project_board' ? { id: 'board', tenant_id: 'tenant' }
          : table === 'project_card' ? Array.from({length:cardCount},(_,i)=>({ id: i ? `card-${i}` : 'card', project_card_comment: [{ count: 1205 }] })).slice(start,end+1)
          : table === 'project_card_attachment' ? Array.from({ length: 501 }, (_, n) => ({ id: `file-${n}`, card_id: 'card' })).slice(start, end + 1)
          : [];
        return Promise.resolve({ data: rows, error: table === failTable ? { code: 'FAILED' } : null }).then(resolve);
      },
    };
    return q;
  } };
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await mod.exports.default({ method: 'GET', headers: {}, query: { boardId: 'board', ...(searchIndex ? {searchIndex:'true'} : {}) } }, res);
  return { res, calls };
}
test('board supplies aggregate comment counts and complete attachment pages using actual timestamp column', async () => {
  const { res, calls } = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cards[0].project_card_comment[0].count, 1205);
  assert.equal(res.body.cards[0].project_card_attachment.length, 501);
  assert.equal(res.body.viewerIdentityId, 'actor');
  const cardQuery = calls.find(c => c.table === 'project_card');
  assert.match(cardQuery.select, /project_card_comment\(count\)/);
  assert.ok(cardQuery.filters.some(([k,v]) => k === 'board_id' && v === 'board'));
  const pages = calls.filter(c => c.table === 'project_card_attachment');
  assert.deepEqual(pages.map(c => c.range), [[0, 499], [500, 999]]);
  for (const page of pages) {
    assert.match(page.select, /uploaded_at/);
    assert.doesNotMatch(page.select, /created_at/);
    assert.deepEqual(page.order, ['uploaded_at', 'id']);
    assert.deepEqual(page.filters, [['card_id', ['card']]]);
  }
});
test('search index is membership-gated, paginates board cards and avoids attachment loading', async () => {
  const {res,calls}=await request({searchIndex:true,cardCount:501});
  assert.equal(res.statusCode,200);
  assert.equal(res.body.documents.length,501);
  assert.deepEqual(calls.filter(c=>c.table==='project_card').map(c=>c.range),[[0,499],[500,999]]);
  assert.ok(!calls.some(c=>c.table==='project_card_attachment'));
  for(const c of calls.filter(c=>['project_card_comment','project_card_activity'].includes(c.table))) {
    assert.ok(c.filters[0][0]==='card_id' && c.filters[0][1].length<=100);
  }
  const denied=await request({member:false,searchIndex:true});
  assert.equal(denied.res.statusCode,403);
  assert.ok(!denied.calls.some(c=>c.table==='project_card_comment'));
  const failed=await request({searchIndex:true,failTable:'project_card_activity'});
  assert.equal(failed.res.statusCode,500);
});
test('count-loading failures do not silently present empty cards or zero attachments', async () => {
  for (const failTable of ['project_card', 'project_card_attachment']) {
    const { res } = await request({ failTable });
    assert.equal(res.statusCode, 500);
    assert.ok(res.body.error);
  }
  const { res, calls } = await request({ member: false });
  assert.equal(res.statusCode, 403);
  assert.ok(!calls.some(c => c.table === 'project_card'));
});

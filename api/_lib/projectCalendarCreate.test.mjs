import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let role, inserted, writes, guardAllowed;
globalThis.__calendarCreateDb = { from(table) {
  let value;
  const filters = {};
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    single() { return q; }, eq(key, val) { filters[key] = val; return q; },
    insert(val) { value = val; return q; },
    then(resolve) {
      let data = null;
      if (table === 'project_list' && filters.id === 'selected-list') data = { board_id: 'selected-board' };
      if (table === 'project_board_member' && role) data = { role };
      if (table === 'project_card') {
        if (value) {
          inserted = value;
          writes++;
          data = { id: 'new-card', ...value };
        } else data = { position: 3 };
      }
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return q;
} };
globalThis.__calendarCreateGuard = () => guardAllowed;
const output = await build({
  entryPoints: ['api/projects/cards.js'], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'calendar-create-isolation', setup(b) {
    b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase=globalThis.__calendarCreateDb;' }));
    b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession=async()=>({data:{identityId:"actor"}});' }));
    b.onLoad({ filter: /\/_lib\/salesLinkedProjectGuard\.js$/ }, () => ({
      contents: 'export const guardSalesLinkedProject=async(req,res)=>{if(globalThis.__calendarCreateGuard())return true;res.status(403).json({error:"Denied"});return false;};',
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/calendar-create-test.cjs`);
mod.filename = `${process.cwd()}/calendar-create-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(output.outputFiles[0].text, mod.filename);
async function create(body, membership = 'member', guard = true) {
  role = membership; guardAllowed = guard; writes = 0; inserted = null;
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await mod.exports.default({ method: 'POST', headers: {}, body }, res);
  return res;
}
test('calendar creation persists selected list and local date in one write with complete cache-ready response', async () => {
  const res = await create({ list_id: 'selected-list', title: ' New card ', due_date: '2026-10-25' });
  assert.equal(res.statusCode, 201);
  assert.equal(writes, 1);
  assert.deepEqual(inserted, {
    list_id: 'selected-list', board_id: 'selected-board', title: 'New card',
    description: null, position: 4, priority: 'none', due_date: '2026-10-25',
    start_date: null, created_by: 'actor',
  });
  assert.deepEqual(res.body.card.project_card_label, []);
  assert.deepEqual(res.body.card.project_card_assignee, []);
});
test('ordinary board creation stays undated', async () => {
  assert.equal((await create({ list_id: 'selected-list', title: 'Board card' })).statusCode, 201);
  assert.equal(inserted.due_date, null);
});
test('creation rejects absent list, empty title, viewers, outsiders and linked-project access denial', async () => {
  for (const [body, membership, guard, status] of [
    [{ title: 'Card' }, 'member', true, 400],
    [{ list_id: 'selected-list', title: ' ' }, 'member', true, 400],
    [{ list_id: 'selected-list', title: 'Card' }, 'viewer', true, 403],
    [{ list_id: 'selected-list', title: 'Card' }, null, true, 403],
    [{ list_id: 'unknown-list', title: 'Card' }, 'member', true, 403],
    [{ list_id: 'selected-list', title: 'Card' }, 'member', false, 403],
  ]) {
    assert.equal((await create(body, membership, guard)).statusCode, status);
    assert.equal(writes, 0);
  }
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let state;
globalThis.__discussionReads = {
  get db() { return state.db; },
  session: () => ({ data: { identityId: 'actor' } }),
  guard: async (_req, res) => {
    if (state.allowed) return true;
    res.status(403).json({ error: 'Project permission required' }); return false;
  },
};
const output = await build({
  stdin: { contents: `export {default as detail} from './api/projects/cards/[cardId].js';
    export {default as comments} from './api/projects/cards/[cardId]/comments.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'discussion-reads', setup(b) {
    b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase = {from(...a){return globalThis.__discussionReads.db.from(...a)},rpc(...a){return globalThis.__discussionReads.db.rpc(...a)}};' }));
    b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession=(...a)=>globalThis.__discussionReads.session(...a);' }));
    b.onLoad({ filter: /\/_lib\/salesLinkedProjectGuard\.js$/ }, () => ({ contents: 'export const guardSalesLinkedProject=(...a)=>globalThis.__discussionReads.guard(...a);' }));
  } }],
});
const mod = new Module(`${process.cwd()}/discussion-reads.cjs`);
mod.filename = `${process.cwd()}/discussion-reads.cjs`; mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(output.outputFiles[0].text, mod.filename);
after(() => delete globalThis.__discussionReads);
function setup(patch = {}) {
  const snapshot = { discussionVersion: 9, comments: Array.from({ length: 1205 }, (_, i) => ({
    id: `comment-${i}`, content: `Reply ${i}`, images: [], reactions: [{ emoji: '👍', count: 2, selected: true, reactors: [{ id: 'actor', name: 'Board Member' }] }],
  })) };
  state = { allowed: true, calls: [], snapshot, ...patch };
  state.db = {
    from(table) {
      state.calls.push({ table });
      const q = {
        select() { return q; }, eq() { return q; }, single() { return q; }, order() { return q; }, limit() { return q; },
        then(resolve) { return Promise.resolve({ data: table === 'project_card' ? { id: 'card', board_id: 'board' }
          : table === 'project_board_member' ? { role: 'member' } : [], error: null }).then(resolve); },
      };
      return q;
    },
    async rpc(name, args) { state.calls.push({ name, args }); return { data: snapshot, error: state.error }; },
  };
}
async function request(handler) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', query: { cardId: 'card' }, headers: {} }, res); return res;
}
test('both reads return the identical complete ordered discussion without per-comment queries', async () => {
  for (const handler of Object.values(mod.exports)) {
    setup();
    const res = await request(handler);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.comments, state.snapshot.comments);
    assert.equal(res.body.discussionVersion, 9);
    assert.deepEqual(state.calls.filter(c => c.name), [{
      name: 'read_project_discussion', args: { p_card_id: 'card', p_actor_id: 'actor' },
    }]);
    assert.ok(!state.calls.some(c => ['project_card_comment', 'project_comment_reaction', 'tenant_identity'].includes(c.table)));
  }
});
test('both reads retain Sales guards and fail explicitly instead of returning empty discussions', async () => {
  for (const handler of Object.values(mod.exports)) {
    setup({ allowed: false });
    assert.equal((await request(handler)).statusCode, 403);
    assert.ok(!state.calls.some(c => c.name));
    setup({ error: { code: 'XX000', message: 'Read failed' } });
    assert.equal((await request(handler)).statusCode, 500);
  }
});

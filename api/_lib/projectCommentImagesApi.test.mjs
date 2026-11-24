import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let state;
globalThis.__projectImagesApi = {
  get db() { return state.db; },
  session: () => state.session ? { data: { identityId: 'actor' } } : null,
  guard: async (req, res) => {
    if (state.linkedAllowed) return true;
    res.status(403).json({ error: 'Project permission required' }); return false;
  },
};
const result = await build({
  entryPoints: ['api/projects/cards/[cardId]/comments.js'], bundle: true, write: false,
  format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'comment-images-fixture', setup(b) {
    b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase = { from(...a){ return globalThis.__projectImagesApi.db.from(...a); }, rpc(...a){ return globalThis.__projectImagesApi.db.rpc(...a); } };' }));
    b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession = (...a)=>globalThis.__projectImagesApi.session(...a);' }));
    b.onLoad({ filter: /\/_lib\/salesLinkedProjectGuard\.js$/ }, () => ({ contents: 'export const guardSalesLinkedProject = (...a)=>globalThis.__projectImagesApi.guard(...a);' }));
  } }],
});
const mod = new Module(`${process.cwd()}/comment-images-fixture.cjs`);
mod.filename = `${process.cwd()}/comment-images-fixture.cjs`; mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, mod.filename);
after(() => delete globalThis.__projectImagesApi);
const id = '50000000-0000-0000-0000-000000000001';
function setup(patch = {}) {
  state = { session: true, role: 'member', linkedAllowed: true, calls: [], ...patch };
  state.db = {
    from(table) {
      const q = {
        select(fields) { state.calls.push({ table, fields }); return q; },
        eq() { return q; }, order() { return q; }, single() { return q; }, in() { return q; },
        then(resolve) {
          const data = table === 'project_card' ? { board_id: 'board' } :
            table === 'project_board_member' ? state.role ? { role: state.role } : null :
            table === 'project_card_comment' ? [{ id, content: '', images: [{ attachment: { id } }] }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      }; return q;
    },
    async rpc(name, args) {
      state.calls.push({ name, args });
      const comment = { id, content: args.p_content || '', images: [{ attachment: { id } }] };
      return { data: { comment, comments: [comment], discussionVersion: 1 }, error: state.rpcError || null };
    },
  };
}
async function request(body, method = 'POST') {
  const res = { statusCode: 200, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await mod.exports.default({ method, body, headers: {}, query: { cardId: 'card' } }, res);
  return res;
}
test('image-only submission delegates atomic ownership validation and returns image links; reads include links', async () => {
  setup();
  const res = await request({ content: '', attachmentIds: [id], requestId: id });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.comment.images[0].attachment.id, id);
  assert.deepEqual(state.calls.find(call => call.name)?.args, {
    p_card_id: 'card', p_actor_id: 'actor', p_operation: 'create', p_rich_content: null,
    p_content: '', p_recipient_ids: [], p_attachment_ids: [id], p_request_id: id, p_reply_to_id: null,
  });
  assert.equal(state.calls.find(call => call.name)?.name, 'write_project_discussion');
  await request(null, 'GET');
  assert.ok(state.calls.some(call => call.name === 'read_project_discussion'));
});
test('legacy text comments remain supported and invalid image payloads never call the RPC', async () => {
  setup();
  assert.equal((await request({ content: 'Hello' })).statusCode, 201);
  assert.equal(state.calls.find(call => call.name).name, 'write_project_discussion');
  for (const payload of [
    { content: '' }, { content: '', attachmentIds: [id] },
    { content: '', attachmentIds: ['https://external.invalid/image.png'], requestId: id },
    { content: '', attachmentIds: Array(11).fill(id), requestId: id },
  ]) {
    setup(); assert.equal((await request(payload)).statusCode, 400);
    assert.ok(!state.calls.some(call => call.name));
  }
});
test('author operations and explicit reactions derive actor from session, never the request', async () => {
  for (const [method, body, operation] of [
    ['PATCH', { commentId: id, content: 'Edited', actorId: 'forged' }, 'edit'],
    ['DELETE', { commentId: id, actorId: 'forged' }, 'delete'],
    ['PUT', { commentId: id, emoji: '❤️', actorId: 'forged' }, 'react'],
    ['PUT', { commentId: id, emoji: null }, 'react'],
  ]) {
    setup();
    const res = await request(body, method);
    assert.equal(res.statusCode, 200);
    const call = state.calls.find(call => call.name === 'write_project_discussion');
    assert.equal(call.args.p_actor_id, 'actor');
    assert.equal(call.args.p_operation, operation);
    assert.equal(call.args.p_comment_id, id);
  }
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    for (const role of ['viewer', null]) {
      setup({ role });
      assert.equal((await request({ commentId: id, content: 'No', emoji: '👍' }, method)).statusCode, 403);
      assert.ok(!state.calls.some(call => call.name));
    }
  }
});
test('rich comments derive projection and mentions, bind reply identity, and reject unsafe mutations', async () => {
  setup();
  const richContent = { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Hello ', marks: [{ type: 'bold' }] },
    { type: 'mention', attrs: { id, label: 'Current Member' } },
  ] }] } };
  assert.equal((await request({ content: 'forged', richContent, requestId: id, replyToCommentId: id })).statusCode, 201);
  assert.deepEqual(state.calls.find(call => call.name).args, {
    p_card_id: 'card', p_actor_id: 'actor', p_operation: 'create', p_content: 'Hello @Current Member',
    p_rich_content: richContent, p_recipient_ids: [id], p_attachment_ids: [], p_request_id: id, p_reply_to_id: id,
  });
  for (const [method, body] of [
    ['POST', { content: 'Reply', replyToCommentId: id }],
    ['POST', { richContent, requestId: 'invalid' }],
    ['PATCH', { commentId: 'invalid', content: 'Changed' }],
    ['PUT', { commentId: id, emoji: '🦆' }],
    ['PUT', { commentId: id }],
    ['DELETE', { commentId: 'invalid' }],
    ['POST', { richContent: { version: 1, doc: { type: 'doc', content: [] } }, requestId: id }],
  ]) {
    setup();
    assert.equal((await request(body, method)).statusCode, 400);
    assert.ok(!state.calls.some(call => call.name));
  }
  setup({ rpcError: { code: 'PT409', message: 'This comment was already deleted' } });
  assert.equal((await request({ content: 'Retry', requestId: id })).statusCode, 409);
});
test('unauthenticated, viewer, nonmember and linked-project denial cannot create comments', async () => {
  for (const patch of [{ session: false }, { role: 'viewer' }, { role: null }, { linkedAllowed: false }]) {
    setup(patch);
    assert.ok([401, 403].includes((await request({ content: '', attachmentIds: [id], requestId: id })).statusCode));
    assert.ok(!state.calls.some(call => call.name));
  }
  for (const [code, status] of [['22023', 400], ['42501', 403], ['P0002', 404]]) {
    setup({ rpcError: { code, message: 'Rejected reference' } });
    assert.equal((await request({ content: '', attachmentIds: [id], requestId: id })).statusCode, status);
  }
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let fixture;
globalThis.__coverUploadTest = {
  get db() { return fixture.db; },
  session: async () => fixture.session ? { data: { identityId: 'actor' } } : null,
  quota: async () => fixture.quota,
  bytes: async () => {},
};
const handlers = {};
for (const [name, file] of Object.entries({
  prepare: 'api/projects/cards/[cardId]/attachments.js',
  confirm: 'api/projects/cards/[cardId]/attachments/confirm.js',
})) {
  const output = await build({
    entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node',
    packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'isolated-cover-upload', setup(b) {
      b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase = {from(...a){return globalThis.__coverUploadTest.db.from(...a)}, storage:{from(...a){return globalThis.__coverUploadTest.db.storage.from(...a)}}};' }));
      b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession = (...a)=>globalThis.__coverUploadTest.session(...a);' }));
      b.onLoad({ filter: /\/_lib\/planQuota\.js$/ }, () => ({ contents: 'export const checkStorageQuota = (...a)=>globalThis.__coverUploadTest.quota(...a);' }));
      b.onLoad({ filter: /\/_lib\/tenantStorageUsage\.js$/ }, () => ({ contents: 'export const addTenantStorageBytes = (...a)=>globalThis.__coverUploadTest.bytes(...a);' }));
    } }],
  });
  const mod = new Module(`${process.cwd()}/isolated-cover-upload.cjs`);
  mod.filename = `${process.cwd()}/isolated-cover-upload.cjs`;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(output.outputFiles[0].text, mod.filename);
  handlers[name] = mod.exports.default;
}
after(() => delete globalThis.__coverUploadTest);

function setup() {
  const calls = [];
  const f = {
    calls, role: 'member', session: true, quota: { ok: true }, saveError: false, boardId: 'board',
    db: {
      storage: { from() { return {
        async createSignedUploadUrl(path) { calls.push({ signedPath: path }); return { data: { signedUrl: 'https://storage.invalid/upload' } }; },
        getPublicUrl(path) { return { data: { publicUrl: `https://storage.invalid/${path}` } }; },
      }; } },
      from(table) {
        const call = { table, filters: [] }; calls.push(call);
        const q = {
          select() { return q; }, single() { return q; },
          eq(k, v) { call.filters.push([k, v]); return q; },
          insert(data) { call.insert = data; return q; },
          update(data) { call.update = data; return q; },
          then(resolve) {
            let data = table === 'project_card' ? { id: 'card', board_id: f.boardId, ...call.update }
              : table === 'project_board_member' ? (f.role ? { role: f.role } : null)
              : table === 'project_board' ? { tenant_id: 'tenant' }
              : { id: 'attachment', ...call.insert };
            return Promise.resolve({ data, error: call.update && f.saveError ? { code: 'SAVE_FAILED' } : null }).then(resolve);
          },
        };
        return q;
      },
    },
  };
  fixture = f;
  return f;
}
async function request(name, body, cardId = 'card') {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handlers[name]({ method: 'POST', headers: {}, query: { cardId }, body }, res);
  return res;
}
const file = { fileName: 'cover.png', fileSize: 1024, mimeType: 'image/png' };
test('cover-only upload sets cover and activity without creating an attachment', async () => {
  const f = setup();
  const prepared = await request('prepare', { ...file, purpose: 'cover' });
  assert.equal(prepared.statusCode, 200);
  const token = JSON.parse(Buffer.from(prepared.body.uploadToken.split('.')[0], 'base64'));
  assert.equal(token.purpose, 'cover');
  assert.ok(token.storagePath.startsWith('project-attachments/tenant/board/card/covers/'));
  const result = await request('confirm', { uploadToken: prepared.body.uploadToken });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.coverImage, token.publicUrl);
  assert.ok(!f.calls.some(c => c.table === 'project_card_attachment'));
  assert.equal(f.calls.find(c => c.table === 'project_card_activity').insert.action_type, 'cover_set');
});
test('ordinary uploads still create attachments; unsigned purpose cannot change the route', async () => {
  const f = setup();
  const prepared = await request('prepare', file);
  const result = await request('confirm', { uploadToken: prepared.body.uploadToken, purpose: 'cover' });
  assert.equal(result.statusCode, 200);
  assert.ok(result.body.attachment);
  assert.ok(f.calls.some(c => c.table === 'project_card_attachment' && c.insert));
  assert.ok(!f.calls.some(c => c.table === 'project_card' && c.update));
});
test('cover preparation rejects non-images, invalid size, missing access and exhausted quota', async () => {
  for (const [body, change, status] of [
    [{ ...file, purpose: 'cover', mimeType: 'application/pdf' }, {}, 400],
    [{ ...file, purpose: 'cover', mimeType: 'image/svg+xml' }, {}, 400],
    [{ ...file, purpose: 'cover', fileSize: -1 }, {}, 400],
    [{ ...file, purpose: 'cover', fileSize: 101 * 1024 * 1024 }, {}, 400],
    [{ ...file, purpose: 'cover' }, { role: 'viewer' }, 403],
    [{ ...file, purpose: 'cover' }, { role: null }, 403],
    [{ ...file, purpose: 'cover' }, { session: false }, 401],
    [{ ...file, purpose: 'cover' }, { quota: { ok: false, status: 403, body: { error: 'Quota reached' } } }, 403],
  ]) {
    const f = setup(); Object.assign(f, change);
    assert.equal((await request('prepare', body)).statusCode, status);
    assert.ok(!f.calls.some(c => c.signedPath));
  }
});
test('confirmation rechecks permissions, card scope, signed purpose and save errors', async () => {
  for (const change of [{ role: 'viewer' }, { role: null }, { boardId: 'moved-board' }, { saveError: true }]) {
    const f = setup();
    const prepared = await request('prepare', { ...file, purpose: 'cover' });
    Object.assign(f, change);
    const result = await request('confirm', { uploadToken: prepared.body.uploadToken });
    assert.ok(result.statusCode >= 400);
    assert.ok(!f.calls.some(c => c.table === 'project_card_attachment' && c.insert));
    assert.ok(!f.calls.some(c => c.table === 'project_card_activity' && c.insert));
  }
  setup();
  const prepared = await request('prepare', { ...file, purpose: 'cover' });
  assert.equal((await request('confirm', { uploadToken: prepared.body.uploadToken }, 'other-card')).statusCode, 400);
  const [payload, signature] = prepared.body.uploadToken.split('.');
  const modified = JSON.parse(Buffer.from(payload, 'base64')); modified.publicUrl = 'https://forged.invalid/';
  assert.equal((await request('confirm', { uploadToken: `${Buffer.from(JSON.stringify(modified)).toString('base64')}.${signature}` })).statusCode, 400);
});

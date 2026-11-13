import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMemberDocument, memberDocumentPathAllowed, uploadMemberNoteDocument, memberNoteDocumentUrl, removeMemberNoteDocuments } from './memberNoteDocuments.js';

const document = { name: 'example.pdf', base64: Buffer.from('%PDF-1.7 example').toString('base64') };
function fixture({ ready = true, quota = true, uploadError = false, insertError = false, note = null } = {}) {
  const calls = [];
  const db = {
    rpc: async () => ({ data: ready }),
    storage: { from(bucket) {
      assert.equal(bucket, 'member-note-documents');
      return {
        upload: async (path, bytes, options) => { calls.push(['upload', path, options]); return { error: uploadError }; },
        remove: async paths => { calls.push(['remove', paths]); return {}; },
        createSignedUrl: async (path, seconds, options) => {
          calls.push(['sign', path, seconds, options]); return { data: { signedUrl: 'https://example.org/signed' } };
        },
      };
    } },
    from(table) {
      assert.equal(table, 'member_note');
      return {
        insert(value) { calls.push(['insert', value]); return this; },
        select() { return this; },
        eq(key, value) { calls.push(['eq', key, value]); return this; },
        single: async () => ({ data: { id: 'note' }, error: insertError }),
        maybeSingle: async () => ({ data: note }),
      };
    },
  };
  return { db, calls, tenantId: 'tenant', memberId: 'member', authorId: 'admin', document,
    quotaCheck: async () => ({ ok: quota }), accountBytes: async (...args) => { calls.push(['bytes', ...args]); } };
}
test('document type, size, name and encoding validation', () => {
  assert.equal(decodeMemberDocument({ ...document, name: '../folder/example.pdf' }).name, 'example.pdf');
  for (const name of ['file.html', 'script.svg', 'app.exe', 'a.pdf.html', '']) {
    assert.throws(() => decodeMemberDocument({ ...document, name }), /Choose a/);
  }
  for (const base64 of ['', 'not base64!', 'A'.repeat(3000000)]) {
    assert.throws(() => decodeMemberDocument({ ...document, base64 }));
  }
});
test('upload is private and recorded as a member note with trusted metadata', async () => {
  const f = fixture();
  await uploadMemberNoteDocument(f);
  const upload = f.calls.find(c => c[0] === 'upload');
  assert.match(upload[1], /^tenant\/member-notes\/member\/[0-9a-f-]+\.pdf$/);
  assert.equal(upload[2].upsert, false);
  const note = f.calls.find(c => c[0] === 'insert')[1];
  assert.equal(note.target_member_id, 'member');
  assert.equal(note.author_member_id, 'admin');
  assert.equal(note.attachments[0].storage_path, upload[1]);
  assert.equal(note.attachments[0].file_url, undefined);
  assert.equal(f.calls.filter(c => c[0] === 'bytes').length, 1);
});
test('missing privacy setup and storage quota prevent upload', async () => {
  for (const options of [{ ready: false }, { quota: false }]) {
    const f = fixture(options);
    await assert.rejects(uploadMemberNoteDocument(f));
    assert.equal(f.calls.length, 0);
  }
});
test('failed upload never creates a note, failed note save cleans up the private object', async () => {
  const upload = fixture({ uploadError: true });
  await assert.rejects(uploadMemberNoteDocument(upload), /could not be uploaded/);
  assert.equal(upload.calls.length, 1);
  const save = fixture({ insertError: true });
  await assert.rejects(uploadMemberNoteDocument(save), /could not be saved/);
  assert.equal(save.calls.filter(c => c[0] === 'remove').length, 1);
  assert.equal(save.calls.filter(c => c[0] === 'bytes').length, 0);
});
test('download looks up the saved note on the target member and uses a short-lived attachment link', async () => {
  const f = fixture({ note: { attachments: [{ storage_path: 'tenant/member-notes/member/file.pdf', file_name: 'example.pdf' }] } });
  await memberNoteDocumentUrl({ ...f, noteId: 'note', index: 0 });
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'target_member_id' && c[2] === 'member'));
  assert.deepEqual(f.calls.find(c => c[0] === 'sign').slice(2), [60, { download: 'example.pdf' }]);
});
test('foreign member, foreign tenant, missing note and traversal never produce a download', async () => {
  for (const path of ['other/member-notes/member/file.pdf', 'tenant/member-notes/other/file.pdf',
    'tenant/member-notes/member/../file.pdf', 'tenant/member-notes/member/../../file.pdf']) {
    assert.equal(memberDocumentPathAllowed(path, 'tenant', 'member'), false);
    const f = fixture({ note: { attachments: [{ storage_path: path }] } });
    await assert.rejects(memberNoteDocumentUrl({ ...f, noteId: 'note', index: 0 }), /not found/);
    assert.equal(f.calls.filter(c => c[0] === 'sign').length, 0);
  }
  await assert.rejects(memberNoteDocumentUrl({ ...fixture(), noteId: 'missing', index: 0 }), /not found/);
});

test('note deletion removes only its own scoped private documents', async () => {
  const f = fixture();
  await removeMemberNoteDocuments({ ...f, attachments: [
    { storage_path: 'tenant/member-notes/member/file.pdf', file_size: 100 },
    { storage_path: 'other/member-notes/member/file.pdf', file_size: 200 },
    { file_url: 'https://example.org/legacy.pdf' },
  ] });
  assert.deepEqual(f.calls.find(c => c[0] === 'remove')[1], ['tenant/member-notes/member/file.pdf']);
  assert.deepEqual(f.calls.find(c => c[0] === 'bytes'), ['bytes', 'tenant', -100]);
});

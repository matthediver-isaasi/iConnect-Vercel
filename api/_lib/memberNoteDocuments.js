import { randomUUID } from 'node:crypto';

export const MEMBER_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const BUCKET = 'member-note-documents';
const TYPES = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
};
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function decodeMemberDocument(input) {
  const name = typeof input?.name === 'string' ? input.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (!name || name.length > 180 || !TYPES[extension]) invalid('Choose a PDF, Word, Excel, text, CSV, PNG or JPEG document.');
  const encoded = input?.base64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MEMBER_DOCUMENT_MAX_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    invalid('The document is invalid or exceeds the 2 MB upload limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MEMBER_DOCUMENT_MAX_BYTES) invalid('Choose a non-empty document of up to 2 MB.');
  return { name, bytes, mime: TYPES[extension], extension };
}

export function memberDocumentPathAllowed(path, tenantId, memberId) {
  return typeof path === 'string'
    && path.startsWith(`${tenantId}/member-notes/${memberId}/`)
    && !path.includes('..') && !path.includes('\\')
    && path.split('/').length === 4;
}

// Called only after the route has authorised the admin and tenant-scoped member.
export async function uploadMemberNoteDocument({ db, tenantId, memberId, authorId, document, quotaCheck, accountBytes }) {
  const file = decodeMemberDocument(document);
  const { data: ready, error: readinessError } = await db.rpc('member_note_documents_ready');
  if (readinessError || ready !== true) {
    throw Object.assign(new Error('Document uploads need the private-storage setup. Please contact your administrator.'), { status: 503 });
  }
  const quota = await quotaCheck(tenantId, { fileSizeBytes: file.bytes.length });
  if (!quota.ok) throw Object.assign(new Error('Your organisation’s storage limit has been reached.'), { status: quota.status || 400 });
  const path = `${tenantId}/member-notes/${memberId}/${randomUUID()}.${file.extension}`;
  const bucket = db.storage.from(BUCKET);
  const { error: uploadError } = await bucket.upload(path, file.bytes, { contentType: file.mime, upsert: false });
  if (uploadError) throw new Error('The document could not be uploaded. Please try again.');
  const attachment = { storage_path: path, file_name: file.name, file_size: file.bytes.length, mime_type: file.mime };
  const { data, error } = await db.from('member_note').insert({
    target_member_id: memberId, author_member_id: authorId,
    content: `Document: ${file.name}`, attachments: [attachment],
  }).select().single();
  if (error) {
    const { error: cleanupError } = await bucket.remove([path]);
    if (cleanupError) {
      await accountBytes(tenantId, file.bytes.length);
      console.error('[Member document] Unlinked private upload requires cleanup', path);
    }
    throw new Error('The document could not be saved to the member’s notes. Please try again.');
  }
  await accountBytes(tenantId, file.bytes.length);
  return data;
}

export async function memberNoteDocumentUrl({ db, tenantId, memberId, noteId, index }) {
  if (!Number.isInteger(index) || index < 0) invalid('Invalid document selection.');
  const { data: note, error } = await db.from('member_note').select('attachments')
    .eq('id', noteId).eq('target_member_id', memberId).maybeSingle();
  if (error) throw new Error('The document could not be loaded.');
  const attachment = note?.attachments?.[index];
  if (!attachment || !memberDocumentPathAllowed(attachment.storage_path, tenantId, memberId)) {
    throw Object.assign(new Error('Document not found.'), { status: 404 });
  }
  const { data, error: storageError } = await db.storage.from(BUCKET)
    .createSignedUrl(attachment.storage_path, 60, { download: attachment.file_name });
  if (storageError || !data?.signedUrl) throw new Error('The download could not be prepared. Please try again.');
  return data.signedUrl;
}

// Delete storage only after the note has been removed. A failed storage delete
// leaves an inaccessible private object rather than a broken surviving note.
export async function removeMemberNoteDocuments({ db, tenantId, memberId, attachments, accountBytes }) {
  const files = (Array.isArray(attachments) ? attachments : [])
    .filter(file => memberDocumentPathAllowed(file.storage_path, tenantId, memberId));
  if (!files.length) return true;
  const { error } = await db.storage.from(BUCKET).remove(files.map(file => file.storage_path));
  if (error) {
    console.error('[Member document] Deleted note has private objects awaiting cleanup');
    return false;
  }
  await accountBytes(tenantId, -files.reduce((sum, file) => sum + (Number.isSafeInteger(file.file_size) ? file.file_size : 0), 0));
  return true;
}

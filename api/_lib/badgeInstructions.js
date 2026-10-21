import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

export const BADGE_INSTRUCTIONS_KEY = 'tenant_badge_instructions';
export const BADGE_INSTRUCTIONS_BUCKET = 'badge-instructions';
export const MAX_PDF_BYTES = 2 * 1024 * 1024;
export const HELP_PATH = '/help/sharing-your-membership-badge';

export function failure(status, message) {
  return Object.assign(new Error(message), { status, safe: true });
}

export async function validatePdf({ filename, mimeType, contentBase64 } = {}) {
  if (typeof filename !== 'string' || filename.length > 200 || !/\.pdf$/i.test(filename)
    || /[\\/\x00-\x1f\x7f]/.test(filename) || mimeType !== 'application/pdf') {
    throw failure(400, 'Choose a PDF file with a .pdf filename and application/pdf type.');
  }
  if (typeof contentBase64 !== 'string' || !contentBase64.length
    || contentBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw failure(400, 'Upload a valid PDF no larger than 2 MB.');
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length > MAX_PDF_BYTES) throw failure(413, 'The PDF must be no larger than 2 MB.');
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 16).toString('latin1'))
    || !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))) {
    throw failure(400, 'This file is not a complete PDF. Export it as PDF and try again.');
  }
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true });
    if (pdf.isEncrypted || pdf.getPageCount() < 1) throw new Error('Invalid PDF');
    // Instructions should not execute PDF JavaScript, open external programs,
    // carry attachments, or contain form actions. Reject rather than rewrite.
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      const decoded = object.toString().replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (/\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFiles?|RichMedia|XFA)\b/.test(decoded)) {
        throw new Error('Active PDF');
      }
    }
  } catch {
    throw failure(400, 'Use a readable, unencrypted PDF with at least one page and no scripts or attachments.');
  }
  return bytes;
}

export function parseSetting(row, tenantId) {
  let value;
  try { value = JSON.parse(row?.setting_value || 'null'); } catch { value = null; }
  const revision = typeof value?.revision === 'string' ? value.revision : null;
  const doc = value?.document;
  const valid = doc && /^[0-9a-f-]{36}$/i.test(doc.id || '')
    && doc.path === `${tenantId}/${doc.id}.pdf`
    && typeof doc.filename === 'string' && /\.pdf$/i.test(doc.filename)
    && !/[\\/\x00-\x1f\x7f]/.test(doc.filename)
    && Number.isInteger(doc.size) && doc.size > 0 && doc.size <= MAX_PDF_BYTES;
  return { mode: value?.mode === 'pdf' && valid ? 'pdf' : 'standard',
    revision, document: valid ? doc : null };
}

export function publicConfig(tenantId, config, canManage) {
  return { tenantId, mode: config.mode, revision: config.revision,
    document: config.document ? { filename: config.document.filename, size: config.document.size } : null,
    canManage };
}

export function createBadgeInstructionsService(db) {
  const bucket = () => db.storage.from(BADGE_INSTRUCTIONS_BUCKET);
  async function mutate(tenantId, action, extra = {}) {
    const { data, error } = await db.rpc('badge_instructions_mutate', {
      p_tenant_id: tenantId, p_action: action, ...extra,
    });
    if (error) {
      if (error.code === '40001') throw failure(409, 'Instructions changed or deletion is pending. Reload settings; retry a pending deletion before other changes.');
      if (error.code === 'P0002') throw failure(402, 'Tenant storage is full. Free some space or upgrade your plan.');
      if (error.code === '22023') throw failure(400, 'Upload a valid PDF before selecting PDF mode.');
      throw failure(503, 'Could not confirm the save. Reload settings to check the current configuration before retrying.');
    }
    return parseSetting({ setting_value: JSON.stringify(data) }, tenantId);
  }
  async function read(tenantId) {
    const { data, error } = await db.from('system_settings').select('setting_value')
      .eq('tenant_id', tenantId).eq('setting_key', BADGE_INSTRUCTIONS_KEY).maybeSingle();
    if (error) throw failure(503, 'Instructions are temporarily unavailable. Please retry.');
    return parseSetting(data, tenantId);
  }
  async function cleanup(tenantId) {
    try {
      await mutate(tenantId, 'expire');
      const { data, error } = await db.from('badge_instruction_object').select('id,path')
        .eq('tenant_id', tenantId).eq('state', 'garbage').limit(51);
      if (error) throw error;
      for (const object of (data || []).slice(0, 50)) {
        if (object.path !== `${tenantId}/${object.id}.pdf`) throw new Error('Invalid cleanup ownership');
        const removed = await bucket().remove([object.path]);
        if (removed.error) throw removed.error;
        await mutate(tenantId, 'cleanup_ack', { p_object_id: object.id });
      }
      if (data?.length > 50) throw new Error('More cleanup remains');
      return undefined;
    } catch {
      return 'Unused file cleanup is pending. Retry from settings; storage usage remains reserved until cleanup succeeds.';
    }
  }
  async function document(tenantId, config) {
    if (!config.document) throw failure(404, 'No PDF is available.');
    let data, error;
    try { ({ data, error } = await bucket().download(config.document.path)); }
    catch { error = true; }
    let bytes;
    if (error || !data) {
      // During an interrupted deletion, the durable private recovery copy
      // keeps the previous configuration working even if storage was removed.
      const { data: owned, error: ownedError } = await db.from('badge_instruction_object')
        .select('deletion_backup').eq('tenant_id', tenantId).eq('id', config.document.id)
        .eq('state', 'deleting').maybeSingle();
      if (ownedError || !owned?.deletion_backup) throw failure(503, 'The PDF is temporarily unavailable.');
      bytes = Buffer.from(owned.deletion_backup, 'base64');
    } else bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length !== config.document.size) throw failure(503, 'The PDF could not be verified.');
    try {
      await validatePdf({ filename: config.document.filename, mimeType: 'application/pdf', contentBase64: bytes.toString('base64') });
    } catch { throw failure(503, 'The PDF could not be verified.'); }
    return bytes;
  }
  async function deleteDocument(tenantId, revision) {
    const current = await read(tenantId);
    if (current.revision !== revision) throw failure(409, 'Instructions changed. Reload settings before deleting.');
    if (!current.document) return current;
    const bytes = await document(tenantId, current);
    await mutate(tenantId, 'begin_delete', { p_revision: revision, p_backup: bytes.toString('base64') });
    let removal;
    try { removal = await bucket().remove([current.document.path]); }
    catch { removal = { error: true }; }
    if (removal.error) {
      // Removal errors may be ambiguous. Do NOT write bytes back to the
      // original path: a concurrent deletion retry might already have
      // finalized, making such a restore an orphan. Retain the durable claim
      // and recovery copy instead; both config and member delivery still work.
      throw failure(503, 'Deletion failed. Your configuration is unchanged and the previous PDF remains available from a private recovery copy. Retry deletion to recover before making other changes.');
    }
    try {
      return await mutate(tenantId, 'finish_delete', { p_revision: revision });
    } catch {
      throw failure(503, 'Deletion could not be confirmed. Reload settings: if the PDF is still listed, retry deletion. Until finalization, the previous instructions remain available from a private recovery copy.');
    }
  }
  async function upload(tenantId, revision, body) {
    const bytes = await validatePdf(body);
    const id = randomUUID();
    await mutate(tenantId, 'prepare', { p_revision: revision, p_object_id: id, p_filename: body.filename, p_size: bytes.length });
    try {
      const { error } = await bucket().upload(`${tenantId}/${id}.pdf`, bytes, {
        contentType: 'application/pdf', upsert: false, cacheControl: '0',
      });
      if (error) throw failure(503, 'Upload failed. Your previous PDF is unchanged; try again.');
      return await mutate(tenantId, 'upload', { p_revision: revision, p_object_id: id });
    } catch (error) {
      let warning;
      try { await mutate(tenantId, 'abandon', { p_object_id: id }); warning = await cleanup(tenantId); }
      catch { warning = 'Unused upload cleanup is pending. Retry from settings.'; }
      if (warning) error.warning = warning;
      throw error;
    }
  }
  return { read, mutate, document, upload, cleanup, deleteDocument };
}

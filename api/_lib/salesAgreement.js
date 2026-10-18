import crypto from 'node:crypto';
import sharp from 'sharp';
import { SalesHttpError } from './salesAccess.js';
import { sendEmail } from './emailService.js';

export const hasSalesAgreement = (version) => Boolean(version?.terms_snapshot?.legalHtml?.trim());
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const checked = result => { if (result.error) throw result.error; return result.data; };
export async function validateAgreementSignature(value) {
  if (!value || !['typed', 'drawn', 'uploaded'].includes(value.mode)
    || typeof value.data !== 'string' || value.data.length > 700000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw new SalesHttpError(400, 'A PNG signature (maximum 500 KB) is required');
  }
  const png = Buffer.from(value.data.split(',')[1], 'base64');
  if (png.length > 500000 || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || png.toString('ascii', 12, 16) !== 'IHDR'
    || !png.readUInt32BE(16) || !png.readUInt32BE(20)
    || png.readUInt32BE(16) > 4096 || png.readUInt32BE(20) > 4096) {
    throw new SalesHttpError(400, 'Invalid PNG signature image');
  }
  if (value.mode === 'typed' && (typeof value.typedName !== 'string' || !value.typedName.trim() || value.typedName.length > 200)) {
    throw new SalesHttpError(400, 'Typed signature name is required');
  }
  try { await sharp(png, { limitInputPixels: 16777216 }).resize(1, 1).png().toBuffer(); }
  catch { throw new SalesHttpError(400, 'Signature PNG could not be decoded'); }
  return { mode: value.mode, data: value.data, ...(value.mode === 'typed' ? { typedName: value.typedName.trim() } : {}) };
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new SalesHttpError(400, `${label} is required (maximum 200 characters)`);
  return value.trim();
}
export async function getSalesAgreement(db, versionId) {
  const envelope = checked(await db.from('sales_agreement_envelope').select('*,sales_agreement_completion_notice(party,status)')
    .eq('quote_version_id', versionId).maybeSingle());
  if (envelope?.sales_agreement_completion_notice) {
    envelope.completionNotifications = Object.fromEntries(envelope.sales_agreement_completion_notice.map(row => [row.party, row.status]));
  }
  return envelope;
}
export function agreementDto(envelope) {
  if (!envelope) return null;
  return { required: true, status: envelope.customer ? 'accepted' : 'awaiting_customer',
    sender: envelope.sender, contact: envelope.contact, documentHash: envelope.document_hash,
    ...(envelope.customer ? { customer: envelope.customer } : {}),
    ...(envelope.completionNotifications ? { completionNotifications: envelope.completionNotifications } : {}),
    finalizationStatus: envelope.finalization_status, downloadAvailable: envelope.finalization_status === 'complete' };
}
export async function prepareSalesAgreement(db, { quote, version, tenant, actor, sender, body, requestMetadata = {}, persist = false }) {
  if (!hasSalesAgreement(version)) return null;
  const existing = await getSalesAgreement(db, version.id);
  if (existing) {
    // Resending a genuinely signed immutable envelope is not a new signature.
    // Any authorized quote manager may deliver it, but cannot change signers.
    if (existing.sender_actor_id !== sender.id || existing.sender_actor_type !== sender.kind
      || existing.contact.email !== String(body.recipient || '').trim().toLowerCase()
      || [['contactName', existing.contact.name], ['contactRole', existing.contact.role],
        ['senderName', existing.sender.name], ['senderRole', existing.sender.role]]
        .some(([key, value]) => body[key] !== undefined && body[key]?.trim() !== value)
      || body.contactEmail !== undefined && body.contactEmail?.trim().toLowerCase() !== existing.contact.email) {
      throw new SalesHttpError(409, 'The agreement is already signed and frozen. Amend the quote to change its signatories.');
    }
    return existing;
  }
  if (sender.id !== actor.actorId || sender.kind !== actor.actorType) {
    const error = new SalesHttpError(403, 'The selected colleague must sign personally. Internal countersign is required; select yourself to continue.');
    error.code = 'COUNTERSIGN_REQUIRED'; throw error;
  }
  if (body.senderConsent !== true) throw new SalesHttpError(400, 'Explicit sender signing consent is required');
  const signature = await validateAgreementSignature(body.senderSignature);
  const contact = { name: text(body.contactName, 'Contact name'), role: text(body.contactRole, 'Contact role'),
    email: text(body.contactEmail, 'Contact email').toLowerCase() };
  if (contact.email !== String(body.recipient || '').trim().toLowerCase()) throw new SalesHttpError(400, 'Contact email must match the delivery recipient');
  const signedAt = new Date().toISOString();
  const signer = { name: text(body.senderName, 'Sender name'), role: text(body.senderRole, 'Sender role'),
    email: sender.email, organization: tenant?.name || '', signature, signedAt };
  const snapshot = { quote: { id: quote.id, tenant_id: quote.tenant_id, quote_number: quote.quote_number }, version, tenant };
  const envelope = { tenant_id: quote.tenant_id, quote_id: quote.id, quote_version_id: version.id,
    sender_actor_id: actor.actorId, sender_actor_type: actor.actorType, sender: signer, contact,
    sender_consent: true, sender_evidence: { ...requestMetadata, signedAt,
      consentText: 'I agree to this quotation and agreement and consent to sign electronically.' },
    snapshot, document_hash: hash(JSON.stringify({ snapshot, sender: signer, contact })),
    finalization_status: 'pending' };
  if (!persist) return envelope;
  const result = await db.from('sales_agreement_envelope').insert(envelope).select('*').single();
  if (result.error?.code === '23505') throw new SalesHttpError(409, 'Agreement was signed concurrently. Reload before sending.');
  return checked(result);
}
export async function agreementPdf(envelope) {
  const { buildSalesAgreementPdf } = await import('./salesAgreementDocument.js');
  return buildSalesAgreementPdf({ ...envelope.snapshot, sender: envelope.sender,
    customer: envelope.customer, documentHash: envelope.document_hash });
}
export async function agreementOtp(db, found, token, action, code, dependencies = {}) {
  if (!hasSalesAgreement(found.version)) throw new SalesHttpError(400, 'This quote does not require signature verification');
  const envelope = await getSalesAgreement(db, found.version.id);
  if (!envelope || envelope.contact.email !== found.row.recipient_email.toLowerCase()) throw new SalesHttpError(409, 'Agreement recipient does not match');
  if (envelope.customer) throw new SalesHttpError(409, 'Agreement already accepted');
  const sending = action === 'send-otp';
  if (!sending && !/^\d{6}$/.test(code || '')) throw new SalesHttpError(400, 'Enter the six-digit verification code');
  const secret = sending ? crypto.randomInt(0, 1000000).toString().padStart(6, '0') : code;
  const verificationProof = sending ? null : crypto.randomBytes(32).toString('base64url');
  const result = checked(await db.rpc('sales_agreement_otp', {
    p_token_id: found.row.id, p_action: sending ? 'send' : 'verify', p_hash: hash(`${token}:${secret}`),
    p_proof_hash: verificationProof ? hash(`${token}:${verificationProof}`) : null,
  }));
  if (!result?.ok) throw new SalesHttpError(sending ? 429 : 400, result?.error || 'Verification failed');
  if (!sending) return { verified: true, verificationProof, expiresInSeconds: 600 };
  let delivery;
  try {
    delivery = await (dependencies.sendEmail || sendEmail)({ tenantId: found.row.tenant_id,
      to: envelope.contact.email, subject: 'Your agreement signing verification code',
      text: `Your verification code is ${secret}. It expires in 10 minutes. Do not share this code.`,
      html: `<p>Your agreement signing verification code is <strong>${secret}</strong>.</p><p>It expires in 10 minutes. Do not share this code.</p>` });
  } catch { throw new SalesHttpError(502, 'Verification email could not be sent. Please retry after one minute.'); }
  if (!delivery?.success) throw new SalesHttpError(502, 'Verification email could not be sent. Please retry after one minute.');
  return { sent: true, expiresInSeconds: 600 };
}
export async function finalizeSalesAgreement(db, envelope, dependencies = {}) {
  if (!envelope?.customer) throw new SalesHttpError(409, 'Agreement has not been accepted');
  if (envelope.finalization_status === 'complete') return envelope;
  const path = `${envelope.tenant_id}/${envelope.id}/final.pdf`;
  try {
    const storage = db.storage.from('sales-agreements');
    // Never overwrite a retained artifact. A concurrent/retried worker reuses it.
    let file = await storage.download(path);
    if (file.error) {
      const pdf = await (dependencies.buildPdf || agreementPdf)(envelope);
      const upload = await storage.upload(path, pdf, { contentType: 'application/pdf', upsert: false });
      if (upload.error && !['409', 'Duplicate'].includes(String(upload.error.statusCode || upload.error.error))) {
        // A concurrent successful upload can also be reported as a 400.
        file = await storage.download(path);
        if (file.error) throw upload.error;
      }
    }
    file = await storage.download(path);
    if (file.error) throw file.error;
    const pdfHash = hash(Buffer.from(await file.data.arrayBuffer()));
    return checked(await db.from('sales_agreement_envelope').update({ finalization_status: 'complete',
      final_pdf_path: path, final_pdf_hash: pdfHash, finalized_at: new Date().toISOString(), finalization_error: null })
      .eq('id', envelope.id).select('*').single());
  } catch {
    const current = await getSalesAgreement(db, envelope.quote_version_id);
    if (current?.finalization_status === 'complete') return current;
    checked(await db.from('sales_agreement_envelope').update({ finalization_status: 'failed',
      finalization_error: 'PDF retention failed; retry finalization.' }).eq('id', envelope.id).neq('finalization_status', 'complete'));
    return { ...envelope, finalization_status: 'failed' };
  }
}
export async function downloadSalesAgreement(db, envelope) {
  if (envelope?.finalization_status !== 'complete' || !envelope.final_pdf_path) throw new SalesHttpError(409, 'Final agreement PDF is not ready. Retry finalization.');
  const blob = checked(await db.storage.from('sales-agreements').download(envelope.final_pdf_path));
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (hash(buffer) !== envelope.final_pdf_hash) throw new SalesHttpError(500, 'Retained agreement integrity check failed');
  return buffer;
}

export async function finalizeAndNotifySalesAgreement(db, envelope, dependencies = {}) {
  const finalized = await finalizeSalesAgreement(db, envelope, dependencies);
  if (finalized.finalization_status !== 'complete') return finalized;
  const statuses = {};
  for (const party of ['sender', 'customer']) {
    try {
      const claim = checked(await db.rpc('claim_sales_agreement_completion_notice', {
        p_envelope_id: finalized.id, p_party: party,
      }));
      if (claim) {
        let result;
        try {
          const pdf = await downloadSalesAgreement(db, finalized);
          result = await (dependencies.sendEmail || sendEmail)({
            tenantId: finalized.tenant_id, to: claim.recipient_email,
            subject: 'Your signed Sales agreement is complete',
            text: 'Both parties have signed the Sales agreement. The retained final signed PDF is attached. Please keep it for your records.',
            html: '<p>Both parties have signed the Sales agreement. The retained final signed PDF is attached. Please keep it for your records.</p>',
            attachments: [{ filename: 'signed-sales-agreement.pdf', data: pdf, contentType: 'application/pdf' }],
          });
        } catch { result = { success: false }; }
        const status = result?.success ? 'sent' : 'failed';
        checked(await db.from('sales_agreement_completion_notice').update({
          status, sent_at: result?.success ? new Date().toISOString() : null,
          // A failed provider attempt waits at least one minute before retry.
          lease_until: result?.success ? null : new Date(Date.now() + 60000).toISOString(),
          last_error: result?.success ? null : 'Completion email failed; retry finalization.',
        }).eq('envelope_id', finalized.id).eq('party', party).eq('attempts', claim.attempts));
        statuses[party] = status;
      } else {
        const notice = checked(await db.from('sales_agreement_completion_notice').select('status')
          .eq('envelope_id', finalized.id).eq('party', party).maybeSingle());
        statuses[party] = notice?.status || 'pending';
      }
    } catch {
      // Acceptance/PDF retention must not be rolled back by notification faults.
      statuses[party] = 'failed';
    }
  }
  return { ...finalized, completionNotifications: statuses };
}

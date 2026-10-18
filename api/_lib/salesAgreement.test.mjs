import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { hasSalesAgreement, validateAgreementSignature, prepareSalesAgreement, agreementDto,
  agreementOtp, finalizeSalesAgreement, finalizeAndNotifySalesAgreement, downloadSalesAgreement } from './salesAgreement.js';
import { sanitizeAgreementHtml } from './salesAgreementHtml.js';
import { requestSalesAgreementSignature, signingRequestDto, validateSigningRequest } from './salesAgreementSigningRequests.js';
import { createPublicSalesQuoteHandler, clearPublicSalesQuoteRateLimits } from '../public/sales-quote/[...path].js';

const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#000' } }).png().toBuffer();
const signature = { mode: 'typed', typedName: 'Seller', data: `data:image/png;base64,${png.toString('base64')}` };
const actor = { actorId: 'actor', actorType: 'tenant_user', tenantId: 'tenant' };
const version = { id: 'version', version_number: 1, status: 'sent', terms_snapshot: { legalHtml: '<p>Legal terms</p>' } };
const body = { senderConsent: true, senderSignature: signature, senderName: 'Seller', senderRole: 'Director',
  recipient: 'buyer@example.org', contactName: 'Buyer', contactRole: 'Director', contactEmail: 'buyer@example.org' };
const input = { quote: { id: 'quote', tenant_id: 'tenant', quote_number: 'Q-1' }, version, tenant: { name: 'Seller Ltd' },
  actor, sender: { id: 'actor', kind: 'tenant_user', email: 'seller@example.org' }, body };
const envelopeDb = value => ({ from(table) {
  assert.equal(table, 'sales_agreement_envelope');
  return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: value, error: null }) };
} });

test('opt-in legal rich text is sanitized before snapshot; empty editor stays legacy', () => {
  assert.equal(hasSalesAgreement({ terms_snapshot: {} }), false);
  assert.equal(hasSalesAgreement(version), true);
  assert.equal(sanitizeAgreementHtml('<p><br></p>'), '');
  const clean = sanitizeAgreementHtml('<h2>Terms</h2><p onclick="evil()">Text<strong>bold</strong></p><script>evil()</script><img src="https://evil/">');
  assert.match(clean, /<h2>Terms<\/h2>/);
  assert.match(clean, /<strong>bold<\/strong>/);
  assert.doesNotMatch(clean, /onclick|script|evil|img/);
});

test('signature validation decodes PNG and rejects forged, oversized and unsupported data', async () => {
  assert.deepEqual(await validateAgreementSignature(signature), signature);
  for (const value of [null, { ...signature, mode: 'other' }, { ...signature, typedName: '' },
    { ...signature, data: 'data:image/svg+xml;base64,AAAA' },
    { ...signature, data: `data:image/png;base64,${Buffer.concat([png.subarray(0, 24), Buffer.alloc(10)]).toString('base64')}` },
    { ...signature, data: `data:image/png;base64,${'A'.repeat(700001)}` }]) {
    await assert.rejects(validateAgreementSignature(value), error => error.status === 400);
  }
});

test('sender cannot impersonate colleague and explicit consent/contact are mandatory', async () => {
  await assert.rejects(prepareSalesAgreement(envelopeDb(null), { ...input, sender: { ...input.sender, id: 'colleague' } }),
    error => error.status === 403 && error.code === 'COUNTERSIGN_REQUIRED');
  await assert.rejects(prepareSalesAgreement(envelopeDb(null), { ...input, body: { ...body, senderConsent: false } }), /consent/);
  await assert.rejects(prepareSalesAgreement(envelopeDb(null), { ...input, body: { ...body, contactEmail: 'other@example.org' } }), /must match/);
  assert.equal(await prepareSalesAgreement({}, { ...input, version: {} }), null);
});

test('preview is read-only; envelope captures frozen snapshot; resend cannot change signers', async () => {
  const envelope = await prepareSalesAgreement(envelopeDb(null), input);
  assert.equal(envelope.sender.email, 'seller@example.org');
  assert.equal(envelope.sender_consent, true);
  assert.match(envelope.document_hash, /^[0-9a-f]{64}$/);
  assert.equal(envelope.snapshot.version.terms_snapshot.legalHtml, '<p>Legal terms</p>');
  assert.deepEqual(agreementDto(envelope).sender.signature, signature);
  assert.equal(await prepareSalesAgreement(envelopeDb(envelope), input), envelope);
  await assert.rejects(prepareSalesAgreement(envelopeDb(envelope), { ...input, body: { ...body, contactName: 'Other' } }), /frozen/);
  const resent = await prepareSalesAgreement(envelopeDb(envelope), {
    ...input, actor: { ...actor, actorId: 'authorized-manager' }, body: { recipient: body.recipient },
  });
  assert.equal(resent, envelope);
});

test('internal signing request saves draft and emails only colleague trusted authenticated deep link', async () => {
  const sender = { id: 'colleague', kind: 'tenant_user', key: 'tenant_user:colleague', name: 'Colleague', email: 'colleague@example.org' };
  const quote = { ...input.quote, current_version: 1, versions: [version] };
  let rpc; let mail; let update;
  const row = { id: '00000000-0000-0000-0000-000000000005', quote_version_id: version.id,
    sender_actor_id: sender.id, sender_actor_type: sender.kind, status: 'pending', expires_at: '2099-01-01' };
  const db = {
    from(table) {
      if (table === 'sales_agreement_envelope') return envelopeDb(null).from(table);
      assert.equal(table, 'sales_agreement_signing_request');
      return { update(value) { update = value; return this; }, eq() { return this; }, then(resolve) { resolve({ error: null }); } };
    },
    async rpc(name, args) { rpc = { name, args }; return { data: { ...row, draft: args.p_draft } }; },
  };
  const result = await requestSalesAgreementSignature(db, { ...input, quote, sender, tenant: { slug: 'trusted' },
    body: { ...body, expiresInDays: 7, personalMessage: 'Please review' } }, {
    sendEmail: async value => { mail = value; return { success: true }; },
  });
  assert.equal(rpc.name, 'request_sales_agreement_signature');
  assert.equal(rpc.args.p_draft.personalMessage, 'Please review');
  assert.equal(rpc.args.p_requester_id, actor.actorId);
  assert.equal(mail.to, 'colleague@example.org');
  assert.match(mail.text, /https:\/\/trusted\.iconn\.app\/sales\/quotes\/quote\?signingRequest=/);
  assert.equal(result.request.canSign, false);
  assert.equal(update.notification_status, 'sent');
  assert.equal(signingRequestDto(row, { ...actor, actorId: sender.id }, quote, null).canSign, true);
  const restrictedDb = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: row }) }; } };
  await assert.rejects(validateSigningRequest(restrictedDb, row.id, quote, version, actor), error => error.status === 403);
  assert.equal(await validateSigningRequest(restrictedDb, row.id, quote, version, { ...actor, actorId: sender.id }), row);
});

test('OTP is sent only to frozen recipient; database receives hash, not clear code; failure surfaced', async () => {
  const envelope = await prepareSalesAgreement(envelopeDb(null), input);
  const found = { version, row: { id: 'token-id', tenant_id: 'tenant', recipient_email: body.recipient } };
  let rpc; let message;
  const db = { ...envelopeDb(envelope), rpc: async (name, args) => { rpc = { name, args }; return { data: { ok: true } }; } };
  assert.deepEqual(await agreementOtp(db, found, 'secret-token', 'send-otp', null, {
    sendEmail: async value => { message = value; return { success: true }; },
  }), { sent: true, expiresInSeconds: 600 });
  assert.equal(message.to, body.recipient);
  const code = message.text.match(/\b\d{6}\b/)[0];
  assert.equal(rpc.args.p_hash, crypto.createHash('sha256').update(`secret-token:${code}`).digest('hex'));
  assert.equal(rpc.name, 'sales_agreement_otp');
  assert.equal(JSON.stringify(rpc).includes(code), false);
  const verification = await agreementOtp(db, found, 'secret-token', 'verify-otp', code);
  assert.equal(verification.verified, true);
  assert.match(verification.verificationProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(rpc.args.p_proof_hash, crypto.createHash('sha256').update(`secret-token:${verification.verificationProof}`).digest('hex'));
  await assert.rejects(agreementOtp(db, found, 'secret-token', 'verify-otp', 'bad'), /six-digit/);
  await assert.rejects(agreementOtp(db, found, 'secret-token', 'send-otp', null, {
    sendEmail: async () => ({ success: false }),
  }), error => error.status === 502);
});

test('retention retries reuse immutable private artifact and downloads verify hash', async () => {
  const base = await prepareSalesAgreement(envelopeDb(null), input);
  const envelope = { ...base, id: 'envelope', customer: { name: 'Buyer', signature } };
  let artifact; let uploads = 0; let builds = 0; let update;
  const storage = {
    download: async () => artifact ? { data: new Blob([artifact]) } : { error: { message: 'not found' } },
    upload: async (path, pdf, options) => {
      assert.equal(path, 'tenant/envelope/final.pdf'); assert.equal(options.upsert, false);
      uploads++; artifact = pdf; return {};
    },
  };
  const db = { storage: { from(bucket) { assert.equal(bucket, 'sales-agreements'); return storage; } },
    from() { return { update(value) { update = value; return this; }, eq() { return this; }, select() { return this; },
      single: async () => ({ data: { ...envelope, ...update } }) }; } };
  const dependencies = { buildPdf: async () => { builds++; return Buffer.from('%PDF-retained'); } };
  const complete = await finalizeSalesAgreement(db, envelope, dependencies);
  assert.equal(complete.finalization_status, 'complete');
  assert.equal((await downloadSalesAgreement(db, complete)).toString(), '%PDF-retained');
  await finalizeSalesAgreement(db, envelope, dependencies);
  await finalizeSalesAgreement(db, complete, dependencies);
  assert.equal(uploads, 1); assert.equal(builds, 1);
  artifact = Buffer.from('tampered');
  await assert.rejects(downloadSalesAgreement(db, complete), /integrity/);
  await assert.rejects(downloadSalesAgreement(db, envelope), error => error.status === 409);
});

test('completion delivers retained PDF to both frozen parties and reports independent failures', async () => {
  const artifact = Buffer.from('%PDF-retained');
  const envelope = { id: 'envelope', tenant_id: 'tenant', customer: { email: 'buyer@example.org' },
    finalization_status: 'complete', final_pdf_path: 'private.pdf',
    final_pdf_hash: crypto.createHash('sha256').update(artifact).digest('hex') };
  const messages = []; const updates = [];
  const db = {
    storage: { from: () => ({ download: async () => ({ data: new Blob([artifact]) }) }) },
    rpc: async (name, args) => {
      assert.equal(name, 'claim_sales_agreement_completion_notice');
      return { data: { attempts: 1, recipient_email: args.p_party === 'sender' ? 'seller@example.org' : 'buyer@example.org' } };
    },
    from: () => ({ update(value) { updates.push(value); return this; }, eq() { return this; },
      then(resolve) { resolve({ error: null }); } }),
  };
  const completed = await finalizeAndNotifySalesAgreement(db, envelope, {
    sendEmail: async message => { messages.push(message); return { success: message.to === 'seller@example.org' }; },
  });
  assert.deepEqual(messages.map(message => message.to), ['seller@example.org', 'buyer@example.org']);
  assert.ok(messages.every(message => message.attachments[0].data.equals(artifact)));
  assert.deepEqual(completed.completionNotifications, { sender: 'sent', customer: 'failed' });
  assert.equal(completed.finalization_status, 'complete');
  assert.deepEqual(updates.map(item => item.status), ['sent', 'failed']);
});

test('accept forwards validated consent/signature into existing atomic decision RPC', async () => {
  clearPublicSalesQuoteRateLimits();
  const token = 't'.repeat(43);
  const rows = { sales_quote_delivery_token: { id: 'token-id', tenant_id: 'tenant', quote_id: 'quote',
    quote_version_id: 'version', activated_at: '2026-01-01', expires_at: '2099-01-01' },
  sales_quote: { current_version: 1 }, sales_quote_version: version, tenant: {} };
  let call;
  const db = { from(table) { return { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: rows[table] }) }; },
  rpc: async (name, args) => { call = { name, args }; return { data: { outcome: 'conflict' } }; } };
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await createPublicSalesQuoteHandler({ db })({ method: 'POST', url: `/api/public/sales-quote/${token}/accept`,
    headers: { 'x-forwarded-for': 'forged', 'x-real-ip': 'trusted' }, body: {
      name: 'Buyer', role: 'Director', agreement: true, consent: true, signature, idempotencyKey: 'once', verificationProof: 'p'.repeat(43),
    } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.name, 'decide_sales_quote_public');
  assert.equal(call.args.p_request_metadata.agreementEvidence.consent, true);
  assert.equal(call.args.p_request_metadata.agreementEvidence.signature.data, signature.data);
  assert.equal(call.args.p_request_metadata.ip, 'trusted');
});

test('migration safety: no backfill, private bucket, immutable evidence and atomic acceptance guard', async () => {
  const sql = await readFile('supabase/migrations/202610190001_sales_agreements.sql', 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /FROM PUBLIC,anon,authenticated/);
  assert.match(sql, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(sql, /FOR UPDATE/g);
  assert.match(sql, /attempts>=5/);
  assert.match(sql, /o\.sends>=5/);
  assert.match(sql, /o\.expires_at>now\(\)/);
  assert.match(sql, /BEFORE INSERT ON public\.sales_quote_customer_decision/);
  assert.match(sql, /BEFORE UPDATE ON public\.sales_quote_version/);
  assert.match(sql, /Customer signature evidence is immutable/);
  assert.match(sql, /Final agreement artifact is immutable/);
  assert.match(sql, /'sales-agreements','sales-agreements',false/);
  assert.doesNotMatch(sql, /UPDATE public\.sales_quote_version SET|UPDATE public\.sales_quote SET|DELETE FROM|TRUNCATE/);
});

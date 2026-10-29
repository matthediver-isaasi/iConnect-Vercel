import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const ISSUED_CERTIFICATE_BUCKET = 'issued-cpd-certificates';
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
export const awardSignature = rows => hash(JSON.stringify((rows || []).map(row => ({
  id: row.id, member_id: row.member_id, points_value: Number(row.points_value), entry_kind: row.entry_kind,
})).sort((a, b) => String(a.id).localeCompare(String(b.id)))));

export async function loadIssuedCertificate(db, tenantId, key) {
  const { data, error } = await db.from('issued_cpd_certificate').select('*')
    .eq('tenant_id', tenantId).eq('certificate_key', key).maybeSingle();
  if (error) throw error; // Missing migration/provider failure is never "no certificate".
  if (data && (!data.source_path?.startsWith(`${tenantId}/issued-cpd/`)
    || !/^[a-f0-9]{64}$/.test(data.pdf_sha256 || ''))) throw new Error('Invalid stored certificate');
  return data;
}

export async function readIssuedCertificate(db, issued) {
  const { data, error } = await db.storage.from(ISSUED_CERTIFICATE_BUCKET).download(issued.source_path);
  if (error || !data) throw new Error('The saved certificate could not be read');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (hash(bytes) !== issued.pdf_sha256) throw new Error('Saved certificate integrity check failed');
  return bytes;
}

// Called only after the caller's final authority/consent recheck, never by previews.
// Upload first, then publish atomically. Concurrent losers return the winner's PDF.
export async function retainIssuedCertificate(db, resolved, pdf, captureReason) {
  if (resolved.issuedCertificate) return readIssuedCertificate(db, resolved.issuedCertificate);
  const identity = resolved.certificateIdentity;
  if (!identity) return pdf; // Standalone manual awards already have private immutable PDFs.
  const { tenantId, key } = identity;
  const useWinner = winner => {
    const definition = value => JSON.stringify(canonical({
      source: value.template?.source_sha256, values: value.values,
      placeholders: value.placeholders, award: value.award_signature ?? value.awardSignature,
    }));
    if (definition(winner.snapshot) !== definition(resolved)) {
      throw new Error('Another certificate version was issued. Reload and review before continuing.');
    }
    return readIssuedCertificate(db, winner);
  };
  const existing = await loadIssuedCertificate(db, tenantId, key);
  if (existing) return useWinner(existing);
  const path = `${tenantId}/issued-cpd/${randomUUID()}.pdf`;
  const uploaded = await db.storage.from(ISSUED_CERTIFICATE_BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (uploaded.error) throw uploaded.error;
  const snapshot = {
    template: resolved.template, template_name: resolved.template_name || resolved.template?.name,
    placeholders: resolved.placeholders, values: resolved.values,
    policy: resolved.certificatePolicy || null, award_signature: resolved.awardSignature || null,
  };
  const { error } = await db.from('issued_cpd_certificate').insert({
    tenant_id: tenantId, certificate_key: key, source_path: path, pdf_sha256: hash(pdf),
    snapshot, capture_reason: captureReason,
  });
  if (!error) return pdf;
  // Do not delete on an ambiguous database failure: the insert may have committed.
  // A unique conflict definitively means this object's path was not published.
  if (error.code !== '23505') throw error;
  const winner = await loadIssuedCertificate(db, tenantId, key);
  if (!winner) throw new Error('Saved certificate publication could not be confirmed');
  await db.storage.from(ISSUED_CERTIFICATE_BUCKET).remove([path]);
  return useWinner(winner);
}

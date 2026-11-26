import crypto from 'node:crypto';
import { agreementPdf, agreementPdfContext, downloadSalesAgreement, finalAgreementPdfPath } from './salesAgreement.js';
import { SALES_QUOTE_PDF_LAYOUT } from './salesQuotePdf.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const REFORMAT_ENVELOPE_COLUMNS = 'id,tenant_id,quote_id,quote_version_id,snapshot,sender,contact,customer,document_hash,finalization_status,final_pdf_path,final_pdf_hash,finalized_at';

/**
 * Re-render one completed agreement's retained PDF with the current commercial
 * layout. The signed snapshot, signatures and document hash are read only.
 * The original file stays in storage; the database switch (and its history
 * row) happens in one guarded RPC. Any failure leaves the original active.
 */
export async function reformatSignedSalesAgreement(db, envelope, { dryRun = true, buildPdf, loadContext } = {}) {
  const result = { id: envelope.id, tenantId: envelope.tenant_id, from: envelope.final_pdf_path };
  if (envelope.finalization_status !== 'complete' || !envelope.customer) return { ...result, status: 'skipped', reason: 'not_complete' };
  const path = await finalAgreementPdfPath(envelope);
  if (envelope.final_pdf_path === path) return { ...result, status: 'skipped', reason: 'already_reformatted' };
  try {
    // The original must still pass its integrity check before it is superseded.
    await downloadSalesAgreement(db, envelope);
  } catch (error) {
    return { ...result, status: 'failed', reason: `original_unavailable: ${error.message}` };
  }
  if (dryRun) return { ...result, status: 'would_reformat', to: path };
  try {
    const storage = db.storage.from('sales-agreements');
    let existing = await storage.download(path);
    if (existing.error) {
      const context = await (loadContext || agreementPdfContext)(db, envelope);
      const pdf = await (buildPdf || agreementPdf)(envelope, context);
      // Never overwrite: a file left by an interrupted run is reused as-is.
      const upload = await storage.upload(path, pdf, { contentType: 'application/pdf', upsert: false });
      existing = await storage.download(path);
      if (existing.error) throw upload.error || existing.error;
    }
    const bytes = Buffer.from(await existing.data.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('Replacement is not a PDF');
    const hash = sha256(bytes);
    const { data, error } = await db.rpc('supersede_sales_agreement_final_pdf', {
      p_envelope_id: envelope.id, p_expected_path: envelope.final_pdf_path, p_expected_hash: envelope.final_pdf_hash,
      p_new_path: path, p_new_hash: hash, p_layout: SALES_QUOTE_PDF_LAYOUT,
    });
    if (error) throw error;
    if (!data?.ok) return { ...result, status: 'failed', reason: data?.reason || 'supersede_rejected' };
    // Confirm the active file now passes the normal download integrity check.
    await downloadSalesAgreement(db, { ...envelope, final_pdf_path: path, final_pdf_hash: hash });
    return { ...result, status: data.changed ? 'reformatted' : 'skipped', reason: data.changed ? undefined : 'already_reformatted', to: path, hash };
  } catch (error) {
    return { ...result, status: 'failed', reason: error.message || String(error) };
  }
}

export async function reformatSignedSalesAgreements(db, { dryRun = true, tenantId, limit, pageSize = 50, ...options } = {}) {
  const results = [];
  let from = 0;
  for (;;) {
    let query = db.from('sales_agreement_envelope').select(REFORMAT_ENVELOPE_COLUMNS)
      .eq('finalization_status', 'complete').order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { data, error } = await query;
    if (error) throw error;
    for (const envelope of data || []) {
      const outcome = await reformatSignedSalesAgreement(db, envelope, { dryRun, ...options });
      if (outcome.status === 'skipped') { results.push(outcome); continue; }
      results.push(outcome);
      if (limit && results.filter(r => r.status !== 'skipped').length >= limit) return results;
    }
    if (!data || data.length < pageSize) return results;
    from += pageSize;
  }
}

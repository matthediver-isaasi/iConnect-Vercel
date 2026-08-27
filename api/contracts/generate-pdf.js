import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';
import {
  buildFormSubmissionPdf,
  loadFormSubmissionRelationshipLabels,
} from '../_lib/formSubmissionPdf.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { submissionId, internalToken } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'Missing submissionId' });
    }
    
    const isInternalCall = INTERNAL_API_SECRET && internalToken === INTERNAL_API_SECRET;
    let sessionTenantId = null;
    
    if (!isInternalCall) {
      const session = await getSessionTenantUser(req, res);
      if (!session) {
        return res.status(401).json({ error: 'Unauthorized - authentication required' });
      }
      sessionTenantId = session.tenantId;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: submission, error: subError } = await supabase
      .from('form_submission')
      .select('*, pdf_path, form:form_id(id, name, fields, tenant_id)')
      .eq('id', submissionId)
      .single();

    if (subError || !submission) {
      console.error('[contracts/generate-pdf] Submission fetch error:', subError);
      return res.status(404).json({ error: 'Submission not found' });
    }

    const tenantId = submission.tenant_id;
    const previousPdfPath = submission.pdf_path || null;
    
    if (!isInternalCall && submission.tenant_id !== sessionTenantId) {
      console.error('[contracts/generate-pdf] Tenant mismatch:', { submissionTenant: submission.tenant_id, sessionTenant: sessionTenantId });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const form = submission.form;
    const submissionData = submission.submission_data || {};
    const fields = Array.isArray(form?.fields) ? form.fields : [];
    const relationshipLabelsByRecordId = await loadFormSubmissionRelationshipLabels({
      db: supabase,
      tenantId,
      fields,
      submissionData,
    });

    const signedDate = new Date(submission.created_date).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const pdfBuffer = buildFormSubmissionPdf({
      title: form.name || 'Contract',
      dateLabel: `Signed: ${signedDate}`,
      fields,
      submissionData,
      relationshipLabelsByRecordId,
      logPrefix: '[contracts/generate-pdf]'
    });

    const signerEmail = submissionData.signer_email || 'unknown';
    const sanitizedEmail = signerEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const fileName = `contract_${submissionId}_${sanitizedEmail}_${Date.now()}.pdf`;
    const storagePath = `${tenantId}/contracts/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('private-uploads')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadError) {
      console.error('[contracts/generate-pdf] Upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload PDF', details: uploadError.message });
    }

    // Track cumulative tenant storage usage. NB: `upsert: true` means a
    // regenerated PDF for the same submission overwrites the previous file
    // rather than adding bytes, so we may over-count on regeneration —
    // re-baselined by scripts/recompute-tenant-storage.mjs.
    if (tenantId) {
      addTenantStorageBytes(tenantId, pdfBuffer.length).catch(() => {});
    }

    const { error: updateError } = await supabase
      .from('form_submission')
      .update({ pdf_path: storagePath })
      .eq('id', submissionId);

    if (updateError) {
      console.error('[contracts/generate-pdf] Failed to update submission with PDF path:', updateError);
      await supabase.storage.from('private-uploads').remove([storagePath]);
      // Roll back the storage counter increment we made above so the tenant
      // isn't charged for bytes that were just removed.
      if (tenantId) {
        addTenantStorageBytes(tenantId, -pdfBuffer.length).catch(() => {});
      }
      return res.status(500).json({ error: 'Failed to save PDF reference', details: updateError.message });
    }

    // Regeneration cleanup: the previous PDF lives at a different path (filename
    // includes Date.now()), so the new upload doesn't overwrite it. Delete the
    // old object now that pdf_path has been swapped, and decrement the tenant
    // storage counter by its actual size.
    if (previousPdfPath && previousPdfPath !== storagePath) {
      try {
        const lastSlash = previousPdfPath.lastIndexOf('/');
        const dir = lastSlash >= 0 ? previousPdfPath.slice(0, lastSlash) : '';
        const name = lastSlash >= 0 ? previousPdfPath.slice(lastSlash + 1) : previousPdfPath;
        let previousSize = 0;
        try {
          const { data: listed } = await supabase.storage
            .from('private-uploads')
            .list(dir, { search: name, limit: 1 });
          const entry = Array.isArray(listed) ? listed.find((e) => e.name === name) : null;
          const n = Number(entry?.metadata?.size);
          if (Number.isFinite(n) && n > 0) previousSize = n;
        } catch {}
        const { error: oldRemoveErr } = await supabase.storage
          .from('private-uploads')
          .remove([previousPdfPath]);
        if (oldRemoveErr) {
          console.warn('[contracts/generate-pdf] Failed to remove previous PDF:', oldRemoveErr.message || oldRemoveErr);
        } else if (tenantId && previousSize > 0) {
          addTenantStorageBytes(tenantId, -previousSize).catch(() => {});
        }
      } catch (cleanupErr) {
        console.warn('[contracts/generate-pdf] Previous PDF cleanup failed:', cleanupErr?.message || cleanupErr);
      }
    }

    return res.status(200).json({
      success: true,
      pdfPath: storagePath,
      fileName
    });

  } catch (error) {
    console.error('[contracts/generate-pdf] Error:', error);
    return res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
}

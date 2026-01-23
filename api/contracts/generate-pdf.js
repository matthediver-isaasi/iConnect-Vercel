import { createClient } from '@supabase/supabase-js';
import { jsPDF } from 'jspdf';
import { getSessionTenantUser } from '../_lib/session.js';

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
      .select('*, form:form_id(id, name, fields, tenant_id)')
      .eq('id', submissionId)
      .single();

    if (subError || !submission) {
      console.error('[contracts/generate-pdf] Submission fetch error:', subError);
      return res.status(404).json({ error: 'Submission not found' });
    }

    const tenantId = submission.tenant_id;
    
    if (!isInternalCall && submission.tenant_id !== sessionTenantId) {
      console.error('[contracts/generate-pdf] Tenant mismatch:', { submissionTenant: submission.tenant_id, sessionTenant: sessionTenantId });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const form = submission.form;
    const submissionData = submission.submission_data || {};

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let yPos = margin;

    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(form.name || 'Contract', margin, yPos);
    yPos += 12;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    const signedDate = new Date(submission.created_date).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    doc.text(`Signed: ${signedDate}`, margin, yPos);
    yPos += 15;

    doc.setTextColor(0);

    let allFields = [];
    if (form.fields && Array.isArray(form.fields)) {
      allFields = form.fields;
    }

    for (const field of allFields) {
      if (field.type === 'instructions' || field.type === 'heading') {
        continue;
      }

      if (yPos > pageHeight - 40) {
        doc.addPage();
        yPos = margin;
      }

      const value = submissionData[field.id];

      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(field.label || field.id, margin, yPos);
      yPos += 5;

      doc.setFont('helvetica', 'normal');

      if (field.type === 'signature') {
        if (value && typeof value === 'object' && value.data) {
          try {
            const base64Data = value.data;
            if (base64Data.startsWith('data:image/png;base64,')) {
              const imgWidth = 60;
              const imgHeight = 20;
              
              if (yPos + imgHeight > pageHeight - margin) {
                doc.addPage();
                yPos = margin;
              }
              
              doc.addImage(base64Data, 'PNG', margin, yPos, imgWidth, imgHeight);
              yPos += imgHeight + 3;
              
              if (value.mode === 'typed' && value.typedName) {
                doc.setFontSize(8);
                doc.setTextColor(100);
                doc.text(`(Typed: ${value.typedName})`, margin, yPos);
                doc.setTextColor(0);
                yPos += 4;
              }
              
              if (value.signed_at) {
                doc.setFontSize(8);
                doc.setTextColor(100);
                const signedAt = new Date(value.signed_at).toLocaleString('en-GB');
                doc.text(`Signed at: ${signedAt}`, margin, yPos);
                doc.setTextColor(0);
                yPos += 4;
              }
            }
          } catch (imgError) {
            console.error('[contracts/generate-pdf] Error adding signature image:', imgError);
            doc.text('[Signature]', margin, yPos);
            yPos += 5;
          }
        } else {
          doc.text('[No signature]', margin, yPos);
          yPos += 5;
        }
      } else if (field.type === 'contact') {
        if (value && typeof value === 'object') {
          const contactParts = [];
          if (value.firstName) contactParts.push(value.firstName);
          if (value.lastName) contactParts.push(value.lastName);
          if (value.email) contactParts.push(`<${value.email}>`);
          doc.text(contactParts.join(' ') || '-', margin, yPos);
        } else {
          doc.text('-', margin, yPos);
        }
        yPos += 6;
      } else if (field.type === 'boolean' || field.type === 'terms_conditions') {
        doc.text(value ? 'Yes' : 'No', margin, yPos);
        yPos += 6;
      } else if (field.type === 'file_upload' || field.type === 'file') {
        if (value) {
          const fileInfo = typeof value === 'string' ? value : (value.name || value.filename || '[File attached]');
          doc.text(`[Uploaded: ${fileInfo}]`, margin, yPos);
        } else {
          doc.text('[No file uploaded]', margin, yPos);
        }
        yPos += 6;
      } else if (Array.isArray(value)) {
        const arrayText = value.join(', ') || '-';
        const lines = doc.splitTextToSize(arrayText, contentWidth);
        doc.text(lines, margin, yPos);
        yPos += lines.length * 5 + 3;
      } else if (typeof value === 'object' && value !== null) {
        const objText = JSON.stringify(value, null, 2);
        const lines = doc.splitTextToSize(objText, contentWidth);
        doc.text(lines, margin, yPos);
        yPos += lines.length * 5 + 3;
      } else {
        const textValue = value?.toString() || '-';
        const lines = doc.splitTextToSize(textValue, contentWidth);
        doc.text(lines, margin, yPos);
        yPos += lines.length * 5 + 3;
      }

      yPos += 3;
    }

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));

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

    const { error: updateError } = await supabase
      .from('form_submission')
      .update({ pdf_path: storagePath })
      .eq('id', submissionId);

    if (updateError) {
      console.error('[contracts/generate-pdf] Failed to update submission with PDF path:', updateError);
      await supabase.storage.from('private-uploads').remove([storagePath]);
      return res.status(500).json({ error: 'Failed to save PDF reference', details: updateError.message });
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

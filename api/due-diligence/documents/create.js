import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { 
      formSubmissionId, 
      fieldName,
      fileUrl, 
      fileName, 
      fileSize, 
      mimeType,
      supersedeDocumentId
    } = req.body;

    if (!formSubmissionId || !fieldName || !fileUrl || !fileName) {
      return res.status(400).json({ 
        error: 'formSubmissionId, fieldName, fileUrl, and fileName are required' 
      });
    }

    let version = 1;
    let originalFileName = fileName;

    const { data: currentVersionDocs } = await supabase
      .from('submission_document')
      .select('id, version, status, original_file_name')
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('form_submission_id', formSubmissionId)
      .eq('field_name', fieldName)
      .eq('is_current_version', true)
      .limit(1);

    const currentVersionDoc = currentVersionDocs?.[0];

    if (currentVersionDoc && currentVersionDoc.status === 'approved') {
      return res.status(400).json({ 
        error: 'Cannot supersede an approved document. Mark it as aged first.' 
      });
    }

    if (supersedeDocumentId) {
      const { data: existingDoc, error: fetchError } = await supabase
        .from('submission_document')
        .select('*')
        .eq('id', supersedeDocumentId)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();

      if (fetchError || !existingDoc) {
        return res.status(404).json({ error: 'Document to supersede not found' });
      }

      if (existingDoc.status === 'approved') {
        return res.status(400).json({ 
          error: 'Cannot supersede an approved document. Mark it as aged first.' 
        });
      }

      version = existingDoc.version + 1;
      originalFileName = existingDoc.original_file_name;

      const { error: updateError } = await supabase
        .from('submission_document')
        .update({ 
          is_current_version: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', supersedeDocumentId);

      if (updateError) {
        console.error('[DD Documents] Error marking old version:', updateError);
        return res.status(500).json({ error: 'Failed to update previous version' });
      }
    } else if (currentVersionDoc) {
      version = currentVersionDoc.version + 1;
      originalFileName = currentVersionDoc.original_file_name;
      
      await supabase
        .from('submission_document')
        .update({ is_current_version: false })
        .eq('id', currentVersionDoc.id);
    }

    const { data: newDocument, error: insertError } = await supabase
      .from('submission_document')
      .insert({
        tenant_id: tenantCtx.tenantId,
        form_submission_id: formSubmissionId,
        field_name: fieldName,
        original_file_name: originalFileName,
        version: version,
        is_current_version: true,
        file_url: fileUrl,
        file_name: fileName,
        file_size: fileSize,
        mime_type: mimeType,
        status: 'pending',
        superseded_by_id: supersedeDocumentId ? null : undefined
      })
      .select()
      .single();

    if (insertError) {
      console.error('[DD Documents] Create error:', insertError);
      return res.status(500).json({ error: 'Failed to create document' });
    }

    if (supersedeDocumentId) {
      await supabase
        .from('submission_document')
        .update({ superseded_by_id: newDocument.id })
        .eq('id', supersedeDocumentId);
    }

    return res.status(201).json({
      success: true,
      document: newDocument
    });

  } catch (error) {
    console.error('[DD Documents] Create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

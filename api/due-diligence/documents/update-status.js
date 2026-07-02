import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

const PUBLIC_BUCKET = 'public-assets';

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
    const { documentId, status } = req.body;

    if (!documentId || !status) {
      return res.status(400).json({ error: 'documentId and status are required' });
    }

    const validStatuses = ['pending', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    const { data: existingDoc, error: fetchError } = await supabase
      .from('submission_document')
      .select('*')
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const now = new Date().toISOString();
    const updatePayload = {
      status: status,
      status_changed_at: now,
      status_changed_by: member.email,
      updated_at: now
    };

    // When a document is moved off "approved" (e.g. unapproved back to pending,
    // or rejected), revoke any public exposure that approval set up. Approving a
    // file/logo can copy it into the public-assets bucket and persist a
    // public_file_url (see ensure-public-url.js); leaving that in place would
    // keep an erroneously-approved logo publicly accessible.
    if (status !== 'approved' && existingDoc.public_file_url) {
      // Only delete the storage object when it is a mirror we created under
      // `<tenant>/documents/published/`. Files that were already natively in the
      // public bucket are the originals and must not be removed here.
      const publicPath = existingDoc.public_storage_path;
      if (publicPath && publicPath.includes('/documents/published/')) {
        const { error: removeError } = await supabase.storage
          .from(PUBLIC_BUCKET)
          .remove([publicPath]);
        if (removeError) {
          console.error('[DD Documents] Failed to remove published public file:', removeError);
          // Continue; we still clear the columns so the URL is no longer surfaced.
        }
      }
      updatePayload.public_file_url = null;
      updatePayload.public_storage_path = null;
    }

    const { data: updatedDoc, error: updateError } = await supabase
      .from('submission_document')
      .update(updatePayload)
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('[DD Documents] Update status error:', updateError);
      return res.status(500).json({ error: 'Failed to update document status' });
    }

    return res.status(200).json({
      success: true,
      document: updatedDoc
    });

  } catch (error) {
    console.error('[DD Documents] Update status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

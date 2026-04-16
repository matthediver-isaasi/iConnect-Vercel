import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isAdmin = await hasAdminAccess(tenantContext);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantContext;
  const { id: documentId } = req.query;

  try {
    const { data: doc, error: fetchError } = await supabase
      .from('external_writer_document')
      .select('id, storage_path, bucket')
      .eq('id', documentId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (doc.storage_path && doc.bucket) {
      const { error: storageError } = await supabase.storage
        .from(doc.bucket)
        .remove([doc.storage_path]);

      if (storageError) {
        console.error('[Document Delete] Storage removal error:', storageError);
      }
    }

    const { error: deleteError } = await supabase
      .from('external_writer_document')
      .delete()
      .eq('id', documentId)
      .eq('tenant_id', tenantId);

    if (deleteError) {
      console.error('[Document Delete] DB delete error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete document' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[Document Delete] Error:', err);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
}

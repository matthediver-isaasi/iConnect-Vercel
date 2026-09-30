import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import { addTenantStorageBytes } from '../../_lib/tenantStorageUsage.js';

async function getStorageObjectSize(bucket, storagePath) {
  if (!bucket || !storagePath) return 0;
  try {
    const lastSlash = storagePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? storagePath.slice(0, lastSlash) : '';
    const name = lastSlash >= 0 ? storagePath.slice(lastSlash + 1) : storagePath;
    const { data } = await supabase.storage.from(bucket).list(dir, { search: name, limit: 1 });
    const entry = Array.isArray(data) ? data.find((e) => e.name === name) : null;
    const size = Number(entry?.metadata?.size);
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

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
      const objectSize = await getStorageObjectSize(doc.bucket, doc.storage_path);

      const { error: storageError } = await supabase.storage
        .from(doc.bucket)
        .remove([doc.storage_path]);

      if (storageError) {
        console.error('[Document Delete] Storage removal error:', storageError);
      } else if (objectSize > 0) {
        addTenantStorageBytes(tenantId, -objectSize).catch(() => {});
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

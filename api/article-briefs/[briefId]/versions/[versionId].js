import { supabase } from '../../../_lib/database.js';
import { getTenantContext } from '../../../_lib/tenantContext.js';
import { isResourceExcluded } from '../../../_lib/roleVisibility.js';
import { addTenantStorageBytes } from '../../../_lib/tenantStorageUsage.js';

async function getRoleExcludedFeatures(tenantCtx) {
  if (!tenantCtx.roleId || !supabase) return [];
  try {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', tenantCtx.roleId)
      .single();
    return role?.excluded_features || [];
  } catch {
    return [];
  }
}

function extractStoragePath(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return { bucket: null, path: null };
  try {
    const queryIndex = fileUrl.indexOf('?');
    if (queryIndex === -1) return { bucket: null, path: null };
    const params = new URLSearchParams(fileUrl.slice(queryIndex + 1));
    const path = params.get('path');
    const bucket = params.get('bucket') || 'private-uploads';
    return { bucket, path: path || null };
  } catch {
    return { bucket: null, path: null };
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const excludedFeatures = await getRoleExcludedFeatures(tenantCtx);
  if (isResourceExcluded(excludedFeatures, 'content.briefs.manage')) {
    return res.status(403).json({ error: 'You do not have permission to delete versions' });
  }

  const { briefId, versionId } = req.query;
  if (!briefId || !versionId) {
    return res.status(400).json({ error: 'briefId and versionId are required' });
  }

  try {
    const { data: version, error: fetchError } = await supabase
      .from('article_brief_version')
      .select('id, article_brief_id, tenant_id, version_number, file_name, file_url, storage_path, file_size')
      .eq('id', versionId)
      .eq('article_brief_id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const { error: deleteError } = await supabase
      .from('article_brief_version')
      .delete()
      .eq('id', versionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (deleteError) {
      console.error('[BriefVersion Delete] Error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete version' });
    }

    const fallback = extractStoragePath(version.file_url);
    const storagePath = version.storage_path || fallback.path;
    const bucket = version.storage_path ? 'private-uploads' : fallback.bucket;
    if (storagePath) {
      try {
        await supabase.storage.from(bucket).remove([storagePath]);
        if (Number.isFinite(Number(version.file_size)) && Number(version.file_size) > 0) {
          addTenantStorageBytes(version.tenant_id, -Number(version.file_size)).catch(() => {});
        }
      } catch (storageErr) {
        console.warn('[BriefVersion Delete] Storage cleanup failed:', storageErr);
      }
    }

    await supabase
      .from('article_brief_activity')
      .insert({
        article_brief_id: briefId,
        action: 'version_deleted',
        description: `Version ${version.version_number} deleted${version.file_name ? ': ' + version.file_name : ''}`,
        performed_by: tenantCtx.memberId || null,
        metadata: {
          version_number: version.version_number,
          file_name: version.file_name || null,
        },
        tenant_id: tenantCtx.tenantId,
      });

    return res.json({ success: true });
  } catch (err) {
    console.error('[BriefVersion Delete] Error:', err);
    return res.status(500).json({ error: 'Failed to delete version' });
  }
}

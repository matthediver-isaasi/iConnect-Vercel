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
    return res.status(403).json({ error: 'You do not have permission to delete case study uploads' });
  }

  const { briefId, uploadId } = req.query;
  if (!briefId || !uploadId) {
    return res.status(400).json({ error: 'briefId and uploadId are required' });
  }

  try {
    const { data: upload, error: fetchError } = await supabase
      .from('article_brief_case_study_upload')
      .select('id, article_brief_id, tenant_id, version_number, source, file_name, storage_path, file_size')
      .eq('id', uploadId)
      .eq('article_brief_id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const { error: deleteError } = await supabase
      .from('article_brief_case_study_upload')
      .delete()
      .eq('id', uploadId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (deleteError) {
      console.error('[CaseStudyUploads Delete] Error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete upload' });
    }

    if (upload.storage_path) {
      try {
        await supabase.storage.from('private-uploads').remove([upload.storage_path]);
        if (Number.isFinite(Number(upload.file_size)) && Number(upload.file_size) > 0) {
          addTenantStorageBytes(upload.tenant_id, -Number(upload.file_size)).catch(() => {});
        }
      } catch (storageErr) {
        console.warn('[CaseStudyUploads Delete] Storage cleanup failed:', storageErr);
      }
    }

    await supabase
      .from('article_brief_activity')
      .insert({
        article_brief_id: briefId,
        action: 'case_study_upload_deleted',
        description: `Case study file v${upload.version_number} deleted${upload.file_name ? ': ' + upload.file_name : ''}`,
        performed_by: tenantCtx.memberId || null,
        metadata: {
          version_number: upload.version_number,
          source: upload.source,
          file_name: upload.file_name || null,
        },
        tenant_id: tenantCtx.tenantId,
      });

    return res.json({ success: true });
  } catch (err) {
    console.error('[CaseStudyUploads Delete] Error:', err);
    return res.status(500).json({ error: 'Failed to delete upload' });
  }
}

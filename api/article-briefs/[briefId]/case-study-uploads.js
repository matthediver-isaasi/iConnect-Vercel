import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';

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

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { briefId } = req.query;
  if (!briefId) {
    return res.status(400).json({ error: 'briefId is required' });
  }

  const { data: brief, error: briefError } = await supabase
    .from('article_brief')
    .select('id, tenant_id, assigned_writer_id')
    .eq('id', briefId)
    .eq('tenant_id', tenantCtx.tenantId)
    .single();

  if (briefError || !brief) {
    return res.status(404).json({ error: 'Article brief not found' });
  }

  if (req.method === 'GET') {
    return handleList(req, res, tenantCtx, briefId);
  }
  if (req.method === 'POST') {
    return handleCreate(req, res, tenantCtx, brief);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleList(req, res, tenantCtx, briefId) {
  try {
    const { data: uploads, error } = await supabase
      .from('article_brief_case_study_upload')
      .select('*, uploader:member!article_brief_case_study_upload_uploaded_by_member_fkey(id, first_name, last_name, email)')
      .eq('article_brief_id', briefId)
      .eq('tenant_id', tenantCtx.tenantId)
      .order('version_number', { ascending: false });

    if (error) {
      console.error('[CaseStudyUploads List] Error:', error);
      const { data: fallback, error: fallbackError } = await supabase
        .from('article_brief_case_study_upload')
        .select('*')
        .eq('article_brief_id', briefId)
        .eq('tenant_id', tenantCtx.tenantId)
        .order('version_number', { ascending: false });

      if (fallbackError) {
        return res.status(500).json({ error: 'Failed to fetch case study uploads' });
      }
      return res.json(fallback || []);
    }

    return res.json(uploads || []);
  } catch (err) {
    console.error('[CaseStudyUploads List] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch case study uploads' });
  }
}

async function handleCreate(req, res, tenantCtx, brief) {
  try {
    const briefId = brief.id;
    const memberId = tenantCtx.memberId || null;

    const excludedFeatures = await getRoleExcludedFeatures(tenantCtx);
    const canManage = !isResourceExcluded(excludedFeatures, 'content.briefs.manage');
    const isWriter = !!memberId && brief.assigned_writer_id === memberId;
    if (!canManage && !isWriter) {
      return res.status(403).json({ error: 'You do not have permission to upload case study files for this brief' });
    }

    const { file_url, storage_path, file_name, file_size, mime_type, note } = req.body || {};

    if (!file_url) {
      return res.status(400).json({ error: 'file_url is required' });
    }

    const { data: nextVersion, error: seqError } = await supabase
      .rpc('next_case_study_upload_version', { p_brief_id: briefId });

    if (seqError || nextVersion == null) {
      console.error('[CaseStudyUploads Create] Version allocation error:', seqError);
      return res.status(500).json({ error: 'Failed to allocate upload version' });
    }

    const { data: inserted, error: insertError } = await supabase
      .from('article_brief_case_study_upload')
      .insert({
        article_brief_id: briefId,
        version_number: nextVersion,
        source: 'staff',
        uploaded_by_member: memberId,
        uploaded_by_provider_name: null,
        file_url,
        storage_path: storage_path || null,
        file_name: file_name || null,
        file_size: typeof file_size === 'number' ? file_size : null,
        mime_type: mime_type || null,
        note: note ? String(note).slice(0, 2000) : null,
        tenant_id: tenantCtx.tenantId,
      })
      .select()
      .single();

    if (insertError || !inserted) {
      console.error('[CaseStudyUploads Create] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to record upload' });
    }

    await supabase
      .from('article_brief_activity')
      .insert({
        article_brief_id: briefId,
        action: 'case_study_upload_added',
        description: `Case study file v${inserted.version_number} uploaded by team${file_name ? ': ' + file_name : ''}`,
        performed_by: memberId,
        metadata: {
          version_number: inserted.version_number,
          source: 'staff',
          file_name: file_name || null,
        },
        tenant_id: tenantCtx.tenantId,
      });

    return res.json({ success: true, upload: inserted });
  } catch (err) {
    console.error('[CaseStudyUploads Create] Error:', err);
    return res.status(500).json({ error: 'Failed to record upload' });
  }
}

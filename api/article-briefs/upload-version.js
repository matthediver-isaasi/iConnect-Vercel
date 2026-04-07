import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { article_brief_id, file_url, file_name, submission_note } = req.body;

    if (!article_brief_id) {
      return res.status(400).json({ error: 'article_brief_id is required' });
    }
    if (!file_url) {
      return res.status(400).json({ error: 'file_url is required' });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, status, tenant_id')
      .eq('id', article_brief_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (briefError || !brief) {
      return res.status(404).json({ error: 'Article brief not found' });
    }

    const { data: existingVersions, error: versionCountError } = await supabase
      .from('article_brief_version')
      .select('version_number')
      .eq('article_brief_id', article_brief_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .order('version_number', { ascending: false })
      .limit(1);

    if (versionCountError) {
      console.error('[UploadVersion] Error fetching existing versions:', versionCountError);
      return res.status(500).json({ error: 'Failed to check existing versions' });
    }

    const nextVersionNumber = (existingVersions && existingVersions.length > 0)
      ? existingVersions[0].version_number + 1
      : 1;

    const uploaderId = tenantCtx.memberId || null;

    const { data: version, error: versionError } = await supabase
      .from('article_brief_version')
      .insert({
        article_brief_id,
        version_number: nextVersionNumber,
        uploaded_by: uploaderId,
        submission_note: submission_note || null,
        file_url,
        file_name: file_name || null,
        status_at_upload: brief.status,
        tenant_id: tenantCtx.tenantId
      })
      .select()
      .single();

    if (versionError) {
      console.error('[UploadVersion] Error creating version:', versionError);
      return res.status(500).json({ error: 'Failed to create version: ' + versionError.message });
    }

    const statusesToTransition = ['in_progress', 'assigned', 'changes_requested'];
    if (statusesToTransition.includes(brief.status)) {
      await supabase
        .from('article_brief')
        .update({ status: 'under_review', updated_at: new Date().toISOString() })
        .eq('id', article_brief_id)
        .eq('tenant_id', tenantCtx.tenantId);
    }

    await supabase
      .from('article_brief_activity')
      .insert({
        article_brief_id,
        action: 'version_uploaded',
        description: `Version ${nextVersionNumber} uploaded${file_name ? ': ' + file_name : ''}`,
        performed_by: uploaderId,
        metadata: {
          version_number: nextVersionNumber,
          file_name: file_name || null,
          previous_status: brief.status
        },
        tenant_id: tenantCtx.tenantId
      });

    return res.json({
      success: true,
      version,
      version_number: nextVersionNumber
    });

  } catch (error) {
    console.error('[UploadVersion] Error:', error);
    return res.status(500).json({ error: 'Failed to upload version: ' + (error.message || 'Unknown error') });
  }
}

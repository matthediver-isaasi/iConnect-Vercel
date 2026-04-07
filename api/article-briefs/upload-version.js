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

    let version = null;
    let versionNumber = nextVersionNumber;
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { data: insertedVersion, error: versionError } = await supabase
        .from('article_brief_version')
        .insert({
          article_brief_id,
          version_number: versionNumber,
          uploaded_by: uploaderId,
          submission_note: submission_note || null,
          file_url,
          file_name: file_name || null,
          status_at_upload: brief.status,
          tenant_id: tenantCtx.tenantId
        })
        .select()
        .single();

      if (!versionError) {
        version = insertedVersion;
        break;
      }

      if (versionError.code === '23505' && attempt < MAX_RETRIES - 1) {
        versionNumber++;
        continue;
      }

      console.error('[UploadVersion] Error creating version:', versionError);
      return res.status(500).json({ error: 'Failed to create version: ' + versionError.message });
    }

    const finalVersionNumber = versionNumber;

    const statusesToTransition = ['in_progress', 'assigned', 'changes_requested'];
    const didTransitionStatus = statusesToTransition.includes(brief.status);
    if (didTransitionStatus) {
      await supabase
        .from('article_brief')
        .update({ status: 'under_review', updated_at: new Date().toISOString() })
        .eq('id', article_brief_id)
        .eq('tenant_id', tenantCtx.tenantId);
    }

    const activityEntries = [
      {
        article_brief_id,
        action: 'version_uploaded',
        description: `Version ${finalVersionNumber} uploaded${file_name ? ': ' + file_name : ''}`,
        performed_by: uploaderId,
        metadata: {
          version_number: finalVersionNumber,
          file_name: file_name || null,
          previous_status: brief.status
        },
        tenant_id: tenantCtx.tenantId
      }
    ];

    if (didTransitionStatus) {
      activityEntries.push({
        article_brief_id,
        action: 'status_changed',
        description: `Status changed from ${brief.status} to under_review`,
        performed_by: uploaderId,
        metadata: { old_status: brief.status, new_status: 'under_review' },
        tenant_id: tenantCtx.tenantId
      });
    }

    await supabase
      .from('article_brief_activity')
      .insert(activityEntries);

    return res.json({
      success: true,
      version,
      version_number: finalVersionNumber
    });

  } catch (error) {
    console.error('[UploadVersion] Error:', error);
    return res.status(500).json({ error: 'Failed to upload version: ' + (error.message || 'Unknown error') });
  }
}

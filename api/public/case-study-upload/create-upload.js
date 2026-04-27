import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Service unavailable' });
  }

  try {
    const { token, storage_path, file_name, file_size, mime_type } = req.body || {};

    const cleanToken = (token || '').toString().trim();
    if (!cleanToken || cleanToken.length < 32 || cleanToken.length > 256) {
      return res.status(404).json({ error: 'This link is no longer valid' });
    }
    if (!storage_path || typeof storage_path !== 'string') {
      return res.status(400).json({ error: 'storage_path is required' });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, tenant_id, case_study_provider, case_study_upload_token')
      .eq('case_study_upload_token', cleanToken)
      .maybeSingle();

    if (briefError) {
      console.error('[CaseStudyUpload CreateUpload] Brief lookup error:', briefError);
      return res.status(500).json({ error: 'Failed to record upload' });
    }
    if (!brief || brief.case_study_upload_token !== cleanToken) {
      return res.status(404).json({ error: 'This link is no longer valid' });
    }

    // Verify the client did not tamper with storage_path. The signed-url
    // endpoint always issues paths under this prefix scoped to this brief.
    const expectedPrefix = `${brief.tenant_id}/article-briefs/${brief.id}/case-study-uploads/`;
    if (!storage_path.startsWith(expectedPrefix) || storage_path.includes('..')) {
      console.warn('[CaseStudyUpload CreateUpload] Rejected storage_path outside expected prefix:', storage_path);
      return res.status(400).json({ error: 'Invalid storage path' });
    }

    // Derive file_url server-side instead of trusting client input. This is
    // the same URL shape the signed-url endpoint returned.
    const PRIVATE_BUCKET = 'private-uploads';
    const file_url = `/api/storage/secure-url?bucket=${PRIVATE_BUCKET}&path=${encodeURIComponent(storage_path)}&redirect=true`;

    const provider = brief.case_study_provider || {};
    const providerName = [provider.first_name, provider.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Provider';

    const { data: nextVersion, error: seqError } = await supabase
      .rpc('next_case_study_upload_version', { p_brief_id: brief.id });

    if (seqError || nextVersion == null) {
      console.error('[CaseStudyUpload CreateUpload] Version allocation error:', seqError);
      return res.status(500).json({ error: 'Failed to allocate upload version' });
    }

    const { data: inserted, error: insertError } = await supabase
      .from('article_brief_case_study_upload')
      .insert({
        article_brief_id: brief.id,
        version_number: nextVersion,
        source: 'provider',
        uploaded_by_member: null,
        uploaded_by_provider_name: providerName,
        file_url,
        storage_path: storage_path || null,
        file_name: file_name || null,
        file_size: typeof file_size === 'number' ? file_size : null,
        mime_type: mime_type || null,
        tenant_id: brief.tenant_id,
      })
      .select()
      .single();

    if (insertError || !inserted) {
      console.error('[CaseStudyUpload CreateUpload] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to record upload' });
    }

    await supabase
      .from('article_brief_activity')
      .insert({
        article_brief_id: brief.id,
        action: 'case_study_upload_added',
        description: `Case study file v${inserted.version_number} uploaded by provider${file_name ? ': ' + file_name : ''}`,
        performed_by: null,
        metadata: {
          version_number: inserted.version_number,
          source: 'provider',
          provider_name: providerName,
          file_name: file_name || null,
        },
        tenant_id: brief.tenant_id,
      });

    return res.json({
      success: true,
      upload: inserted,
    });
  } catch (err) {
    console.error('[CaseStudyUpload CreateUpload] Error:', err);
    return res.status(500).json({ error: 'Failed to record upload' });
  }
}

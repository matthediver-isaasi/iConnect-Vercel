import { supabase } from '../../_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Service unavailable' });
  }

  const token = (req.query?.token || '').toString().trim();

  if (!token || token.length < 32 || token.length > 256) {
    return res.status(404).json({ error: 'This link is no longer valid' });
  }

  try {
    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, title, tenant_id, case_study_provider, case_study_upload_token')
      .eq('case_study_upload_token', token)
      .maybeSingle();

    if (briefError) {
      console.error('[CaseStudyUpload Context] Brief lookup error:', briefError);
      return res.status(500).json({ error: 'Failed to load context' });
    }

    if (!brief || brief.case_study_upload_token !== token) {
      return res.status(404).json({ error: 'This link is no longer valid' });
    }

    const { data: tenantRecord } = await supabase
      .from('tenant')
      .select('id, name, slug, logo_url, header_logo_url, primary_color')
      .eq('id', brief.tenant_id)
      .single();

    const { data: uploads, error: uploadsError } = await supabase
      .from('article_brief_case_study_upload')
      .select('id, version_number, source, uploaded_by_provider_name, upload_date, file_url, file_name, file_size, mime_type, note')
      .eq('article_brief_id', brief.id)
      .eq('tenant_id', brief.tenant_id)
      .eq('source', 'provider')
      .order('version_number', { ascending: false });

    if (uploadsError) {
      console.error('[CaseStudyUpload Context] Uploads fetch error:', uploadsError);
    }

    const provider = brief.case_study_provider || {};

    return res.json({
      brief: {
        id: brief.id,
        title: brief.title || '',
      },
      provider: {
        first_name: provider.first_name || '',
        last_name: provider.last_name || '',
      },
      tenant: {
        name: tenantRecord?.name || '',
        logoUrl: tenantRecord?.header_logo_url || tenantRecord?.logo_url || null,
        primaryColor: tenantRecord?.primary_color || '#5C0085',
      },
      uploads: uploads || [],
    });
  } catch (err) {
    console.error('[CaseStudyUpload Context] Error:', err);
    return res.status(500).json({ error: 'Failed to load context' });
  }
}

import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getSessionTenantUser(req, res);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { submissionId } = req.query;

    if (!submissionId) {
      return res.status(400).json({ error: 'Missing submissionId' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: submission, error: subError } = await supabase
      .from('form_submission')
      .select('pdf_path, tenant_id')
      .eq('id', submissionId)
      .single();

    if (subError || !submission) {
      console.error('[contracts/download-pdf] Submission fetch error:', subError);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // session returns tenant_id (underscore) not tenantId (camelCase)
    const sessionTenantId = session.tenant_id || session._sessionTenantId;
    
    if (submission.tenant_id !== sessionTenantId) {
      console.log('[contracts/download-pdf] Tenant mismatch:', {
        submissionTenantId: submission.tenant_id,
        sessionTenantId
      });
      return res.status(403).json({ error: 'Unauthorized - tenant mismatch' });
    }

    if (!submission.pdf_path) {
      return res.status(404).json({ error: 'PDF not found for this submission' });
    }

    const { data: signedUrl, error: signError } = await supabase.storage
      .from('private-uploads')
      .createSignedUrl(submission.pdf_path, 3600);

    if (signError) {
      console.error('[contracts/download-pdf] Error creating signed URL:', signError);
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    return res.status(200).json({
      success: true,
      downloadUrl: signedUrl.signedUrl,
      fileName: submission.pdf_path.split('/').pop()
    });

  } catch (error) {
    console.error('[contracts/download-pdf] Error:', error);
    return res.status(500).json({ error: 'Failed to get download URL', details: error.message });
  }
}

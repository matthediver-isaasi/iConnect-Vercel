import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

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

    let { data: submission, error: subError } = await supabase
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

    // Generate PDF on-demand if it doesn't exist
    if (!submission.pdf_path) {
      console.log('[contracts/download-pdf] PDF not found, generating on-demand for:', submissionId);
      
      if (!INTERNAL_API_SECRET) {
        console.error('[contracts/download-pdf] INTERNAL_API_SECRET not configured');
        return res.status(500).json({ error: 'Server configuration error - cannot generate PDF' });
      }
      
      // Get the base URL for internal API call
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const baseUrl = `${protocol}://${host}`;
      
      try {
        const generateResponse = await fetch(`${baseUrl}/api/contracts/generate-pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            submissionId,
            internalToken: INTERNAL_API_SECRET
          })
        });
        
        if (!generateResponse.ok) {
          const errorData = await generateResponse.json().catch(() => ({}));
          console.error('[contracts/download-pdf] PDF generation failed:', errorData);
          return res.status(500).json({ error: 'Failed to generate PDF', details: errorData.error });
        }
        
        const generateResult = await generateResponse.json();
        console.log('[contracts/download-pdf] PDF generated successfully:', generateResult);
        
        // Refresh submission data to get the new pdf_path
        const { data: refreshedSubmission } = await supabase
          .from('form_submission')
          .select('pdf_path, tenant_id')
          .eq('id', submissionId)
          .single();
        
        submission = refreshedSubmission;
        
        if (!submission?.pdf_path) {
          return res.status(500).json({ error: 'PDF generated but path not saved' });
        }
      } catch (genError) {
        console.error('[contracts/download-pdf] PDF generation error:', genError);
        return res.status(500).json({ error: 'Failed to generate PDF', details: genError.message });
      }
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

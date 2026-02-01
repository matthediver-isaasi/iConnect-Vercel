import { getSessionMember } from '../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const tenantId = sessionMember.tenant_id;
    if (!tenantId) {
      return res.status(403).json({ error: 'Tenant context required' });
    }

    const roleId = sessionMember.role_id;
    if (roleId) {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', roleId)
        .single();

      const excludedFeatures = role?.excluded_features || [];
      if (excludedFeatures.includes('page_FormSubmissions') || excludedFeatures.includes('page_FormManagement')) {
        return res.status(403).json({ error: 'Access denied - insufficient permissions' });
      }
    }

    const { form_id, form_name, submitted_by_name, submitted_by_email, submission_data } = req.body;

    if (!form_id) {
      return res.status(400).json({ error: 'Form ID is required' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, tenant_id')
      .eq('id', form_id)
      .eq('tenant_id', tenantId)
      .single();

    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found or not accessible' });
    }

    const submissionRecord = {
      form_id,
      form_name: form_name || form.name,
      submitted_by_name: submitted_by_name || null,
      submitted_by_email: submitted_by_email || null,
      submission_data: submission_data || {},
      created_date: new Date().toISOString(),
      tenant_id: tenantId,
    };

    const { data: submission, error: insertError } = await supabase
      .from('form_submission')
      .insert(submissionRecord)
      .select('id')
      .single();

    if (insertError) {
      console.error('[Manual Form Submission] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create submission' });
    }

    console.log('[Manual Form Submission] Created submission:', submission.id, 'for form:', form_id);

    return res.status(200).json({ 
      success: true, 
      submission_id: submission.id,
      message: 'Submission created successfully (no workflows triggered)'
    });

  } catch (error) {
    console.error('[Manual Form Submission] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

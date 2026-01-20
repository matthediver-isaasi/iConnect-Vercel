import { createClient } from '@supabase/supabase-js';

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

  const { form_id, form_name, answers, submission_data, source, tenant, prefill_organization_id } = req.body;

  if (!form_id) {
    return res.status(400).json({ error: 'Form ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Get tenant from query param or subdomain
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const subdomain = host.split('.')[0];
    const tenantIdentifier = tenant || subdomain;

    if (!tenantIdentifier || tenantIdentifier === 'www' || tenantIdentifier === 'iconn') {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    // Get tenant ID - try slug first, then subdomain
    let tenantResult = await supabase
      .from('tenant')
      .select('id')
      .eq('slug', tenantIdentifier)
      .eq('status', 'active')
      .single();
    
    // If not found by slug, try subdomain (for backwards compatibility)
    if (tenantResult.error || !tenantResult.data) {
      tenantResult = await supabase
        .from('tenant')
        .select('id')
        .eq('subdomain', tenantIdentifier)
        .single();
    }

    const { data: tenantData, error: tenantError } = tenantResult;

    if (tenantError || !tenantData) {
      console.error('[Public Form Submission] Tenant not found:', { tenantIdentifier, error: tenantError?.message });
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Verify the form exists and belongs to this tenant
    // Include fields, entity_pipelines, field_mappings for post-submission processing
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, require_authentication, fields, entity_pipelines, field_mappings, application_level')
      .eq('id', form_id)
      .eq('tenant_id', tenantData.id)
      .eq('is_active', true)
      .single();

    if (formError || !form) {
      console.error('[Public Form Submission] Form not found:', { 
        form_id, 
        tenant_id: tenantData.id, 
        error: formError?.message,
        code: formError?.code 
      });
      return res.status(404).json({ error: 'Form not found' });
    }

    // Forms that require authentication cannot be submitted publicly
    if (form.require_authentication) {
      return res.status(403).json({ error: 'This form requires authentication' });
    }

    // Create the form submission - match FormView structure exactly
    // SECURITY: Include tenant_id for proper multi-tenant isolation
    const submissionRecord = {
      form_id,
      form_name,
      submitted_by_email: null,
      submitted_by_name: null,
      submission_data: submission_data || {},
      created_date: new Date().toISOString(),
      tenant_id: tenantData.id
    };

    const { data: submission, error: insertError } = await supabase
      .from('form_submission')
      .insert(submissionRecord)
      .select()
      .single();

    if (insertError) {
      console.error('[Public Form Submission] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;

    // Process entity pipelines if configured (members/organisations creation)
    const hasEntityPipelines = (form.entity_pipelines?.members?.length > 0) || (form.entity_pipelines?.organisations?.length > 0);
    if (hasEntityPipelines) {
      try {
        console.log('[Public Form Submission] Processing entity pipelines for tenant:', tenantData.id);
        const pipelineResponse = await fetch(`${baseUrl}/api/forms/process-application`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            form_id: form.id,
            form_values: submission_data || {},
            fields: form.fields || [],
            field_mappings: form.field_mappings || [],
            application_level: form.application_level || 'member',
            submission_id: submission.id,
            prefill_organization_id: prefill_organization_id || null,
            role_id: null,
            entity_pipelines: form.entity_pipelines,  // Pass entity pipelines config
            tenant_id: tenantData.id  // Pass tenant_id for multi-tenant isolation
          })
        });
        
        // Safely parse response - handle empty bodies and non-JSON responses
        const contentType = pipelineResponse.headers.get('content-type') || '';
        const hasJsonBody = contentType.includes('application/json');
        
        if (!pipelineResponse.ok) {
          // Pipeline failed - rollback the form_submission record to prevent orphaned data
          console.log('[Public Form Submission] Rolling back submission due to pipeline failure:', submission.id);
          await supabase.from('form_submission').delete().eq('id', submission.id);
          
          if (hasJsonBody) {
            try {
              const errorData = await pipelineResponse.json();
              console.error('[Public Form Submission] Entity pipeline processing failed:', errorData);
              
              // Return uniqueness conflict errors with user-friendly message
              if (pipelineResponse.status === 409 && errorData.code === 'UNIQUENESS_CONFLICT') {
                const conflictMessages = (errorData.conflicts || [])
                  .map(c => c.message || `${c.field_label}: Duplicate value`)
                  .join('. ');
                return res.status(409).json({
                  error: conflictMessages || 'A record with this information already exists',
                  conflicts: errorData.conflicts || [],
                  code: 'UNIQUENESS_CONFLICT'
                });
              }
              
              // Return all other pipeline errors to the frontend (don't swallow them)
              return res.status(pipelineResponse.status).json({
                error: errorData.error || errorData.message || 'Failed to process application',
                code: errorData.code || 'PIPELINE_ERROR'
              });
            } catch (parseErr) {
              console.error('[Public Form Submission] Entity pipeline failed with status:', pipelineResponse.status);
              return res.status(pipelineResponse.status).json({
                error: 'Failed to process application',
                code: 'PIPELINE_ERROR'
              });
            }
          } else {
            console.error('[Public Form Submission] Entity pipeline failed with status:', pipelineResponse.status);
            return res.status(pipelineResponse.status).json({
              error: 'Failed to process application',
              code: 'PIPELINE_ERROR'
            });
          }
        } else {
          if (hasJsonBody) {
            try {
              const result = await pipelineResponse.json();
              console.log('[Public Form Submission] Entity pipeline processed:', result);
            } catch (parseErr) {
              console.log('[Public Form Submission] Entity pipeline completed (no JSON body)');
            }
          } else {
            console.log('[Public Form Submission] Entity pipeline completed successfully');
          }
        }
      } catch (err) {
        // Network/runtime error during pipeline processing - rollback and return error
        console.error('[Public Form Submission] Entity pipeline error:', err);
        console.log('[Public Form Submission] Rolling back submission due to pipeline error:', submission.id);
        try {
          await supabase.from('form_submission').delete().eq('id', submission.id);
        } catch (deleteErr) {
          console.error('[Public Form Submission] Failed to rollback submission:', deleteErr);
        }
        return res.status(502).json({
          error: 'Failed to process application. Please try again.',
          code: 'PIPELINE_NETWORK_ERROR'
        });
      }
    }

    return res.status(201).json({
      success: true,
      id: submission.id,
      message: 'Form submitted successfully'
    });
  } catch (error) {
    console.error('[Public Form Submission] Error:', error);
    return res.status(500).json({ error: 'Failed to process submission' });
  }
}

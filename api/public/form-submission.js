import { createClient } from '@supabase/supabase-js';
import { executeStageActions } from '../due-diligence/_stageActions.js';

export default async function handler(req, res) {
  console.log('[Public Form Submission] === ENDPOINT CALLED ===');
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { form_id, form_name, answers, submission_data, source, tenant, prefill_organization_id, contract_instance_id } = req.body;
  console.log('[Public Form Submission] form_id:', form_id, 'form_name:', form_name);

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
    // Include due_diligence_required for auto-creating DD records
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, require_authentication, fields, entity_pipelines, field_mappings, application_level, due_diligence_required')
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
      tenant_id: tenantData.id,
      ...(contract_instance_id && { contract_instance_id }),
      ...(prefill_organization_id && { organization_id: prefill_organization_id })
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

    console.log('[Public Form Submission] Submission created successfully:', submission.id);

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
              
              // If the pipeline resolved an organization (created or existing) and we don't already have an org ID,
              // update the submission record with the organization_id
              const resolvedOrgId = result.organization_id || result.created_organization_id;
              if (resolvedOrgId && !submissionRecord.organization_id) {
                console.log('[Public Form Submission] Updating submission with organization_id:', resolvedOrgId);
                const { error: updateError } = await supabase
                  .from('form_submission')
                  .update({ organization_id: resolvedOrgId })
                  .eq('id', submission.id);
                
                if (updateError) {
                  console.error('[Public Form Submission] Failed to update submission with organization_id:', updateError);
                } else {
                  console.log('[Public Form Submission] Submission updated with organization_id');
                }
              }
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

    // Generate PDF for contract signatures and add history log
    if (contract_instance_id) {
      const hasSignatureData = Object.values(submission_data || {}).some(v => 
        v && typeof v === 'object' && (v.type === 'signature' || (v.data && v.signed_at))
      );
      
      if (hasSignatureData) {
        try {
          console.log('[Public Form Submission] Generating PDF for contract signature:', submission.id);
          const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
          if (!INTERNAL_API_SECRET) {
            console.error('[Public Form Submission] INTERNAL_API_SECRET not configured, skipping PDF generation');
          } else {
            const pdfResponse = await fetch(`${baseUrl}/api/contracts/generate-pdf`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                submissionId: submission.id,
                internalToken: INTERNAL_API_SECRET
              })
            });
          
            if (pdfResponse.ok) {
              const pdfResult = await pdfResponse.json();
              console.log('[Public Form Submission] PDF generated:', pdfResult);
            } else {
              const pdfError = await pdfResponse.json().catch(() => ({}));
              console.error('[Public Form Submission] PDF generation failed:', pdfError);
            }
          }
          
          // Update contract_instance signer status and overall status
          try {
            // Try multiple sources for signer email
            let signerEmail = (submission_data?.signer_email || submission_data?.email || '').toLowerCase();
            
            // If no direct email field, try to extract from signature field metadata
            if (!signerEmail) {
              for (const [key, value] of Object.entries(submission_data || {})) {
                if (value && typeof value === 'object' && (value.type === 'signature' || value.signed_at)) {
                  if (value.signer_email) {
                    signerEmail = value.signer_email.toLowerCase();
                    break;
                  }
                }
              }
            }
            
            // SECURITY: Fetch contract instance with tenant_id filter to prevent cross-tenant access
            const { data: contractInstance, error: ciError } = await supabase
              .from('contract_instance')
              .select('id, form_submission_id, form_id, signers, status, tenant_id')
              .eq('id', contract_instance_id)
              .eq('tenant_id', tenantData.id)
              .single();
            
            if (ciError) {
              console.error('[Public Form Submission] Failed to fetch contract instance:', ciError);
            } else if (contractInstance) {
              const signers = contractInstance.signers || [];
              let signerFound = false;
              
              // Mark the signer who just signed as signed=true
              const updatedSigners = signers.map(signer => {
                if ((signer.email || '').toLowerCase() === signerEmail && !signer.signed) {
                  signerFound = true;
                  return {
                    ...signer,
                    signed: true,
                    signed_at: new Date().toISOString(),
                    signature_submission_id: submission.id
                  };
                }
                return signer;
              });
              
              // If we couldn't match by email but there's only one unsigned signer, mark them
              if (!signerFound && signers.length === 1 && !signers[0].signed) {
                signerFound = true;
                updatedSigners[0] = {
                  ...updatedSigners[0],
                  signed: true,
                  signed_at: new Date().toISOString(),
                  signature_submission_id: submission.id
                };
                console.log(`[Public Form Submission] Single signer contract - marking as signed`);
              }
              
              if (signerFound) {
                // Check if all signers have now signed
                const allSigned = updatedSigners.length > 0 && updatedSigners.every(s => s.signed === true);
                const signedCount = updatedSigners.filter(s => s.signed === true).length;
                
                // Determine new status: 'signed' when all complete, 'received' for partial progress
                let newStatus = contractInstance.status;
                if (allSigned) {
                  newStatus = 'signed';
                } else if (signedCount > 0) {
                  newStatus = 'received';
                }
                
                // SECURITY: Update with tenant_id filter to prevent cross-tenant mutation
                const { error: updateError } = await supabase
                  .from('contract_instance')
                  .update({
                    signers: updatedSigners,
                    status: newStatus,
                    updated_at: new Date().toISOString(),
                    ...(allSigned && { completed_at: new Date().toISOString() })
                  })
                  .eq('id', contract_instance_id)
                  .eq('tenant_id', tenantData.id);
                
                if (updateError) {
                  console.error('[Public Form Submission] Failed to update contract instance:', updateError);
                } else {
                  console.log(`[Public Form Submission] Updated contract instance ${contract_instance_id}: signer marked as signed (${signedCount}/${updatedSigners.length}), status: ${newStatus}`);
                }
              } else {
                console.log(`[Public Form Submission] Signer ${signerEmail || 'unknown'} not found in contract instance signers list or already signed`);
              }
            }
          } catch (contractUpdateError) {
            console.error('[Public Form Submission] Error updating contract instance:', contractUpdateError);
          }
          
          // Add history log entry to related DD submission for contract signature
          try {
            const { data: contractInstance } = await supabase
              .from('contract_instance')
              .select('id, form_submission_id, form_id')
              .eq('id', contract_instance_id)
              .single();
            
            if (contractInstance?.form_submission_id) {
              const { data: ddSubmission } = await supabase
                .from('form_submission_due_diligence')
                .select('id, history_log')
                .eq('form_submission_id', contractInstance.form_submission_id)
                .eq('tenant_id', tenantData.id)
                .single();
              
              if (ddSubmission) {
                const { data: contractForm } = await supabase
                  .from('form')
                  .select('name')
                  .eq('id', contractInstance.form_id)
                  .single();
                
                const signerEmail = submission_data?.signer_email || submission_data?.email || 'Unknown';
                
                const historyLog = ddSubmission.history_log || [];
                historyLog.push({
                  timestamp: new Date().toISOString(),
                  event_type: 'contract_signed',
                  user_email: signerEmail,
                  details: {
                    contract_name: contractForm?.name || 'Contract',
                    signer: signerEmail
                  }
                });
                
                await supabase
                  .from('form_submission_due_diligence')
                  .update({ history_log: historyLog })
                  .eq('id', ddSubmission.id);
                
                console.log('[Public Form Submission] Added contract_signed history log to DD submission');
              }
            }
          } catch (historyError) {
            console.error('[Public Form Submission] Failed to add history log:', historyError);
          }
        } catch (pdfErr) {
          console.error('[Public Form Submission] PDF generation error:', pdfErr);
        }
      }
    }

    // Auto-create due diligence record if form has due diligence enabled
    console.log('[Public Form Submission] Checking DD enabled:', form.due_diligence_required, 'form_id:', form.id);
    if (form.due_diligence_required) {
      try {
        console.log('[Public Form Submission] Creating due diligence record for submission:', submission.id);
        
        // Get the form's DD config for initial workflow status
        console.log('[Public Form Submission] Looking up DD config for form_id:', form_id, 'tenant_id:', tenantData.id);
        const { data: ddConfig, error: ddConfigError } = await supabase
          .from('form_due_diligence_config')
          .select('workflow_stages')
          .eq('form_id', form_id)
          .eq('tenant_id', tenantData.id)
          .single();
        
        if (ddConfigError) {
          console.log('[Public Form Submission] DD config lookup error:', ddConfigError.code, ddConfigError.message);
        }
        console.log('[Public Form Submission] DD config found:', !!ddConfig, 'workflow_stages count:', ddConfig?.workflow_stages?.length || 0);
        
        // Find initial stage
        const workflowStages = ddConfig?.workflow_stages || [];
        const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
        const initialStatus = initialStage?.id || 'new';
        console.log('[Public Form Submission] Initial stage:', initialStatus, 'is_initial flag:', initialStage?.is_initial, 'label:', initialStage?.label);
        
        // Create the DD submission record
        const ddRecord = {
          form_submission_id: submission.id,
          tenant_id: tenantData.id,
          application_uid: `DD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          original_form_values: submission_data || {},
          reviewed_form_values: submission_data || {},
          field_review_status: {},
          workflow_status: initialStatus,
          history_log: [{
            timestamp: new Date().toISOString(),
            event_type: 'submission_received',
            user_email: 'System',
            details: {
              form_submission_id: submission.id,
              initial_status: initialStatus
            }
          }]
        };

        const { data: newDDRecord, error: ddInsertError } = await supabase
          .from('form_submission_due_diligence')
          .insert(ddRecord)
          .select()
          .single();

        if (ddInsertError) {
          console.error('[Public Form Submission] Failed to create DD record:', ddInsertError);
          // Don't fail the submission, just log the error
        } else {
          console.log('[Public Form Submission] Due diligence record created:', newDDRecord.id);
          
          // Execute stage actions for the initial stage (e.g., send contracts, meeting requests, emails)
          // Always attempt to execute when there's an initial stage - the function handles its own config lookup
          // and checks for both inline actions (send_contracts) and database-stored actions (stage_email_action, etc.)
          if (initialStage) {
            const hasInlineActions = initialStage.actions || initialStage.stage_actions;
            const sendContractsFields = initialStage.stage_actions?.send_contracts || initialStage.actions?.send_contracts || [];
            console.log('[Public Form Submission] === STAGE ACTIONS DEBUG ===');
            console.log('[Public Form Submission] Form ID:', form.id);
            console.log('[Public Form Submission] Form Name:', form.name);
            console.log('[Public Form Submission] Initial stage ID:', initialStage.id);
            console.log('[Public Form Submission] Has inline actions:', !!hasInlineActions);
            console.log('[Public Form Submission] send_contracts fields:', JSON.stringify(sendContractsFields));
            console.log('[Public Form Submission] Full stage config:', JSON.stringify(initialStage));
            
            try {
              const ddSubmissionData = {
                ...newDDRecord,
                form_submission_id: submission.id,
                form_id: form.id
              };
              console.log('[Public Form Submission] Executing stage actions for initial stage:', initialStatus);
              const actionResults = await executeStageActions(
                initialStatus,
                ddSubmissionData,
                tenantData.id,
                'system_init'
              );
              
              if (actionResults?.stage_actions_results?.length > 0) {
                console.log('[Public Form Submission] Initial stage actions executed:', JSON.stringify(actionResults.stage_actions_results));
              } else {
                console.log('[Public Form Submission] No stage action results returned');
              }
            } catch (actionError) {
              console.error('[Public Form Submission] Error executing initial stage actions:', actionError);
              // Don't fail the submission for action errors
            }
          } else {
            console.log('[Public Form Submission] No initial stage found, skipping stage actions');
          }
        }
      } catch (ddError) {
        console.error('[Public Form Submission] Error creating DD record:', ddError);
        // Don't fail the submission for DD errors
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

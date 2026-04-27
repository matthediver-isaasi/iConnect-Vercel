import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest, getHostFromRequest } from '../_lib/tenantResolver.js';
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

  const { form_id, form_name, answers, submission_data, source, tenant, prefill_organization_id, contract_instance_id, role_id: clientRoleId, brief_id } = req.body;
  console.log('[Public Form Submission] form_id:', form_id, 'form_name:', form_name, 'brief_id:', brief_id || 'none');

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
    const tenantData = await resolveTenantFromRequest(req);
    // Use host from request, or derive from tenant domain if not available
    const host = getHostFromRequest(req) || (tenantData?.domain) || `${tenantData?.slug}.iconn.app`;

    if (!tenantData) {
      console.error('[Public Form Submission] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Verify the form exists and belongs to this tenant
    // Include fields, entity_pipelines, field_mappings for post-submission processing
    // Include due_diligence_required for auto-creating DD records
    // Include communication_category_id for newsletter subscription
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, tenant_id, require_authentication, fields, entity_pipelines, field_mappings, application_level, due_diligence_required, communication_category_id')
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

    // Link submission back to article_brief if brief_id context parameter is present.
    // The submitted form may be either the case-study Permission form
    // (case_study_form_id -> case_study_submission_id) or the brief-level
    // Copyright Assignment form (copyright_form_id -> copyright_submission_id).
    if (brief_id) {
      try {
        console.log('[Public Form Submission] Linking submission to article_brief:', brief_id);
        const { data: matchingBrief, error: briefLookupError } = await supabase
          .from('article_brief')
          .select('id, case_study_form_id, case_study_form_sent_at, case_study_submission_id, copyright_form_id, copyright_form_sent_at, copyright_submission_id')
          .eq('id', brief_id)
          .eq('tenant_id', tenantData.id)
          .maybeSingle();

        if (briefLookupError) {
          console.error('[Public Form Submission] Failed to look up brief for linking:', briefLookupError);
        } else if (!matchingBrief) {
          console.warn('[Public Form Submission] No matching brief found for linking (brief_id:', brief_id, ')');
        } else {
          // Slot matching is intentionally robust to in-flight form swaps: an
          // editor can change copyright_form_id (or case_study_form_id) on the
          // brief between hitting "Send" and the writer actually submitting,
          // which would otherwise orphan the submission against the *previous*
          // form. The simplest safe heuristic for each slot is to claim the
          // submission when ANY of:
          //   1. the slot's current form_id is null,
          //   2. the slot's current form_id equals the submitted form_id, OR
          //   3. the slot currently has no *_submission_id and *_form_sent_at
          //      is set (a send is outstanding for that slot, so this is the
          //      submission the editor was waiting on — even if they have
          //      since changed which form is selected).
          // Copyright is checked before case-study in the fallback because it
          // is the brief-level slot most likely to have been re-sent.
          const copyrightSlotClaim =
            matchingBrief.copyright_form_id === null ||
            matchingBrief.copyright_form_id === form_id ||
            (
              !matchingBrief.copyright_submission_id &&
              !!matchingBrief.copyright_form_sent_at
            );
          const caseStudySlotClaim =
            matchingBrief.case_study_form_id === null ||
            matchingBrief.case_study_form_id === form_id ||
            (
              !matchingBrief.case_study_submission_id &&
              !!matchingBrief.case_study_form_sent_at
            );

          // Direct form_id matches still take precedence (and case-study wins
          // a direct copyright match because the case-study slot is more
          // specific when the form_id is configured there).
          let updateField = null;
          if (matchingBrief.case_study_form_id === form_id) {
            updateField = 'case_study_submission_id';
          } else if (matchingBrief.copyright_form_id === form_id) {
            updateField = 'copyright_submission_id';
          } else if (copyrightSlotClaim) {
            updateField = 'copyright_submission_id';
          } else if (caseStudySlotClaim) {
            updateField = 'case_study_submission_id';
          }

          if (!updateField) {
            console.warn('[Public Form Submission] Submitted form does not match any brief form slot (brief_id:', brief_id, 'form_id:', form_id, ')');
          } else {
            const { error: briefUpdateError } = await supabase
              .from('article_brief')
              .update({ [updateField]: submission.id })
              .eq('id', brief_id)
              .eq('tenant_id', tenantData.id);

            if (briefUpdateError) {
              console.error('[Public Form Submission] Failed to link submission to brief:', briefUpdateError);
            } else {
              console.log('[Public Form Submission] Successfully linked submission to brief field', updateField, 'for brief:', brief_id);

              // Emit a Brief Management inbox item (permission/copyright). Files
              // attached to the submission ride along on metadata.files (not a
              // separate files_uploaded item) so one event = one inbox row.
              // Non-blocking: failures must not break the public submission.
              try {
                const eventType = updateField === 'copyright_submission_id'
                  ? 'copyright_submitted'
                  : 'permission_submitted';

                const fields = form.fields || [];
                let submitterEmailForInbox = null;
                let submitterFirstNameForInbox = null;
                let submitterLastNameForInbox = null;
                const uploadedFiles = [];

                for (const field of fields) {
                  const value = submission_data?.[field.id];
                  if (value === undefined || value === null || value === '') continue;

                  if (field.type === 'email' || field.id?.toLowerCase().includes('email')) {
                    if (!submitterEmailForInbox && typeof value === 'string') {
                      submitterEmailForInbox = value;
                    }
                  }
                  if (field.type === 'text') {
                    const idLower = (field.id || '').toLowerCase();
                    const labelLower = (field.label || '').toLowerCase();
                    if (idLower.includes('first_name') || labelLower.includes('first name')) {
                      if (!submitterFirstNameForInbox) submitterFirstNameForInbox = value;
                    }
                    if (idLower.includes('last_name') || labelLower.includes('last name')) {
                      if (!submitterLastNameForInbox) submitterLastNameForInbox = value;
                    }
                  }
                  if (field.type === 'file') {
                    try {
                      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                      // Form file fields can be a single {file_url, file_name}
                      // object or an array of them (multi-file uploads).
                      const entries = Array.isArray(parsed) ? parsed : [parsed];
                      for (const entry of entries) {
                        if (entry && entry.file_url) {
                          uploadedFiles.push({
                            file_name: entry.file_name || null,
                            file_url: entry.file_url,
                            field_label: field.label || null,
                          });
                        }
                      }
                    } catch (parseErr) {
                      // Non-JSON file value; ignore
                    }
                  }
                }

                const submitterName = [submitterFirstNameForInbox, submitterLastNameForInbox]
                  .filter(Boolean)
                  .join(' ')
                  .trim() || null;

                const inboxMetadata = {
                  submission_id: submission.id,
                  form_id,
                  form_title: form.name || null,
                  submitter_email: submitterEmailForInbox,
                  submitter_name: submitterName,
                  file_count: uploadedFiles.length,
                };
                if (uploadedFiles.length > 0) {
                  inboxMetadata.files = uploadedFiles.slice(0, 10);
                }

                const { error: inboxInsertError } = await supabase
                  .from('article_brief_inbox_item')
                  .insert({
                    tenant_id: tenantData.id,
                    article_brief_id: brief_id,
                    event_type: eventType,
                    metadata: inboxMetadata,
                  });

                if (inboxInsertError) {
                  if (inboxInsertError.code === '42P01' || /does not exist/i.test(inboxInsertError.message || '')) {
                    console.warn('[Public Form Submission] article_brief_inbox_item table missing; skipping inbox creation');
                  } else {
                    console.error('[Public Form Submission] Failed to create inbox item:', inboxInsertError);
                  }
                } else {
                  console.log('[Public Form Submission] Created inbox item for brief', brief_id, 'event:', eventType);
                }
              } catch (inboxError) {
                console.error('[Public Form Submission] Error creating inbox item:', inboxError);
              }
            }
          }
        }
      } catch (briefLinkError) {
        console.error('[Public Form Submission] Error linking submission to brief:', briefLinkError);
      }
    }

    // Handle newsletter/communication category subscription early (before slower pipeline/DD processing)
    if (form.communication_category_id) {
      const processSubscription = async (attempt = 1) => {
        try {
          console.log('[Public Form Submission] Processing newsletter subscription for category:', form.communication_category_id, '(attempt', attempt + ')');
          
          let submitterEmail = null;
          let submitterFirstName = null;
          let submitterLastName = null;
          
          const fields = form.fields || [];
          for (const field of fields) {
            const value = submission_data?.[field.id];
            if (!value) continue;
            
            if (field.type === 'email' || field.id?.toLowerCase().includes('email')) {
              submitterEmail = value;
            }
            if (field.type === 'text' && (field.id?.toLowerCase().includes('first_name') || field.label?.toLowerCase().includes('first name'))) {
              submitterFirstName = value;
            }
            if (field.type === 'text' && (field.id?.toLowerCase().includes('last_name') || field.label?.toLowerCase().includes('last name'))) {
              submitterLastName = value;
            }
          }
          
          if (submitterEmail) {
            console.log('[Public Form Submission] Found submitter email:', submitterEmail);
            
            const { data: member } = await supabase
              .from('member')
              .select('id, communications_opted_out_all')
              .eq('tenant_id', tenantData.id)
              .eq('email', submitterEmail.toLowerCase())
              .single();
            
            if (member) {
              console.log('[Public Form Submission] Submitter is a member:', member.id);
              
              if (member.communications_opted_out_all) {
                await supabase
                  .from('member')
                  .update({ communications_opted_out_all: false })
                  .eq('id', member.id);
                console.log('[Public Form Submission] Cleared member global opt-out');
              }
              
              const { error: prefError } = await supabase
                .from('member_communication_preference')
                .upsert({
                  member_id: member.id,
                  category_id: form.communication_category_id,
                  is_subscribed: true,
                  tenant_id: tenantData.id
                }, {
                  onConflict: 'member_id,category_id'
                });
              if (prefError) throw prefError;
              console.log('[Public Form Submission] Updated member communication preference');
              
            } else {
              console.log('[Public Form Submission] Submitter is not a member, creating/updating subscriber');
              
              const { error: subError } = await supabase
                .from('email_subscriber')
                .upsert({
                  tenant_id: tenantData.id,
                  email: submitterEmail.toLowerCase(),
                  first_name: submitterFirstName || null,
                  last_name: submitterLastName || null,
                  form_id: form.id,
                  communication_category_id: form.communication_category_id,
                  opted_out: false,
                  subscribed_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                }, {
                  onConflict: 'tenant_id,email,communication_category_id'
                });
              if (subError) throw subError;
              console.log('[Public Form Submission] Created/updated email subscriber record');
            }
          } else {
            console.log('[Public Form Submission] No email found in submission, skipping newsletter subscription');
          }
        } catch (subscriptionError) {
          console.error('[Public Form Submission] Newsletter subscription error (attempt ' + attempt + '):', subscriptionError.message || subscriptionError);
          if (attempt < 2) {
            console.log('[Public Form Submission] Retrying newsletter subscription...');
            await processSubscription(attempt + 1);
          } else {
            console.error('[Public Form Submission] Newsletter subscription FAILED after 2 attempts for submission:', submission.id, 'form:', form.id);
          }
        }
      };
      await processSubscription();
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;

    // Process entity pipelines if configured (members/organisations creation)
    let pipelineCreatedMemberId = null;
    let pipelineCreatedOrgId = null;
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
            role_id: clientRoleId || null,
            entity_pipelines: form.entity_pipelines,
            tenant_id: tenantData.id
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
              const resolvedMemberId = result.created_member_id || result.member_id;
              pipelineCreatedMemberId = resolvedMemberId || null;
              pipelineCreatedOrgId = resolvedOrgId || null;
              
              const submissionUpdates = {};
              if (resolvedOrgId && !submissionRecord.organization_id) {
                submissionUpdates.organization_id = resolvedOrgId;
              }
              if (resolvedMemberId) {
                submissionUpdates.created_member_id = resolvedMemberId;
              }
              
              if (Object.keys(submissionUpdates).length > 0) {
                console.log('[Public Form Submission] Updating submission with:', JSON.stringify(submissionUpdates));
                const { error: updateError } = await supabase
                  .from('form_submission')
                  .update(submissionUpdates)
                  .eq('id', submission.id);
                
                if (updateError) {
                  console.error('[Public Form Submission] Failed to update submission:', updateError);
                } else {
                  console.log('[Public Form Submission] Submission updated successfully');
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
      message: 'Form submitted successfully',
      created_member_id: pipelineCreatedMemberId || null,
      created_organization_id: pipelineCreatedOrgId || null
    });
  } catch (error) {
    console.error('[Public Form Submission] Error:', error);
    return res.status(500).json({ error: 'Failed to process submission' });
  }
}

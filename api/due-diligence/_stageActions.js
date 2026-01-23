import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';

function extractContactFromFieldValue(fieldValue) {
  if (!fieldValue) return null;
  
  let contactData = fieldValue;
  if (typeof fieldValue === 'string') {
    try {
      contactData = JSON.parse(fieldValue);
    } catch {
      return null;
    }
  }
  
  const email = contactData.email;
  if (!email) return null;
  
  return {
    first_name: contactData.first_name || contactData.firstName || '',
    last_name: contactData.last_name || contactData.lastName || '',
    email: email,
    signed: false,
    added_at: new Date().toISOString()
  };
}

export async function executeContractSendingActions(contactFieldIds, ddSubmission, tenantId, triggeredBy) {
  const results = [];
  
  if (!contactFieldIds || contactFieldIds.length === 0) {
    return results;
  }

  const formSubmissionId = ddSubmission.form_submission_id;
  if (!formSubmissionId) {
    console.log('[DD Stage Actions] No form submission ID, skipping contract sending');
    return results;
  }

  try {
    const formId = ddSubmission.form_submission?.form_id || ddSubmission.form_id;
    
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, form_values, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();
    
    if (subError || !formSubmission) {
      console.error('[DD Stage Actions] Could not find form submission:', subError);
      return results;
    }
    
    if (!formId) {
      ddSubmission.form_id = formSubmission.form_id;
    }

    const { data: sourceForm, error: formError } = await supabase
      .from('form')
      .select('id, fields')
      .eq('id', formSubmission.form_id || ddSubmission.form_id)
      .single();

    if (formError || !sourceForm) {
      console.error('[DD Stage Actions] Could not find source form:', formError);
      return results;
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = process.env.APP_URL || `https://${tenant?.slug || 'app'}.iconn.app`;

    const { data: contractInstances, error: instancesError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantId);

    if (instancesError) {
      console.error('[DD Stage Actions] Error fetching contract instances:', instancesError);
      return results;
    }

    for (const fieldId of contactFieldIds) {
      const field = (sourceForm.fields || []).find(f => f.id === fieldId || f.name === fieldId);
      
      if (!field || field.type !== 'contact' || !field.contract_form_id) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          status: 'skipped',
          reason: 'Field not found or not a contract contact field'
        });
        continue;
      }

      let contractInstance = contractInstances?.find(
        ci => ci.source_contact_field_id === fieldId && ci.form_id === field.contract_form_id
      );

      if (!contractInstance) {
        const candidateInstances = (contractInstances || []).filter(
          ci => ci.form_id === field.contract_form_id && !ci.sent_at && !ci.source_contact_field_id
        );
        if (candidateInstances.length === 1) {
          contractInstance = candidateInstances[0];
        } else if (candidateInstances.length > 1) {
          results.push({
            action: 'send_contract',
            field_id: fieldId,
            field_label: field.label || field.name,
            status: 'skipped',
            reason: 'Multiple matching contract instances found - unable to determine correct one'
          });
          continue;
        }
      }

      if (!contractInstance) {
        const formValues = formSubmission.form_values || {};
        const fieldKey = field.name || field.id;
        const fieldValue = formValues[fieldKey] || formValues[field.id];
        
        const signerData = extractContactFromFieldValue(fieldValue);
        
        if (!signerData) {
          results.push({
            action: 'send_contract',
            field_id: fieldId,
            field_label: field.label || field.name,
            status: 'skipped',
            reason: 'No contact data found in form submission for this field'
          });
          continue;
        }
        
        const { data: contractFormForSettings } = await supabase
          .from('form')
          .select('contract_settings')
          .eq('id', field.contract_form_id)
          .single();
        
        const timeoutDays = contractFormForSettings?.contract_settings?.timeout_days || 30;
        
        const { data: newInstance, error: createError } = await supabase
          .from('contract_instance')
          .insert({
            tenant_id: tenantId,
            form_id: field.contract_form_id,
            form_submission_id: formSubmissionId,
            organization_id: formSubmission.organization_id,
            source_contact_field_id: fieldId,
            signers: [signerData],
            status: 'draft',
            timeout_days: timeoutDays,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .select()
          .single();
        
        if (createError || !newInstance) {
          console.error('[DD Stage Actions] Failed to create contract instance:', createError);
          results.push({
            action: 'send_contract',
            field_id: fieldId,
            field_label: field.label || field.name,
            status: 'failed',
            reason: 'Failed to create contract instance'
          });
          continue;
        }
        
        console.log(`[DD Stage Actions] Created contract instance ${newInstance.id} for field ${fieldId}`);
        contractInstance = newInstance;
      }

      if (contractInstance.sent_at) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'skipped',
          reason: 'Contract already sent'
        });
        continue;
      }

      const { data: contractForm, error: contractFormError } = await supabase
        .from('form')
        .select('id, name, slug, contract_settings')
        .eq('id', field.contract_form_id)
        .single();

      if (contractFormError || !contractForm) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'failed',
          reason: 'Contract form not found'
        });
        continue;
      }

      const initialTemplateId = contractForm.contract_settings?.initial_email_template_id;
      
      if (!initialTemplateId) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'skipped',
          reason: 'No initial email template configured for contract form'
        });
        continue;
      }

      const { data: emailTemplate, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', initialTemplateId)
        .eq('tenant_id', tenantId)
        .single();

      if (templateError || !emailTemplate) {
        results.push({
          action: 'send_contract',
          field_id: fieldId,
          field_label: field.label || field.name,
          contract_instance_id: contractInstance.id,
          status: 'failed',
          reason: 'Email template not found'
        });
        continue;
      }

      const signers = contractInstance.signers || [];
      let sentCount = 0;
      let failedCount = 0;

      for (const signer of signers) {
        if (!signer.email) {
          failedCount++;
          continue;
        }

        const signingUrl = `${baseUrl}/form/${contractForm.slug}?contract_instance=${contractInstance.id}&signer=${encodeURIComponent(signer.email)}`;

        let subject = emailTemplate.subject || 'Contract for Signing';
        let body = emailTemplate.body || '';

        subject = subject
          .replace(/\{\{signer_name\}\}/gi, signer.name || '')
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        body = body
          .replace(/\{\{signer_name\}\}/gi, signer.name || '')
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        try {
          await sendEmail({
            to: signer.email,
            subject,
            html: body,
            from: emailTemplate.from_email,
            replyTo: emailTemplate.reply_to,
            tenantId
          });
          sentCount++;
          console.log(`[DD Stage Actions] Sent contract to ${signer.email}`);
        } catch (emailError) {
          failedCount++;
          console.error(`[DD Stage Actions] Failed to send to ${signer.email}:`, emailError);
        }
      }

      if (sentCount > 0) {
        await supabase
          .from('contract_instance')
          .update({
            sent_at: new Date().toISOString(),
            status: 'out_for_signing',
            updated_at: new Date().toISOString()
          })
          .eq('id', contractInstance.id)
          .eq('tenant_id', tenantId);
      }

      results.push({
        action: 'send_contract',
        field_id: fieldId,
        field_label: field.label || field.name,
        contract_instance_id: contractInstance.id,
        status: sentCount > 0 ? 'success' : 'failed',
        sent_count: sentCount,
        failed_count: failedCount
      });
    }
  } catch (error) {
    console.error('[DD Stage Actions] Error executing contract sending:', error);
    results.push({
      action: 'send_contract',
      status: 'error',
      error: error.message
    });
  }

  return results;
}

export async function executeStageActions(stageId, ddSubmission, tenantId, triggeredBy) {
  const formId = ddSubmission.form_submission?.form_id || ddSubmission.form_id;
  
  if (!formId) {
    const { data: formSub } = await supabase
      .from('form_submission')
      .select('form_id')
      .eq('id', ddSubmission.form_submission_id)
      .single();
    
    if (formSub) {
      ddSubmission.form_id = formSub.form_id;
    }
  }

  const { data: ddConfig } = await supabase
    .from('form_due_diligence_config')
    .select('workflow_stages')
    .eq('form_id', ddSubmission.form_submission?.form_id || ddSubmission.form_id)
    .eq('tenant_id', tenantId)
    .single();

  if (!ddConfig) {
    return { stage_actions_results: [] };
  }

  const workflowStages = ddConfig.workflow_stages || [];
  const stage = workflowStages.find(s => s.id === stageId);
  
  // Support both "actions" and "stage_actions" keys for compatibility
  const stageActions = stage.actions || stage.stage_actions;
  if (!stage || !stageActions) {
    return { stage_actions_results: [] };
  }

  const results = [];

  if (stageActions.send_contracts && stageActions.send_contracts.length > 0) {
    const contractResults = await executeContractSendingActions(
      stageActions.send_contracts,
      ddSubmission,
      tenantId,
      triggeredBy
    );
    results.push(...contractResults);
  }

  return { stage_actions_results: results };
}

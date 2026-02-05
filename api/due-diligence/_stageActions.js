import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';
import { 
  isZohoCrmConnected,
  lookupCountryInZoho,
  createZohoOrganization,
  updateZohoOrganization 
} from '../_lib/zohoCrmClient.js';

// Helper to escape regex special characters
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace [[placeholder]] style placeholders with actual values
function replaceDoubleBracketPlaceholders(text, placeholders) {
  if (!text) return text;
  let result = text;
  for (const [key, value] of Object.entries(placeholders)) {
    const placeholder = `[[${key}]]`;
    result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value || '');
  }
  return result;
}

// Fetch organization name from organization_id
async function getOrganizationName(organizationId) {
  if (!organizationId) return '';
  
  const { data: org } = await supabase
    .from('organization')
    .select('id, name')
    .eq('id', organizationId)
    .single();
  
  return org?.name || '';
}

async function addHistoryLogEntry(ddSubmissionId, tenantId, eventType, userEmail, details) {
  try {
    const { data: submission } = await supabase
      .from('form_submission_due_diligence')
      .select('history_log')
      .eq('id', ddSubmissionId)
      .eq('tenant_id', tenantId)
      .single();

    const historyLog = submission?.history_log || [];
    historyLog.push({
      timestamp: new Date().toISOString(),
      event_type: eventType,
      user_email: userEmail,
      details
    });

    await supabase
      .from('form_submission_due_diligence')
      .update({ history_log: historyLog })
      .eq('id', ddSubmissionId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[DD History] Failed to add log entry:', err);
  }
}

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
  console.log('[DD Contract Send] === CONTRACT SENDING ACTIONS START ===');
  console.log('[DD Contract Send] Contact field IDs to process:', JSON.stringify(contactFieldIds));
  console.log('[DD Contract Send] DD submission ID:', ddSubmission?.id);
  console.log('[DD Contract Send] Form submission ID:', ddSubmission?.form_submission_id);
  console.log('[DD Contract Send] Tenant ID:', tenantId);
  console.log('[DD Contract Send] Triggered by:', triggeredBy);
  
  const results = [];
  
  if (!contactFieldIds || contactFieldIds.length === 0) {
    console.log('[DD Contract Send] No contact field IDs provided, returning empty results');
    return results;
  }

  const formSubmissionId = ddSubmission.form_submission_id;
  if (!formSubmissionId) {
    console.log('[DD Contract Send] No form submission ID, skipping contract sending');
    return results;
  }

  try {
    const formId = ddSubmission.form_submission?.form_id || ddSubmission.form_id;
    console.log('[DD Contract Send] Initial form ID from ddSubmission:', formId);
    
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, submission_data, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();
    
    if (subError || !formSubmission) {
      console.error('[DD Contract Send] Could not find form submission:', subError);
      return results;
    }
    
    console.log('[DD Contract Send] Form submission found, form_id:', formSubmission.form_id, 'org_id:', formSubmission.organization_id);
    console.log('[DD Contract Send] Submission has data keys:', Object.keys(formSubmission.submission_data || {}).length);
    
    if (!formId) {
      ddSubmission.form_id = formSubmission.form_id;
    }

    const { data: sourceForm, error: formError } = await supabase
      .from('form')
      .select('id, fields, name')
      .eq('id', formSubmission.form_id || ddSubmission.form_id)
      .single();

    if (formError || !sourceForm) {
      console.error('[DD Contract Send] Could not find source form:', formError);
      return results;
    }
    
    console.log('[DD Contract Send] Source form found:', sourceForm.name, 'with', (sourceForm.fields || []).length, 'fields');

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = `https://${tenant?.slug || 'app'}.iconn.app`;

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
      console.log('[DD Contract Send] --- Processing field:', fieldId);
      const field = (sourceForm.fields || []).find(f => f.id === fieldId || f.name === fieldId);
      
      console.log('[DD Contract Send] Field lookup result:', field ? `Found: ${field.label} (type: ${field.type}, contract_form_id: ${field.contract_form_id})` : 'NOT FOUND');
      
      if (!field || field.type !== 'contact' || !field.contract_form_id) {
        console.log('[DD Contract Send] Field skipped - field exists:', !!field, 'type:', field?.type, 'contract_form_id:', field?.contract_form_id);
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
      
      console.log('[DD Contract Send] Existing contract instance for this field:', contractInstance?.id || 'None');

      if (!contractInstance) {
        const candidateInstances = (contractInstances || []).filter(
          ci => ci.form_id === field.contract_form_id && !ci.sent_at && !ci.source_contact_field_id
        );
        console.log('[DD Contract Send] Candidate unsent instances:', candidateInstances.length);
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
        console.log('[DD Contract Send] No existing contract instance, creating new one');
        const formValues = formSubmission.submission_data || {};
        const fieldKey = field.name || field.id;
        const fieldValue = formValues[fieldKey] || formValues[field.id];
        
        console.log('[DD Contract Send] Looking for signer data in field key:', fieldKey, 'or', field.id);
        console.log('[DD Contract Send] Field value found:', JSON.stringify(fieldValue));
        
        const signerData = extractContactFromFieldValue(fieldValue);
        console.log('[DD Contract Send] Extracted signer data:', JSON.stringify(signerData));
        
        if (!signerData) {
          console.log('[DD Contract Send] No signer data extracted, skipping');
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
        
        console.log(`[DD Contract Send] Created contract instance ${newInstance.id} for field ${fieldId}, signer email: ${signerData?.email}`);
        contractInstance = newInstance;
      }

      console.log('[DD Contract Send] Contract instance to process:', contractInstance.id, 'status:', contractInstance.status, 'sent_at:', contractInstance.sent_at);
      
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
      console.log('[DD Contract Send] Contract form:', contractForm.name, 'initial_email_template_id:', initialTemplateId);
      
      if (!initialTemplateId) {
        console.log('[DD Contract Send] No initial email template configured, skipping');
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
        console.log('[DD Contract Send] Email template not found:', initialTemplateId, 'error:', templateError?.message);
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
      
      console.log('[DD Contract Send] Email template found:', emailTemplate.name);

      const signers = contractInstance.signers || [];
      console.log('[DD Contract Send] Signers to process:', signers.length, 'emails:', signers.map(s => s.email).join(', '));
      let sentCount = 0;
      let failedCount = 0;
      const sentSignerEmails = [];

      // Fetch organization name for [[organization.name]] placeholder
      const organizationName = await getOrganizationName(formSubmission.organization_id);
      
      // Fetch tenant name for [[tenant.name]] placeholder
      const { data: tenantData } = await supabase
        .from('tenant')
        .select('name')
        .eq('id', tenantId)
        .single();
      const tenantName = tenantData?.name || '';

      for (const signer of signers) {
        if (!signer.email) {
          failedCount++;
          continue;
        }

        const signingUrl = `${baseUrl}/FormView?slug=${contractForm.slug}&contract_instance=${contractInstance.id}&signer_email=${encodeURIComponent(signer.email)}`;

        let subject = emailTemplate.subject || 'Contract for Signing';
        let body = emailTemplate.body || '';

        const signerFirstName = signer.first_name || signer.name?.split(' ')[0] || '';
        const signerLastName = signer.last_name || signer.name?.split(' ').slice(1).join(' ') || '';
        const signerFullName = signer.name || [signerFirstName, signerLastName].filter(Boolean).join(' ') || '';

        // Replace {{...}} style placeholders
        subject = subject
          .replace(/\{\{signer_name\}\}/gi, signerFullName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{sign_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{sign_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        body = body
          .replace(/\{\{signer_name\}\}/gi, signerFullName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{sign_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{sign_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        // Replace [[...]] style placeholders (e.g., [[organization.name]], [[tenant.name]])
        const doubleBracketPlaceholders = {
          'organization.name': organizationName,
          'tenant.name': tenantName,
          'signer.name': signerFullName,
          'signer.first_name': signerFirstName,
          'signer.last_name': signerLastName,
          'signer.email': signer.email || '',
          'contract.name': contractForm.name || ''
        };
        subject = replaceDoubleBracketPlaceholders(subject, doubleBracketPlaceholders);
        body = replaceDoubleBracketPlaceholders(body, doubleBracketPlaceholders);

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
          sentSignerEmails.push(signer.email.toLowerCase());
          console.log(`[DD Stage Actions] Sent contract to ${signer.email}`);
        } catch (emailError) {
          failedCount++;
          console.error(`[DD Stage Actions] Failed to send to ${signer.email}:`, emailError);
        }
      }

      if (sentCount > 0) {
        const now = new Date().toISOString();
        const updatedSigners = signers.map(s => {
          if (sentSignerEmails.includes((s.email || '').toLowerCase())) {
            return {
              ...s,
              sent_at: s.sent_at || now,
              last_resent_at: now
            };
          }
          return s;
        });

        await supabase
          .from('contract_instance')
          .update({
            signers: updatedSigners,
            sent_at: new Date().toISOString(),
            status: 'out_for_signing',
            updated_at: new Date().toISOString()
          })
          .eq('id', contractInstance.id)
          .eq('tenant_id', tenantId);
      }

      const resultEntry = {
        action: 'send_contract',
        field_id: fieldId,
        field_label: field.label || field.name,
        contract_instance_id: contractInstance.id,
        status: sentCount > 0 ? 'success' : 'failed',
        sent_count: sentCount,
        failed_count: failedCount
      };
      results.push(resultEntry);

      if (sentCount > 0) {
        await addHistoryLogEntry(ddSubmission.id, tenantId, 'contract_sent', triggeredBy, {
          contract_name: contractForm?.name,
          signers: sentSignerEmails,
          sent_count: sentCount
        });
      }
    }
  } catch (error) {
    console.error('[DD Contract Send] ERROR executing contract sending:', error);
    console.error('[DD Contract Send] Error stack:', error.stack);
    results.push({
      action: 'send_contract',
      status: 'error',
      error: error.message
    });
  }

  console.log('[DD Contract Send] === CONTRACT SENDING ACTIONS END ===');
  console.log('[DD Contract Send] Total results:', results.length);
  console.log('[DD Contract Send] Results summary:', JSON.stringify(results));
  return results;
}

export async function executeMeetingRequestActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  const { selectedAgentId } = options;
  const results = [];
  
  console.log('[DD Meeting Request] ========== START executeMeetingRequestActions ==========');
  console.log('[DD Meeting Request] Params:', { stageId, tenantId, triggeredBy, selectedAgentId });
  console.log('[DD Meeting Request] ddSubmission ID:', ddSubmission?.id);
  console.log('[DD Meeting Request] form_submission_id:', ddSubmission?.form_submission_id);
  
  try {
    // Fetch meeting request configs for this stage
    console.log('[DD Meeting Request] Querying stage_meeting_request for stageId:', stageId, 'tenantId:', tenantId);
    const { data: meetingRequests, error: mrError } = await supabase
      .from('stage_meeting_request')
      .select(`
        *,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes, meeting_type, email_template_id
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (mrError) {
      console.log('[DD Meeting Request] Query error:', mrError);
      return results;
    }
    if (!meetingRequests || meetingRequests.length === 0) {
      console.log('[DD Meeting Request] No meeting request configs found for this stage. Returning empty results.');
      return results;
    }
    console.log('[DD Meeting Request] Found', meetingRequests.length, 'meeting request config(s):', meetingRequests.map(m => ({ id: m.id, template_id: m.meeting_template_id, template_name: m.meeting_template?.name })));

    const formSubmissionId = ddSubmission.form_submission_id;
    if (!formSubmissionId) {
      console.log('[DD Stage Actions] No form submission ID, skipping meeting requests');
      return results;
    }

    // Get form submission data
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, submission_data, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();

    if (subError || !formSubmission) {
      console.error('[DD Stage Actions] Could not find form submission:', subError);
      return results;
    }

    // Get tenant info for base URL
    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const baseUrl = `https://${tenant?.slug || 'app'}.iconn.app`;

    for (const mr of meetingRequests) {
      const template = mr.meeting_template;
      if (!template) {
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          status: 'skipped',
          reason: 'Meeting template not found'
        });
        continue;
      }

      // Get recipient email from form values
      const formValues = formSubmission.submission_data || {};
      const recipientEmail = formValues[mr.recipient_email_field];
      const firstName = mr.first_name_field ? formValues[mr.first_name_field] : null;

      if (!recipientEmail) {
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: `No email found in field: ${mr.recipient_email_field}`
        });
        continue;
      }

      // Get email template if configured
      if (!template.email_template_id) {
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: 'No email template configured for meeting type'
        });
        continue;
      }

      const { data: emailTemplate, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', template.email_template_id)
        .eq('tenant_id', tenantId)
        .single();

      if (templateError || !emailTemplate) {
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: 'Email template not found'
        });
        continue;
      }

      // Find a booking agent assigned to this template
      const { data: agentAssignments } = await supabase
        .from('agent_meeting_template')
        .select('identity_id')
        .eq('meeting_template_id', template.id)
        .eq('tenant_id', tenantId);

      if (!agentAssignments || agentAssignments.length === 0) {
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: 'No booking agents assigned to this meeting type'
        });
        continue;
      }

      // Use selected agent if provided and valid, otherwise use first available
      let agentId = agentAssignments[0].identity_id;
      console.log('[DD Meeting Request] Agent assignments:', agentAssignments.map(a => a.identity_id));
      console.log('[DD Meeting Request] selectedAgentId from options:', selectedAgentId);
      if (selectedAgentId) {
        const selectedAssignment = agentAssignments.find(a => a.identity_id === selectedAgentId);
        if (selectedAssignment) {
          agentId = selectedAgentId;
          console.log('[DD Meeting Request] Using selected agent:', agentId);
        } else {
          console.log('[DD Meeting Request] Selected agent not in assignments, using first:', agentId);
        }
      } else {
        console.log('[DD Meeting Request] No agent selected, using first:', agentId);
      }
      // Get member_id from tenant_membership, then look up member data
      const { data: agentMembership } = await supabase
        .from('tenant_membership')
        .select('identity_id, member_id')
        .eq('identity_id', agentId)
        .eq('tenant_id', tenantId)
        .single();

      if (!agentMembership?.member_id) {
        console.log('[DD Meeting Request] SKIPPING - Agent has no member_id');
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: 'Booking agent is not linked to a member'
        });
        continue;
      }

      // Look up member data (name, handle)
      const { data: agentMember } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, handle')
        .eq('id', agentMembership.member_id)
        .single();

      console.log('[DD Meeting Request] Agent member lookup result:', { 
        agentId, 
        member_id: agentMembership.member_id,
        found: !!agentMember, 
        handle: agentMember?.handle,
        name: agentMember ? `${agentMember.first_name} ${agentMember.last_name}` : null
      });
      
      if (!agentMember?.handle) {
        console.log('[DD Meeting Request] SKIPPING - Agent member has no handle');
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          status: 'skipped',
          reason: 'Booking agent has no handle configured'
        });
        continue;
      }

      // Build base booking URL using member handle
      const baseBookingUrl = `${baseUrl}/book/${encodeURIComponent(agentMember.handle)}?meeting=${encodeURIComponent(template.slug)}`;
      const agentName = [agentMember.first_name, agentMember.last_name].filter(Boolean).join(' ') || 'Team Member';
      
      // Keep agentIdentity-like object for backward compatibility with history logging
      const agentIdentity = {
        first_name: agentMember.first_name,
        last_name: agentMember.last_name,
        email: agentMember.email
      };
      const normalizedEmail = recipientEmail.toLowerCase();

      // Create tracking record FIRST to get the ID for the booking URL
      const { data: trackingRecord, error: trackingError } = await supabase
        .from('dd_meeting_request')
        .insert({
          tenant_id: tenantId,
          form_submission_id: formSubmissionId,
          stage_meeting_request_id: mr.id,
          meeting_template_id: template.id,
          agent_identity_id: agentId,
          recipient_email: normalizedEmail,
          recipient_first_name: firstName || null,
          recipient_last_name: null,
          status: 'pending',
          sent_at: null, // Will update after sending
          booking_url: baseBookingUrl,
          is_original: true
        })
        .select()
        .single();
      
      if (trackingError) {
        console.error('[DD Stage Actions] Failed to create meeting request tracking record:', trackingError);
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          recipient_email: recipientEmail,
          status: 'error',
          error: 'Failed to create tracking record'
        });
        continue;
      }

      // Build final booking URL with tracking ID
      const bookingUrl = `${baseBookingUrl}&dd_request=${trackingRecord.id}`;
      
      // Update the tracking record with the final booking URL
      await supabase
        .from('dd_meeting_request')
        .update({ booking_url: bookingUrl })
        .eq('id', trackingRecord.id);

      // Prepare email content
      let subject = emailTemplate.subject || 'Meeting Invitation';
      let body = emailTemplate.body || '';

      // Replace placeholders (use 'there' as fallback for empty names in greetings)
      const recipientName = firstName || 'there';
      subject = subject
        .replace(/\{\{recipient_name\}\}/gi, recipientName)
        .replace(/\{\{recipient_email\}\}/gi, normalizedEmail)
        .replace(/\{\{meeting_type\}\}/gi, template.name)
        .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
        .replace(/\{\{agent_name\}\}/gi, agentName)
        .replace(/\{\{booking_url\}\}/gi, bookingUrl)
        .replace(/\{\{booking_link\}\}/gi, `<a href="${bookingUrl}">Book a meeting</a>`);

      body = body
        .replace(/\{\{recipient_name\}\}/gi, recipientName)
        .replace(/\{\{recipient_email\}\}/gi, normalizedEmail)
        .replace(/\{\{meeting_type\}\}/gi, template.name)
        .replace(/\{\{duration\}\}/gi, `${template.duration_minutes} minutes`)
        .replace(/\{\{agent_name\}\}/gi, agentName)
        .replace(/\{\{booking_url\}\}/gi, bookingUrl)
        .replace(/\{\{booking_link\}\}/gi, `<a href="${bookingUrl}">Book a meeting</a>`);

      try {
        console.log('[DD Meeting Request] About to send email:', {
          to: normalizedEmail,
          subject,
          from: emailTemplate.from_email,
          bookingUrl
        });
        await sendEmail({
          to: normalizedEmail,
          subject,
          html: body,
          from: emailTemplate.from_email,
          replyTo: emailTemplate.reply_to,
          tenantId
        });
        console.log('[DD Meeting Request] Email sent successfully!');

        // Update tracking record with sent_at timestamp
        await supabase
          .from('dd_meeting_request')
          .update({ sent_at: new Date().toISOString() })
          .eq('id', trackingRecord.id);

        console.log(`[DD Stage Actions] Sent meeting invitation to ${recipientEmail} for ${template.name}`);
        console.log(`[DD Stage Actions] Created tracking record ${trackingRecord.id} for meeting request`);
        
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          tracking_id: trackingRecord?.id,
          template_name: template.name,
          recipient_email: recipientEmail,
          status: 'success'
        });

        await addHistoryLogEntry(ddSubmission.id, tenantId, 'meeting_request_sent', triggeredBy, {
          template_name: template.name,
          recipient: recipientEmail,
          agent_name: agentIdentity?.first_name ? `${agentIdentity.first_name} ${agentIdentity.last_name || ''}`.trim() : agentIdentity?.email
        });
      } catch (emailError) {
        console.error(`[DD Stage Actions] Failed to send meeting invitation to ${recipientEmail}:`, emailError);
        results.push({
          action: 'send_meeting_request',
          meeting_request_id: mr.id,
          template_name: template.name,
          recipient_email: recipientEmail,
          status: 'error',
          error: emailError.message
        });
      }
    }
  } catch (error) {
    console.error('[DD Stage Actions] Error executing meeting request actions:', error);
    results.push({
      action: 'send_meeting_request',
      status: 'error',
      error: error.message
    });
  }

  return results;
}

export async function executeEmailTemplateActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  const { customMessage } = options;
  const results = [];
  
  console.log('[DD Email Action] ========== START executeEmailTemplateActions ==========');
  console.log('[DD Email Action] customMessage from options:', customMessage);
  console.log('[DD Email Action] Params:', { stageId, tenantId, triggeredBy });
  console.log('[DD Email Action] ddSubmission ID:', ddSubmission?.id);
  console.log('[DD Email Action] form_submission_id:', ddSubmission?.form_submission_id);
  
  try {
    const formSubmissionId = ddSubmission.form_submission_id;
    if (!formSubmissionId) {
      console.log('[DD Email Action] No form submission ID, skipping email actions');
      return results;
    }

    // Get form submission data first to determine form_id
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, submission_data, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();

    if (subError || !formSubmission) {
      console.error('[DD Email Action] Could not find form submission:', subError);
      return results;
    }

    const formId = formSubmission.form_id;
    console.log('[DD Email Action] Querying stage_email_action for stageId:', stageId, 'tenantId:', tenantId, 'formId:', formId);
    
    // Fetch email action configs for this stage AND form
    // First try to find form-specific actions, then fall back to global actions (form_id is null)
    let { data: emailActions, error: eaError } = await supabase
      .from('stage_email_action')
      .select(`
        *,
        email_template:email_template_id (
          id, name, subject, body, from_email, reply_to
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (eaError) {
      console.log('[DD Email Action] Query error:', eaError);
      return results;
    }
    
    // If no form-specific actions found, check for global actions (form_id is null)
    if (!emailActions || emailActions.length === 0) {
      console.log('[DD Email Action] No form-specific email actions found, checking for global actions (form_id is null)');
      const { data: globalActions, error: globalError } = await supabase
        .from('stage_email_action')
        .select(`
          *,
          email_template:email_template_id (
            id, name, subject, body, from_email, reply_to
          )
        `)
        .eq('due_diligence_stage_id', stageId)
        .eq('tenant_id', tenantId)
        .is('form_id', null)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      
      if (!globalError && globalActions && globalActions.length > 0) {
        console.log('[DD Email Action] Found', globalActions.length, 'global email action config(s) - WARNING: These may have incorrect field mappings for this form');
        emailActions = globalActions;
      }
    }
    
    if (!emailActions || emailActions.length === 0) {
      console.log('[DD Email Action] No email action configs found for this stage/form. Returning empty results.');
      return results;
    }
    console.log('[DD Email Action] Found', emailActions.length, 'email action config(s):', emailActions.map(ea => ({ id: ea.id, form_id: ea.form_id, template_id: ea.email_template_id, template_name: ea.email_template?.name })));

    for (const ea of emailActions) {
      const template = ea.email_template;
      if (!template) {
        results.push({
          action: 'send_email_template',
          email_action_id: ea.id,
          status: 'skipped',
          reason: 'Email template not found'
        });
        continue;
      }

      // Get recipient email from form values - try both field id and name
      const formValues = formSubmission.submission_data || {};
      let recipientEmail = formValues[ea.recipient_email_field] || formValues[`field_${ea.recipient_email_field}`];
      
      // If still not found, try to find field by searching common patterns
      if (!recipientEmail) {
        const emailFieldKey = Object.keys(formValues).find(key => 
          key === ea.recipient_email_field || 
          key.includes(ea.recipient_email_field) ||
          key.endsWith(`_${ea.recipient_email_field}`)
        );
        if (emailFieldKey) {
          recipientEmail = formValues[emailFieldKey];
        }
      }
      
      // Handle contact field type (email might be nested in an object)
      if (typeof recipientEmail === 'object' && recipientEmail !== null) {
        recipientEmail = recipientEmail.email || null;
      }
      
      // Get recipient name with same fallback logic
      let recipientName = null;
      if (ea.recipient_name_field) {
        recipientName = formValues[ea.recipient_name_field] || formValues[`field_${ea.recipient_name_field}`];
        if (!recipientName) {
          const nameFieldKey = Object.keys(formValues).find(key => 
            key === ea.recipient_name_field || 
            key.includes(ea.recipient_name_field) ||
            key.endsWith(`_${ea.recipient_name_field}`)
          );
          if (nameFieldKey) {
            recipientName = formValues[nameFieldKey];
          }
        }
      }

      if (!recipientEmail) {
        results.push({
          action: 'send_email_template',
          email_action_id: ea.id,
          template_name: template.name,
          status: 'skipped',
          reason: `No email found in field: ${ea.recipient_email_field}`
        });
        continue;
      }

      // Normalize email
      const normalizedEmail = recipientEmail.toLowerCase().trim();

      // Prepare email content with placeholder replacement
      let subject = template.subject || 'Notification';
      let body = template.body || '';

      // Handle name which could be a string or object
      let firstName = '';
      let lastName = '';
      let fullName = '';
      
      if (recipientName) {
        if (typeof recipientName === 'object') {
          firstName = recipientName.first_name || recipientName.firstName || '';
          lastName = recipientName.last_name || recipientName.lastName || '';
          fullName = [firstName, lastName].filter(Boolean).join(' ');
        } else {
          fullName = recipientName;
          const nameParts = recipientName.split(' ');
          firstName = nameParts[0] || '';
          lastName = nameParts.slice(1).join(' ') || '';
        }
      }

      // Get custom message - use options.customMessage if prompt_custom_message is enabled
      const customMessageValue = ea.prompt_custom_message ? (customMessage || '') : '';

      // Replace common placeholders
      const replacePlaceholders = (text) => {
        return text
          .replace(/\{\{custom_message\}\}/gi, customMessageValue)
          .replace(/\{\{recipient_name\}\}/gi, fullName || 'there')
          .replace(/\{\{recipient_first_name\}\}/gi, firstName || 'there')
          .replace(/\{\{recipient_last_name\}\}/gi, lastName)
          .replace(/\{\{recipient_email\}\}/gi, normalizedEmail)
          .replace(/\{\{first_name\}\}/gi, firstName || 'there')
          .replace(/\{\{last_name\}\}/gi, lastName)
          .replace(/\{\{name\}\}/gi, fullName || 'there')
          .replace(/\{\{email\}\}/gi, normalizedEmail);
      };

      subject = replacePlaceholders(subject);
      body = replacePlaceholders(body);

      // Build email options
      const emailOptions = {
        to: normalizedEmail,
        subject,
        html: body,
        from: template.from_email,
        replyTo: template.reply_to,
        tenantId
      };

      // Add CC if configured - validate email format
      if (ea.cc_emails) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const ccList = ea.cc_emails
          .split(',')
          .map(e => e.trim().toLowerCase())
          .filter(e => {
            if (!e) return false;
            if (!emailRegex.test(e)) {
              console.log(`[DD Email Action] Skipping invalid CC email: ${e}`);
              return false;
            }
            return true;
          });
        if (ccList.length > 0) {
          emailOptions.cc = ccList;
        }
      }

      try {
        console.log('[DD Email Action] About to send email:', {
          to: normalizedEmail,
          subject,
          from: template.from_email,
          cc: emailOptions.cc || null
        });
        
        await sendEmail(emailOptions);
        
        console.log('[DD Email Action] Email sent successfully!');
        
        results.push({
          action: 'send_email_template',
          email_action_id: ea.id,
          template_name: template.name,
          recipient_email: normalizedEmail,
          status: 'success'
        });

        await addHistoryLogEntry(ddSubmission.id, tenantId, 'email_sent', triggeredBy, {
          template_name: template.name,
          recipient: normalizedEmail,
          recipients: emailOptions.cc ? [normalizedEmail, ...emailOptions.cc] : [normalizedEmail]
        });
      } catch (emailError) {
        console.error(`[DD Email Action] Failed to send email to ${normalizedEmail}:`, emailError);
        results.push({
          action: 'send_email_template',
          email_action_id: ea.id,
          template_name: template.name,
          recipient_email: normalizedEmail,
          status: 'error',
          error: emailError.message
        });
      }
    }
  } catch (error) {
    console.error('[DD Email Action] Error executing email template actions:', error);
    results.push({
      action: 'send_email_template',
      status: 'error',
      error: error.message
    });
  }

  return results;
}

export async function executeMemberCreationActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  const results = [];
  const { configId } = options;
  
  console.log('[DD Member Action] ========== START executeMemberCreationActions ==========');
  console.log('[DD Member Action] Params:', { stageId, tenantId, triggeredBy, configId });
  console.log('[DD Member Action] ddSubmission ID:', ddSubmission?.id);
  
  try {
    // Fetch member creation configs for this stage, scoped to the specific DD config
    let query = supabase
      .from('stage_member_action')
      .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name, subject, from_email, reply_to)')
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    
    // Filter by config_id - this is required to prevent cross-form action execution
    if (configId) {
      query = query.eq('form_due_diligence_config_id', configId);
      console.log('[DD Member Action] Filtering by config_id:', configId);
    } else {
      // No configId means we cannot safely scope actions - return empty to prevent cross-form execution
      console.error('[DD Member Action] ERROR: No config_id provided - cannot execute member actions without proper scoping');
      return results;
    }
    
    const { data: memberActions, error: maError } = await query;

    if (maError) {
      console.log('[DD Member Action] Query error:', maError);
      return results;
    }
    if (!memberActions || memberActions.length === 0) {
      console.log('[DD Member Action] No member action configs found for this stage.');
      return results;
    }
    console.log('[DD Member Action] Found', memberActions.length, 'member action config(s)');

    const formSubmissionId = ddSubmission.form_submission_id;
    if (!formSubmissionId) {
      console.log('[DD Member Action] No form submission ID, skipping member actions');
      return results;
    }

    // Get form submission data
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, submission_data, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();

    if (subError || !formSubmission) {
      console.error('[DD Member Action] Could not find form submission:', subError);
      return results;
    }

    const organizationId = formSubmission.organization_id;
    if (!organizationId) {
      console.log('[DD Member Action] No organization_id on form submission, skipping');
      results.push({
        action: 'create_member',
        status: 'skipped',
        reason: 'Form submission has no associated organization'
      });
      return results;
    }

    // Helper function to get field value with fallback patterns
    const getFieldValue = (formValues, fieldKey) => {
      if (!fieldKey) return null;
      
      let value = formValues[fieldKey] || formValues[`field_${fieldKey}`];
      
      if (value === undefined) {
        const matchKey = Object.keys(formValues).find(key => 
          key === fieldKey || 
          key.includes(fieldKey) ||
          key.endsWith(`_${fieldKey}`)
        );
        if (matchKey) {
          value = formValues[matchKey];
        }
      }
      
      // Handle contact field type (value might be nested)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
      }
      
      return value;
    };

    for (const ma of memberActions) {
      const formValues = formSubmission.submission_data || {};
      
      // Get mandatory fields
      let firstName = getFieldValue(formValues, ma.first_name_field);
      let lastName = getFieldValue(formValues, ma.last_name_field);
      let email = getFieldValue(formValues, ma.email_field);
      
      // Handle if email comes from contact field
      if (typeof email === 'object' && email !== null) {
        email = email.email;
      }
      
      // Handle if first/last names come from contact field
      if (typeof firstName === 'object' && firstName !== null) {
        const contact = firstName;
        firstName = contact.first_name || contact.firstName || '';
      }
      if (typeof lastName === 'object' && lastName !== null) {
        const contact = lastName;
        lastName = contact.last_name || contact.lastName || '';
      }

      if (!email) {
        results.push({
          action: 'create_member',
          member_action_id: ma.id,
          status: 'skipped',
          reason: `No email found in field: ${ma.email_field}`
        });
        continue;
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Check if member already exists with this email in the tenant (not just organization)
      // This ensures uniqueness across the entire tenant
      const { data: existingMember } = await supabase
        .from('member')
        .select('id, email, organization_id')
        .eq('tenant_id', tenantId)
        .ilike('email', normalizedEmail)
        .single();

      if (existingMember) {
        results.push({
          action: 'create_member',
          member_action_id: ma.id,
          status: 'skipped',
          reason: `Member with email ${normalizedEmail} already exists in tenant`,
          email: normalizedEmail,
          first_name: firstName || '',
          last_name: lastName || '',
          existing_member_id: existingMember.id
        });
        continue;
      }

      // Build member data
      const memberData = {
        tenant_id: tenantId,
        organization_id: organizationId,
        first_name: firstName || '',
        last_name: lastName || '',
        email: normalizedEmail,
        login_enabled: ma.login_enabled === true,
        show_in_directory: true
      };

      // Get role - use configured role or find default
      if (ma.role_id) {
        memberData.role_id = ma.role_id;
      } else {
        const { data: defaultRole } = await supabase
          .from('role')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('is_default', true)
          .single();
        
        if (defaultRole) {
          memberData.role_id = defaultRole.id;
        }
      }

      // Process core field mappings
      const fieldMappings = ma.field_mappings || { core: {}, custom: {} };
      const coreMappings = fieldMappings.core || {};
      
      for (const [coreField, mapping] of Object.entries(coreMappings)) {
        if (!mapping || !mapping.source) continue;
        
        let value;
        if (mapping.source === 'form_field') {
          value = getFieldValue(formValues, mapping.value);
        } else if (mapping.source === 'manual') {
          value = mapping.value;
        }
        
        if (value !== undefined && value !== null && value !== '') {
          // Skip fields already set (first_name, last_name, email)
          if (['first_name', 'last_name', 'email'].includes(coreField)) continue;
          memberData[coreField] = value;
        }
      }

      // Create the member - wrapped in try-catch to handle race conditions
      // If another process creates the same email between our check and insert,
      // the unique constraint will cause a database error which we handle gracefully
      let newMember;
      try {
        const { data, error: createError } = await supabase
          .from('member')
          .insert(memberData)
          .select()
          .single();

        if (createError) {
          // Check if this is a unique constraint violation (race condition)
          const isUniqueViolation = 
            createError.code === '23505' || // PostgreSQL unique_violation error code
            createError.message?.includes('duplicate key') ||
            createError.message?.includes('unique constraint') ||
            createError.message?.includes('member_email_tenant_unique');
          
          if (isUniqueViolation) {
            console.log(`[DD Member Action] Race condition detected - member with email ${normalizedEmail} was just created by another process`);
            results.push({
              action: 'create_member',
              member_action_id: ma.id,
              status: 'skipped',
              reason: `Member with email ${normalizedEmail} was just created (race condition handled)`
            });
            continue;
          }
          
          // Other database errors
          console.error('[DD Member Action] Failed to create member:', createError);
          results.push({
            action: 'create_member',
            member_action_id: ma.id,
            status: 'failed',
            reason: createError?.message || 'Failed to create member'
          });
          continue;
        }
        
        newMember = data;
      } catch (err) {
        // Handle any unexpected errors (including constraint violations thrown as exceptions)
        const isUniqueViolation = 
          err?.code === '23505' ||
          err?.message?.includes('duplicate key') ||
          err?.message?.includes('unique constraint');
        
        if (isUniqueViolation) {
          console.log(`[DD Member Action] Race condition caught - member with email ${normalizedEmail} already exists`);
          results.push({
            action: 'create_member',
            member_action_id: ma.id,
            status: 'skipped',
            reason: `Member with email ${normalizedEmail} was just created (race condition handled)`
          });
          continue;
        }
        
        console.error('[DD Member Action] Unexpected error creating member:', err);
        results.push({
          action: 'create_member',
          member_action_id: ma.id,
          status: 'failed',
          reason: err?.message || 'Unexpected error creating member'
        });
        continue;
      }

      if (!newMember) {
        results.push({
          action: 'create_member',
          member_action_id: ma.id,
          status: 'failed',
          reason: 'Failed to create member - no data returned'
        });
        continue;
      }

      console.log(`[DD Member Action] Created member ${newMember.id} (${normalizedEmail})`);

      // Process custom field mappings (preference values)
      const customMappings = fieldMappings.custom || {};
      const customFieldErrors = [];
      
      for (const [prefFieldId, mapping] of Object.entries(customMappings)) {
        if (!mapping || !mapping.source) continue;
        
        let value;
        if (mapping.source === 'form_field') {
          value = getFieldValue(formValues, mapping.value);
        } else if (mapping.source === 'manual') {
          value = mapping.value;
        }
        
        if (value !== undefined && value !== null && value !== '') {
          // Store as string (preference values are stored as text)
          const storedValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          const { error: prefError } = await supabase
            .from('member_preference_value')
            .insert({
              member_id: newMember.id,
              field_id: prefFieldId,
              value: storedValue
            });
          
          if (prefError) {
            console.error(`[DD Member Action] Failed to set custom field ${prefFieldId}:`, prefError);
            customFieldErrors.push(prefFieldId);
          }
        }
      }

      // Send welcome email if template is configured
      if (ma.welcome_email_template_id) {
        try {
          // Fetch the email template
          const { data: emailTemplate, error: templateError } = await supabase
            .from('email_template')
            .select('*')
            .eq('id', ma.welcome_email_template_id)
            .eq('tenant_id', tenantId)
            .single();
          
          if (templateError || !emailTemplate) {
            console.error('[DD Member Action] Could not find welcome email template:', templateError);
          } else {
            // Get tenant info for email sending
            const { data: tenant } = await supabase
              .from('tenant')
              .select('name, slug')
              .eq('id', tenantId)
              .single();
            
            // Build placeholders for the email template
            const placeholders = {
              '{{first_name}}': newMember.first_name || '',
              '{{last_name}}': newMember.last_name || '',
              '{{email}}': newMember.email || '',
              '{{full_name}}': `${newMember.first_name || ''} ${newMember.last_name || ''}`.trim(),
              '{{member_first_name}}': newMember.first_name || '',
              '{{member_last_name}}': newMember.last_name || '',
              '{{member_email}}': newMember.email || '',
              '{{tenant_name}}': tenant?.name || '',
              '{{organization_name}}': '', // Could be fetched if needed
            };
            
            // Replace placeholders in subject and body
            let emailSubject = emailTemplate.subject || '';
            let emailBody = emailTemplate.body || '';
            
            for (const [placeholder, value] of Object.entries(placeholders)) {
              emailSubject = emailSubject.replaceAll(placeholder, value);
              emailBody = emailBody.replaceAll(placeholder, value);
            }
            
            // Send the email (include from and replyTo from template if available)
            const emailResult = await sendEmail({
              to: newMember.email,
              subject: emailSubject,
              html: emailBody,
              tenantId: tenantId,
              from: emailTemplate.from_email || undefined,
              replyTo: emailTemplate.reply_to || undefined
            });
            
            if (emailResult.success) {
              console.log(`[DD Member Action] Welcome email sent to ${newMember.email}`);
            } else {
              console.error('[DD Member Action] Failed to send welcome email:', emailResult.error);
            }
          }
        } catch (emailError) {
          console.error('[DD Member Action] Error sending welcome email:', emailError);
        }
      }

      results.push({
        action: 'create_member',
        member_action_id: ma.id,
        member_id: newMember.id,
        email: normalizedEmail,
        status: 'success',
        custom_field_errors: customFieldErrors.length > 0 ? customFieldErrors : undefined
      });

      await addHistoryLogEntry(ddSubmission.id, tenantId, 'member_created', triggeredBy, {
        member_email: normalizedEmail,
        member_name: `${newMember.first_name || ''} ${newMember.last_name || ''}`.trim() || normalizedEmail
      });
    }
  } catch (error) {
    console.error('[DD Member Action] Error executing member creation actions:', error);
    results.push({
      action: 'create_member',
      status: 'error',
      error: error.message
    });
  }

  return results;
}

async function executeFieldMappingActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  const results = [];
  
  try {
    // Fetch field mapping actions for this stage
    const { data: fieldMappingActions, error: fmaError } = await supabase
      .from('stage_field_mapping_action')
      .select('*')
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    
    if (fmaError || !fieldMappingActions || fieldMappingActions.length === 0) {
      return results;
    }
    
    // Get form submission data
    const { data: formSubmission, error: fsError } = await supabase
      .from('form_submission')
      .select('submission_data, organization_id')
      .eq('id', ddSubmission.form_submission_id)
      .eq('tenant_id', tenantId)
      .single();
    
    if (fsError || !formSubmission) {
      console.error('[DD Field Mapping] Form submission not found:', fsError);
      return results;
    }
    
    const organizationId = formSubmission.organization_id;
    if (!organizationId) {
      console.log('[DD Field Mapping] No organization_id on form submission, skipping field mappings');
      return results;
    }
    
    // Original submission data (fallback)
    const originalData = formSubmission.submission_data || {};
    // Reviewed values from due diligence review (preferred when available)
    const reviewedData = ddSubmission.reviewed_form_values || {};
    
    // Get preference fields for custom field lookups
    const { data: preferenceFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('entity_scope', 'organization')
      .eq('is_active', true);
    
    const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));
    
    for (const fma of fieldMappingActions) {
      const mappings = fma.field_mappings || [];
      const mappingResults = [];
      
      for (const mapping of mappings) {
        const { source_type, source_field_id, target_type, target_field, static_value } = mapping;
        
        let sourceValue;
        let valueSource;
        
        // Handle static vs. field-based source
        if (source_type === 'static') {
          // Use the static value directly
          sourceValue = static_value;
          valueSource = 'static';
          
          // Check if static value is usable
          if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
            console.log(`[DD Field Mapping] Static value for target ${target_field}: empty, skipping`);
            continue;
          }
          
          console.log(`[DD Field Mapping] Target ${target_field}: using static value "${sourceValue}"`);
        } else {
          // Get the value: prefer REVIEWED value, fall back to ORIGINAL
          // Note: 0 and false are valid values; only undefined/null/empty-string means "not set"
          const reviewedValue = reviewedData[source_field_id];
          const originalValue = originalData[source_field_id];
          
          // Check if reviewed value is truly present (0/false are valid, empty string is not)
          const hasReviewedValue = reviewedValue !== undefined && reviewedValue !== null && reviewedValue !== '';
          sourceValue = hasReviewedValue ? reviewedValue : originalValue;
          valueSource = hasReviewedValue ? 'reviewed' : 'original';
          
          // Check if source value is usable (0/false are valid, empty string is not)
          const isValueEmpty = sourceValue === undefined || sourceValue === null || sourceValue === '';
          if (isValueEmpty) {
            console.log(`[DD Field Mapping] Field ${source_field_id}: no value in reviewed or original data, skipping`);
            continue;
          }
          
          console.log(`[DD Field Mapping] Field ${source_field_id}: using ${valueSource} value`);
        }
        
        
        // Check if this is a composite field (e.g., "address.line1") for core type
        const isCompositeField = target_type === 'core' && target_field.includes('.');
        
        // Convert value for storage
        // For composite fields (stored in JSONB), keep native types; for others, stringify
        let storedValue = sourceValue;
        if (isCompositeField) {
          // For composite JSONB fields, use raw value (JSONB handles native types)
          // If sourceValue is a string, keep it as is; if object, store as-is in JSONB
          storedValue = sourceValue;
        } else if (typeof sourceValue === 'object') {
          storedValue = JSON.stringify(sourceValue);
        } else {
          storedValue = String(sourceValue);
        }
        
        if (target_type === 'core') {
          // Valid core fields for organization
          const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'description'];
          // Composite core fields (stored as JSONB with sub-fields)
          const COMPOSITE_CORE_FIELDS = {
            address: ['line1', 'line2', 'city', 'region', 'postcode', 'country']
          };
          
          // Parse composite field parts
          let parentField = null;
          let subField = null;
          
          if (isCompositeField) {
            [parentField, subField] = target_field.split('.');
            if (!COMPOSITE_CORE_FIELDS[parentField] || !COMPOSITE_CORE_FIELDS[parentField].includes(subField)) {
              console.warn(`[DD Field Mapping] Invalid composite core field ${target_field}, skipping`);
              mappingResults.push({ field: target_field, status: 'error', error: 'Invalid composite core field' });
              continue;
            }
          } else if (!VALID_CORE_FIELDS.includes(target_field)) {
            console.warn(`[DD Field Mapping] Invalid core field ${target_field}, skipping`);
            mappingResults.push({ field: target_field, status: 'error', error: 'Invalid core field' });
            continue;
          }
          
          if (isCompositeField) {
            // Handle composite field - fetch existing, merge, and update
            const { data: existingOrg, error: fetchError } = await supabase
              .from('organization')
              .select(parentField)
              .eq('id', organizationId)
              .eq('tenant_id', tenantId)
              .single();
            
            if (fetchError) {
              console.error(`[DD Field Mapping] Error fetching org for composite field ${target_field}:`, fetchError);
              mappingResults.push({ field: target_field, status: 'error', error: fetchError.message });
              continue;
            }
            
            // Merge the new value into the existing JSON object
            const existingValue = existingOrg?.[parentField] || {};
            const mergedValue = { ...existingValue, [subField]: storedValue };
            
            const updateData = {};
            updateData[parentField] = mergedValue;
            
            const { error: updateError } = await supabase
              .from('organization')
              .update(updateData)
              .eq('id', organizationId)
              .eq('tenant_id', tenantId);
            
            if (updateError) {
              console.error(`[DD Field Mapping] Error updating composite core field ${target_field}:`, updateError);
              mappingResults.push({ field: target_field, status: 'error', error: updateError.message });
            } else {
              mappingResults.push({ field: target_field, status: 'updated', type: 'core', composite: true });
            }
          } else {
            // Update simple core organization field
            const updateData = {};
            updateData[target_field] = storedValue;
            
            const { error: updateError } = await supabase
              .from('organization')
              .update(updateData)
              .eq('id', organizationId)
              .eq('tenant_id', tenantId);
            
            if (updateError) {
              console.error(`[DD Field Mapping] Error updating core field ${target_field}:`, updateError);
              mappingResults.push({ field: target_field, status: 'error', error: updateError.message });
            } else {
              mappingResults.push({ field: target_field, status: 'updated', type: 'core' });
            }
          }
        } else if (target_type === 'custom') {
          // Update custom organization preference field
          const customField = prefFieldMap.get(target_field);
          if (!customField) {
            console.warn(`[DD Field Mapping] Custom field ${target_field} not found`);
            mappingResults.push({ field: target_field, status: 'error', error: 'Custom field not found' });
            continue;
          }
          
          // Check if value already exists
          const { data: existing } = await supabase
            .from('organization_preference_value')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('field_id', target_field)
            .maybeSingle();
          
          if (existing) {
            const { error: updateError } = await supabase
              .from('organization_preference_value')
              .update({ value: storedValue, updated_at: new Date().toISOString() })
              .eq('id', existing.id);
            
            if (updateError) {
              console.error(`[DD Field Mapping] Error updating custom field ${customField.label}:`, updateError);
              mappingResults.push({ field: customField.label, status: 'error', error: updateError.message });
            } else {
              mappingResults.push({ field: customField.label, status: 'updated', type: 'custom' });
            }
          } else {
            const { error: insertError } = await supabase
              .from('organization_preference_value')
              .insert({
                organization_id: organizationId,
                field_id: target_field,
                value: storedValue
              });
            
            if (insertError) {
              console.error(`[DD Field Mapping] Error creating custom field ${customField.label}:`, insertError);
              mappingResults.push({ field: customField.label, status: 'error', error: insertError.message });
            } else {
              mappingResults.push({ field: customField.label, status: 'created', type: 'custom' });
            }
          }
        }
      }
      
      results.push({
        action: 'field_mapping',
        field_mapping_action_id: fma.id,
        mappings: mappingResults,
        status: mappingResults.some(r => r.status === 'error') ? 'partial' : 'success'
      });
      
      await addHistoryLogEntry(ddSubmission.id, tenantId, 'field_mapping_executed', triggeredBy, {
        mappings_count: mappingResults.filter(r => r.status !== 'error').length,
        organization_id: organizationId
      });
    }
  } catch (error) {
    console.error('[DD Field Mapping] Error executing field mapping actions:', error);
    results.push({
      action: 'field_mapping',
      status: 'error',
      error: error.message
    });
  }
  
  return results;
}

// Helper to find a form field by label (case-insensitive partial match)
function findFieldByLabel(fields, labelPattern) {
  if (!fields || !labelPattern) return null;
  const pattern = labelPattern.toLowerCase().trim();
  return fields.find(f => {
    const label = (f.label || '').toLowerCase();
    return label === pattern || label.includes(pattern);
  });
}

// Helper to get field value from submission data
function getFieldValue(formValues, field) {
  if (!field || !formValues) return null;
  
  // Try field.id first (most common)
  if (field.id && formValues[field.id] !== undefined) {
    return formValues[field.id];
  }
  
  // Try field.name
  if (field.name && formValues[field.name] !== undefined) {
    return formValues[field.name];
  }
  
  // Try field.key (some forms use key)
  if (field.key && formValues[field.key] !== undefined) {
    return formValues[field.key];
  }
  
  // Try prefixed versions
  if (field.id && formValues[`field_${field.id}`] !== undefined) {
    return formValues[`field_${field.id}`];
  }
  
  // Try partial key match as fallback
  const fieldId = field.id || field.name || field.key;
  if (fieldId) {
    const matchKey = Object.keys(formValues).find(key => 
      key === fieldId || 
      key.includes(fieldId) ||
      key.endsWith(`_${fieldId}`)
    );
    if (matchKey) {
      return formValues[matchKey];
    }
  }
  
  return null;
}

// Transform education levels based on schooling selection
function transformEducationLevels(schoolingValues) {
  if (!schoolingValues || !Array.isArray(schoolingValues)) return [];
  
  const educationLevels = [];
  const schoolingStr = schoolingValues.join(' ').toLowerCase();
  
  // Pre-primary if contains ECED
  if (schoolingStr.includes('eced') || schoolingStr.includes('early childhood')) {
    educationLevels.push('Pre-primary');
  }
  
  // Primary if contains Grade 1-10
  const gradeNumbers = schoolingStr.match(/grade\s*(\d+)/gi) || [];
  const hasGrade1to10 = gradeNumbers.some(g => {
    const num = parseInt(g.replace(/\D/g, ''));
    return num >= 1 && num <= 10;
  });
  if (hasGrade1to10 || schoolingStr.includes('primary')) {
    educationLevels.push('Primary');
  }
  
  // Secondary if contains Grade 11 or 12
  const hasGrade11or12 = gradeNumbers.some(g => {
    const num = parseInt(g.replace(/\D/g, ''));
    return num >= 11;
  });
  if (hasGrade11or12 || schoolingStr.includes('secondary')) {
    educationLevels.push('Secondary');
  }
  
  return [...new Set(educationLevels)]; // Remove duplicates
}

// Determine organization type for Zoho (ESO or SO) based on form name/slug
function determineOrganizationType(formName, formSlug) {
  const name = (formName || '').toLowerCase();
  const slug = (formSlug || '').toLowerCase();
  
  // Use en-dash (U+2013) to match Zoho picklist values exactly
  // Zoho's picklist uses en-dashes, not regular hyphens
  if (name.includes('eso') || slug.includes('eso')) {
    return 'Member \u2013 Education Support Organisations';
  }
  if (name.includes('so') || slug.includes('so') || name.includes('school')) {
    return 'Member \u2013 School and ECED Operators';
  }
  // Default to ESO if can't determine
  return 'Member \u2013 Education Support Organisations';
}

export async function executeZohoCrmActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  const results = [];
  
  console.log('[DD Zoho CRM] ========== START executeZohoCrmActions ==========');
  console.log('[DD Zoho CRM] Params:', { stageId, tenantId, triggeredBy });
  console.log('[DD Zoho CRM] ddSubmission ID:', ddSubmission?.id);
  
  try {
    // Check if Zoho CRM is connected
    const isConnected = await isZohoCrmConnected(tenantId);
    if (!isConnected) {
      console.log('[DD Zoho CRM] Zoho CRM not connected for tenant');
      return results;
    }
    
    const formSubmissionId = ddSubmission.form_submission_id;
    if (!formSubmissionId) {
      console.log('[DD Zoho CRM] No form submission ID, skipping');
      return results;
    }
    
    // Get form submission data
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('form_id, submission_data, organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .single();
    
    if (subError || !formSubmission) {
      console.error('[DD Zoho CRM] Could not find form submission:', subError);
      return results;
    }
    
    const formId = formSubmission.form_id;
    
    // Fetch Zoho CRM action configs for this stage and form
    // First try form-specific actions, then fall back to global actions (form_id IS NULL)
    console.log('[DD Zoho CRM] Querying actions for stage:', stageId, 'form:', formId);
    
    let { data: zohoCrmActions, error: zcError } = await supabase
      .from('stage_zoho_crm_action')
      .select('*')
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    
    // If no form-specific actions found, check for global actions (form_id is null)
    if ((!zohoCrmActions || zohoCrmActions.length === 0) && !zcError) {
      console.log('[DD Zoho CRM] No form-specific actions found, checking for global actions (form_id is null)');
      const globalResult = await supabase
        .from('stage_zoho_crm_action')
        .select('*')
        .eq('due_diligence_stage_id', stageId)
        .eq('tenant_id', tenantId)
        .is('form_id', null)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      
      if (!globalResult.error) {
        zohoCrmActions = globalResult.data;
      }
    }
    
    if (zcError) {
      console.log('[DD Zoho CRM] Query error:', zcError);
      return results;
    }
    
    if (!zohoCrmActions || zohoCrmActions.length === 0) {
      console.log('[DD Zoho CRM] No Zoho CRM actions configured for this stage');
      return results;
    }
    
    console.log('[DD Zoho CRM] Found', zohoCrmActions.length, 'Zoho CRM action(s)');
    
    // Get form fields for label lookups
    const { data: form } = await supabase
      .from('form')
      .select('id, name, slug, fields')
      .eq('id', formId)
      .single();
    
    if (!form) {
      console.error('[DD Zoho CRM] Could not find form');
      return results;
    }
    
    const formFields = form.fields || [];
    const formValues = formSubmission.submission_data || {};
    
    // Helper to find field by label (case-insensitive partial match)
    const findFieldByLabel = (fields, labelSearch) => {
      if (!fields || !labelSearch) return null;
      const searchLower = labelSearch.toLowerCase();
      const field = fields.find(f => 
        f.label && f.label.toLowerCase().includes(searchLower)
      );
      return field?.id || field?.key || null;
    };
    
    // Helper to get field value from form submission
    const getFieldValue = (values, fieldKey) => {
      if (!fieldKey || !values) return null;
      return values[fieldKey] || values[`field_${fieldKey}`] || null;
    };
    
    // Extract logo URL from File Upload field
    const logoField = findFieldByLabel(formFields, 'logo');
    let logoUrl = null;
    
    // Helper to extract file metadata from various file upload value structures
    // File uploads in this system store as: { file_url: "...", storage_path: "...", bucket: "...", file_name: "..." }
    // The file_url is often a relative path like /api/storage/secure-url?... which is internal
    // We need storage_path and bucket to generate a Supabase signed URL
    const extractFileMetadata = (value, depth = 0) => {
      if (!value || depth > 3) return null; // Limit recursion depth
      
      // Handle string values - might be JSON
      if (typeof value === 'string') {
        // Check if it's a JSON string (starts with { or [)
        if (value.startsWith('{') || value.startsWith('[')) {
          try {
            const parsed = JSON.parse(value);
            return extractFileMetadata(parsed, depth + 1);
          } catch (e) {
            console.log('[DD Zoho CRM] Failed to parse logo JSON string');
            return null;
          }
        }
        // Direct URL string
        if (value.startsWith('http')) {
          return { directUrl: value };
        }
        return null;
      }
      
      // Array of files - take the first one
      if (Array.isArray(value)) {
        if (value.length === 0) return null;
        return extractFileMetadata(value[0], depth + 1);
      }
      
      // Object - extract storage metadata
      if (typeof value === 'object') {
        // If we have storage_path and bucket, we can generate a signed URL
        if (value.storage_path && value.bucket) {
          console.log('[DD Zoho CRM] Found storage metadata - bucket:', value.bucket, 'path:', value.storage_path);
          return {
            bucket: value.bucket,
            storagePath: value.storage_path,
            isPrivate: value.is_private !== false // default to private
          };
        }
        
        // Direct http URL
        const directUrl = value.file_url || value.url || value.publicUrl || value.signedUrl || value.downloadUrl || value.src;
        if (directUrl && typeof directUrl === 'string' && directUrl.startsWith('http')) {
          return { directUrl };
        }
        
        // Common wrapper properties
        if (value.value) return extractFileMetadata(value.value, depth + 1);
        if (value.data) return extractFileMetadata(value.data, depth + 1);
        if (value.file) return extractFileMetadata(value.file, depth + 1);
        if (value.files) return extractFileMetadata(value.files, depth + 1);
        if (value.metadata?.url) return { directUrl: value.metadata.url };
        
        // Log what keys we found to help debug
        console.log('[DD Zoho CRM] Could not extract file metadata from object, keys:', Object.keys(value).join(', '));
        return null;
      }
      
      return null;
    };
    
    // Generate a Supabase signed URL from storage metadata
    // Note: Signed URLs can be long (500+ chars), but Zoho's limit is 450
    // For private buckets, we must use signed URLs (public URLs return 404)
    const generateSignedUrl = async (metadata) => {
      if (!metadata) return null;
      
      // Already have a direct URL
      if (metadata.directUrl) {
        console.log('[DD Zoho CRM] Using direct URL from metadata');
        return metadata.directUrl;
      }
      
      // Generate URL from bucket/path
      if (metadata.bucket && metadata.storagePath) {
        try {
          console.log('[DD Zoho CRM] Generating URL for bucket:', metadata.bucket, 'path:', metadata.storagePath);
          
          // Check if bucket is private (contains "private" in name or isPrivate flag)
          const isPrivateBucket = metadata.isPrivate || 
                                  metadata.bucket.toLowerCase().includes('private');
          
          // For public buckets only, try getPublicUrl (shorter, permanent)
          if (!isPrivateBucket) {
            const { data: publicData } = supabase.storage
              .from(metadata.bucket)
              .getPublicUrl(metadata.storagePath);
            
            if (publicData?.publicUrl && publicData.publicUrl.length <= 450) {
              console.log('[DD Zoho CRM] Using public URL, length:', publicData.publicUrl.length);
              return publicData.publicUrl;
            }
          }
          
          // For private buckets or if public URL too long, use signed URL
          console.log('[DD Zoho CRM] Generating signed URL for private bucket');
          const { data, error } = await supabase.storage
            .from(metadata.bucket)
            .createSignedUrl(metadata.storagePath, 60 * 60 * 24 * 7); // 7 days
          
          if (error) {
            console.error('[DD Zoho CRM] Failed to generate signed URL:', error.message);
            return null;
          }
          
          console.log('[DD Zoho CRM] Generated signed URL, length:', data.signedUrl.length);
          return data.signedUrl;
        } catch (err) {
          console.error('[DD Zoho CRM] Error generating URL:', err.message);
          return null;
        }
      }
      
      return null;
    };
    
    // Validate URL for Zoho's website field (max 450 chars, must be http/https)
    const validateLogoUrl = (url) => {
      if (!url || typeof url !== 'string') return null;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.log('[DD Zoho CRM] Logo URL does not start with http/https:', url.substring(0, 50));
        return null;
      }
      if (url.length > 450) {
        console.log('[DD Zoho CRM] Logo URL exceeds 450 chars (length:', url.length, '), skipping');
        return null;
      }
      return url;
    };
    
    if (logoField) {
      const logoValue = getFieldValue(formValues, logoField);
      console.log('[DD Zoho CRM] Logo field found:', logoField, 'type:', typeof logoValue, 'isArray:', Array.isArray(logoValue));
      if (logoValue && typeof logoValue === 'object') {
        console.log('[DD Zoho CRM] Logo value keys:', Object.keys(logoValue).join(', '));
      } else if (logoValue && typeof logoValue === 'string') {
        console.log('[DD Zoho CRM] Logo value is string, length:', logoValue.length, 'preview:', logoValue.substring(0, 100));
      }
      const fileMetadata = extractFileMetadata(logoValue);
      if (fileMetadata) {
        const rawLogoUrl = await generateSignedUrl(fileMetadata);
        logoUrl = validateLogoUrl(rawLogoUrl);
      }
    } else {
      console.log('[DD Zoho CRM] No logo field found in form fields. Available labels:', formFields.map(f => f.label).filter(Boolean).join(', '));
    }
    
    // Fallback 1: Check submission_document table (primary source for versioned documents)
    // Logo files were migrated to public-assets bucket via submission_document
    // Known logo field ID from ESO/Partner/SO Long forms
    const LOGO_FIELD_ID = 'field_1768830324467';
    
    if (!logoUrl) {
      console.log('[DD Zoho CRM] No valid logo from form field, checking submission_document table...');
      
      // Query by exact field ID first, then fallback to field name containing 'logo'
      // Scoped by form_submission_id (which is already tenant-scoped from parent query)
      let submissionDocs = null;
      let sdError = null;
      
      // First try exact field ID match
      const exactResult = await supabase
        .from('submission_document')
        .select('id, field_name, file_url, storage_path, bucket, file_name, version, tenant_id')
        .eq('form_submission_id', formSubmissionId)
        .eq('tenant_id', tenantId)
        .eq('field_name', LOGO_FIELD_ID)
        .order('version', { ascending: false })
        .limit(1);
      
      if (!exactResult.error && exactResult.data?.length > 0) {
        submissionDocs = exactResult.data;
        console.log('[DD Zoho CRM] Found logo by exact field ID:', LOGO_FIELD_ID);
      } else {
        // Fallback: search by field name containing 'logo' (case-insensitive)
        // Still scoped by tenant_id for multi-tenant safety
        const fuzzyResult = await supabase
          .from('submission_document')
          .select('id, field_name, file_url, storage_path, bucket, file_name, version, tenant_id')
          .eq('form_submission_id', formSubmissionId)
          .eq('tenant_id', tenantId)
          .ilike('field_name', '%logo%')
          .order('version', { ascending: false })
          .limit(1);
        
        submissionDocs = fuzzyResult.data;
        sdError = fuzzyResult.error;
        if (submissionDocs?.length > 0) {
          console.log('[DD Zoho CRM] Found logo by fuzzy field name match:', submissionDocs[0].field_name);
        }
      }
      
      if (sdError) {
        console.log('[DD Zoho CRM] Error querying submission_document:', sdError.message);
      } else if (submissionDocs?.[0]) {
        const doc = submissionDocs[0];
        console.log('[DD Zoho CRM] Found logo in submission_document - bucket:', doc.bucket, 'path:', doc.storage_path);
        
        if (doc.storage_path && doc.bucket) {
          // For public-assets bucket, use public URL directly (shorter, permanent, no expiry)
          if (doc.bucket === 'public-assets') {
            const { data: publicData } = supabase.storage
              .from(doc.bucket)
              .getPublicUrl(doc.storage_path);
            
            if (publicData?.publicUrl) {
              console.log('[DD Zoho CRM] Using public URL from public-assets bucket, length:', publicData.publicUrl.length);
              // Public URLs are typically short enough (<450)
              // If public URL exceeds 450 chars, Zoho may reject it - try signed URL as fallback
              if (publicData.publicUrl.length <= 450) {
                logoUrl = publicData.publicUrl;
              } else {
                console.log('[DD Zoho CRM] Public URL exceeds 450 chars, trying signed URL...');
                const signedUrl = await generateSignedUrl({ bucket: doc.bucket, storagePath: doc.storage_path });
                logoUrl = validateLogoUrl(signedUrl);
              }
            }
          } else {
            // Private bucket - use signed URL
            const rawDocUrl = await generateSignedUrl({ bucket: doc.bucket, storagePath: doc.storage_path });
            logoUrl = validateLogoUrl(rawDocUrl);
          }
        } else if (doc.file_url && doc.file_url.startsWith('http')) {
          logoUrl = validateLogoUrl(doc.file_url);
        }
        
        if (logoUrl) {
          console.log('[DD Zoho CRM] Found valid logo URL in submission_document table');
        }
      }
    }
    
    // Fallback 2: Check due_diligence_document table (legacy)
    if (!logoUrl) {
      console.log('[DD Zoho CRM] No logo in submission_document, checking due_diligence_document table...');
      const { data: ddDocuments } = await supabase
        .from('due_diligence_document')
        .select('id, document_type, file_url, storage_path, bucket, tenant_id')
        .eq('form_submission_due_diligence_id', ddSubmission.id)
        .eq('tenant_id', tenantId)
        .eq('document_type', 'logo')
        .limit(1);
      
      if (ddDocuments?.[0]) {
        const doc = ddDocuments[0];
        // For public-assets bucket, use public URL directly
        if (doc.storage_path && doc.bucket) {
          console.log('[DD Zoho CRM] Found document with storage metadata');
          if (doc.bucket === 'public-assets') {
            const { data: publicData } = supabase.storage
              .from(doc.bucket)
              .getPublicUrl(doc.storage_path);
            
            if (publicData?.publicUrl) {
              logoUrl = validateLogoUrl(publicData.publicUrl);
            }
          } else {
            const rawDocUrl = await generateSignedUrl({ bucket: doc.bucket, storagePath: doc.storage_path });
            logoUrl = validateLogoUrl(rawDocUrl);
          }
        } else if (doc.file_url && doc.file_url.startsWith('http')) {
          logoUrl = validateLogoUrl(doc.file_url);
        }
        if (logoUrl) {
          console.log('[DD Zoho CRM] Found valid logo URL in due_diligence_document table');
        }
      }
    }
    
    console.log('[DD Zoho CRM] Final logo URL:', logoUrl ? `valid (${logoUrl.length} chars)` : 'null');
    
    for (const action of zohoCrmActions) {
      try {
        console.log('[DD Zoho CRM] Processing action:', action.id);
        
        // Skip if already executed for this submission
        if (ddSubmission.zoho_crm_account_id) {
          console.log('[DD Zoho CRM] Zoho CRM account already created:', ddSubmission.zoho_crm_account_id);
          results.push({
            action: 'zoho_crm_create',
            action_id: action.id,
            status: 'skipped',
            reason: 'Already synced to Zoho CRM',
            zoho_account_id: ddSubmission.zoho_crm_account_id
          });
          continue;
        }
        
        // Field mappings - find by label
        const orgNameField = findFieldByLabel(formFields, 'Name of organisation') || 
                             findFieldByLabel(formFields, 'Organisation name') ||
                             findFieldByLabel(formFields, 'Organization name');
        const websiteField = findFieldByLabel(formFields, 'Organisation website') ||
                             findFieldByLabel(formFields, 'Website');
        const countriesField = findFieldByLabel(formFields, 'Countries of operation');
        const schoolingField = findFieldByLabel(formFields, 'What level of schooling');
        const servicesField = findFieldByLabel(formFields, 'what services do you provide') ||
                              findFieldByLabel(formFields, 'services provided');
        const themesField = findFieldByLabel(formFields, 'specific focus on the following') ||
                            findFieldByLabel(formFields, 'emerging or existing themes');
        
        // Extract values
        let orgName = getFieldValue(formValues, orgNameField);
        const website = getFieldValue(formValues, websiteField);
        
        // Check if orgName is a UUID (organization ID reference) and resolve to actual name
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (orgName && uuidPattern.test(orgName)) {
          console.log('[DD Zoho CRM] orgName is a UUID, looking up organization name:', orgName);
          const resolvedName = await getOrganizationName(orgName);
          if (resolvedName) {
            console.log('[DD Zoho CRM] Resolved organization name:', resolvedName);
            orgName = resolvedName;
          } else {
            console.log('[DD Zoho CRM] Could not resolve organization UUID to name, using as-is');
          }
        }
        const countriesRaw = getFieldValue(formValues, countriesField);
        const schoolingRaw = getFieldValue(formValues, schoolingField);
        const servicesRaw = getFieldValue(formValues, servicesField);
        const themesRaw = getFieldValue(formValues, themesField);
        
        // Normalize arrays
        const countries = Array.isArray(countriesRaw) ? countriesRaw : 
                          (countriesRaw ? [countriesRaw] : []);
        const schoolingLevels = Array.isArray(schoolingRaw) ? schoolingRaw :
                                (schoolingRaw ? [schoolingRaw] : []);
        const services = Array.isArray(servicesRaw) ? servicesRaw :
                         (servicesRaw ? [servicesRaw] : []);
        const themes = Array.isArray(themesRaw) ? themesRaw :
                       (themesRaw ? [themesRaw] : []);
        
        // Transform education levels
        const educationLevels = transformEducationLevels(schoolingLevels);
        
        // Determine org type based on form
        const orgType = determineOrganizationType(form.name, form.slug);
        
        console.log('[DD Zoho CRM] Field values:', {
          orgName,
          website,
          countriesCount: countries.length,
          educationLevels,
          orgType,
          servicesCount: services.length,
          themesCount: themes.length,
          logoUrl
        });
        
        if (!orgName) {
          results.push({
            action: 'zoho_crm_create',
            action_id: action.id,
            status: 'skipped',
            reason: 'No organisation name found in submission'
          });
          continue;
        }
        
        // Build country subform by looking up each country
        const countrySubform = [];
        for (const countryName of countries) {
          const countryRecord = await lookupCountryInZoho(tenantId, countryName);
          if (countryRecord) {
            countrySubform.push({
              Countries_of_ops: { id: countryRecord.id },
              GSF_Region_Classification_1: countryRecord.GSF_Region_Classification,
              Income_Group_1: countryRecord.Income_Group,
              Flag_1: countryRecord.Flag
            });
          } else {
            console.log('[DD Zoho CRM] Country not found in Zoho:', countryName);
            // Add without lookup data
            countrySubform.push({
              Country_Name: countryName
            });
          }
        }
        
        // Build the Zoho organization record
        // Note: Field names must match exact Zoho CRM API names (case-sensitive)
        // Account_Type uses en-dash (U+2013) to match Zoho picklist values
        if (orgType) {
          console.log('[DD Zoho CRM] Account_Type value:', JSON.stringify(orgType), 'char codes:', [...orgType].map(c => c.charCodeAt(0)));
        }
        
        const orgData = {
          Account_Name: orgName,
          Lifecycle_Status: 'Current',
          Account_Type: orgType,
          Website: website || undefined,
          Org_logo_URL: logoUrl || undefined  // Note: lowercase 'l' in logo
        };
        
        // Add multi-select fields (using exact Zoho API field names)
        if (educationLevels.length > 0) {
          orgData.Education_levels = educationLevels;  // Note: lowercase 'l' in levels
        }
        if (countries.length > 0) {
          orgData.Countries_of_Operation = countries;
        }
        if (services.length > 0) {
          orgData.Services_provided_to_partner_schools = services;  // Correct API name
        }
        if (themes.length > 0) {
          orgData.Do_programs_focus_on_key_emerging_existing_themes = themes;  // Correct API name
        }
        
        // Add country subform
        if (countrySubform.length > 0) {
          orgData.Countries1 = countrySubform;  // Correct API name is Countries1
        }
        
        // Create the organization in Zoho CRM
        const createResult = await createZohoOrganization(tenantId, orgData);
        
        if (createResult.success) {
          // Update DD submission with Zoho account ID
          await supabase
            .from('form_submission_due_diligence')
            .update({ 
              zoho_crm_account_id: createResult.id,
              updated_at: new Date().toISOString()
            })
            .eq('id', ddSubmission.id)
            .eq('tenant_id', tenantId);
          
          // Update action execution tracking
          await supabase
            .from('stage_zoho_crm_action')
            .update({
              last_executed_at: new Date().toISOString(),
              last_execution_result: createResult
            })
            .eq('id', action.id);
          
          results.push({
            action: 'zoho_crm_create',
            action_id: action.id,
            status: 'success',
            zoho_account_id: createResult.id,
            org_name: orgName
          });
          
          await addHistoryLogEntry(ddSubmission.id, tenantId, 'zoho_crm_synced', triggeredBy, {
            zoho_account_id: createResult.id,
            org_name: orgName
          });
          
          console.log('[DD Zoho CRM] Successfully created organization:', createResult.id);
        } else {
          results.push({
            action: 'zoho_crm_create',
            action_id: action.id,
            status: 'error',
            error: createResult.error,
            org_name: orgName
          });
          
          console.error('[DD Zoho CRM] Failed to create organization:', createResult.error);
        }
      } catch (actionError) {
        console.error('[DD Zoho CRM] Error executing action:', action.id, actionError);
        results.push({
          action: 'zoho_crm_create',
          action_id: action.id,
          status: 'error',
          error: actionError.message
        });
      }
    }
  } catch (error) {
    console.error('[DD Zoho CRM] Error executing Zoho CRM actions:', error);
    results.push({
      action: 'zoho_crm_create',
      status: 'error',
      error: error.message
    });
  }
  
  console.log('[DD Zoho CRM] ========== END executeZohoCrmActions ==========');
  return results;
}

export async function executeStageActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
  console.log('[DD Stage Actions] executeStageActions called:', {
    stageId,
    ddSubmissionId: ddSubmission?.id,
    formSubmissionId: ddSubmission?.form_submission_id,
    tenantId,
    triggeredBy
  });
  
  const formId = ddSubmission.form_submission?.form_id || ddSubmission.form_id;
  
  if (!formId) {
    console.log('[DD Stage Actions] No formId in submission, looking up from form_submission table');
    const { data: formSub } = await supabase
      .from('form_submission')
      .select('form_id')
      .eq('id', ddSubmission.form_submission_id)
      .single();
    
    if (formSub) {
      ddSubmission.form_id = formSub.form_id;
      console.log('[DD Stage Actions] Found form_id:', formSub.form_id);
    } else {
      console.log('[DD Stage Actions] Could not find form_id for submission:', ddSubmission.form_submission_id);
    }
  }

  const effectiveFormId = ddSubmission.form_submission?.form_id || ddSubmission.form_id;
  console.log('[DD Stage Actions] Querying DD config for form_id:', effectiveFormId, 'tenant_id:', tenantId);
  
  const { data: ddConfig, error: configError } = await supabase
    .from('form_due_diligence_config')
    .select('id, workflow_stages')
    .eq('form_id', effectiveFormId)
    .eq('tenant_id', tenantId)
    .single();

  if (configError) {
    console.error('[DD Stage Actions] Error fetching DD config:', configError);
  }

  if (!ddConfig) {
    console.log('[DD Stage Actions] No DD config found, returning empty results');
    return { stage_actions_results: [] };
  }
  
  console.log('[DD Stage Actions] Found DD config with', ddConfig.workflow_stages?.length || 0, 'stages');

  const workflowStages = ddConfig.workflow_stages || [];
  const stage = workflowStages.find(s => s.id === stageId);
  
  if (!stage) {
    console.log('[DD Stage Actions] Stage not found:', stageId, 'available stages:', workflowStages.map(s => s.id));
  } else {
    console.log('[DD Stage Actions] Found stage:', stageId);
  }
  
  const results = [];

  // Execute contract sending actions if stage has them configured
  if (stage) {
    // Support both "actions" and "stage_actions" keys for compatibility
    const stageActions = stage.actions || stage.stage_actions;
    const sendContracts = stageActions?.send_contracts || [];
    console.log('[DD Stage Actions] Stage has', sendContracts.length, 'send_contracts actions:', sendContracts);
    
    if (sendContracts.length > 0) {
      console.log('[DD Stage Actions] Executing contract sending for contact fields:', sendContracts);
      const contractResults = await executeContractSendingActions(
        sendContracts,
        ddSubmission,
        tenantId,
        triggeredBy
      );
      console.log('[DD Stage Actions] Contract sending results:', contractResults.length, 'contracts processed');
      results.push(...contractResults);
    }
  }

  // Execute meeting request actions (stored in stage_meeting_request table)
  // These are stored separately from workflow stage config, so always check
  const meetingResults = await executeMeetingRequestActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    options
  );
  results.push(...meetingResults);

  // Execute email template actions (stored in stage_email_action table)
  const emailResults = await executeEmailTemplateActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    options
  );
  results.push(...emailResults);

  // Execute member creation actions (stored in stage_member_action table)
  // Pass the config ID to ensure actions are scoped to this specific form's config
  const memberResults = await executeMemberCreationActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    { ...options, configId: ddConfig.id }
  );
  results.push(...memberResults);

  // Execute field mapping actions (stored in stage_field_mapping_action table)
  const fieldMappingResults = await executeFieldMappingActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    options
  );
  results.push(...fieldMappingResults);

  // Execute Zoho CRM actions (stored in stage_zoho_crm_action table)
  const zohoCrmResults = await executeZohoCrmActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    options
  );
  results.push(...zohoCrmResults);

  console.log('[DD Stage Actions] Completed all stage actions, total results:', results.length);
  return { stage_actions_results: results };
}

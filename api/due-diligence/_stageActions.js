import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';

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
      .select('form_id, submission_data, organization_id')
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
        const formValues = formSubmission.submission_data || {};
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
      const sentSignerEmails = [];

      for (const signer of signers) {
        if (!signer.email) {
          failedCount++;
          continue;
        }

        const signingUrl = `${baseUrl}/FormView?slug=${contractForm.slug}&contract_instance=${contractInstance.id}&signer=${encodeURIComponent(signer.email)}`;

        let subject = emailTemplate.subject || 'Contract for Signing';
        let body = emailTemplate.body || '';

        const signerFirstName = signer.first_name || signer.name?.split(' ')[0] || '';
        const signerLastName = signer.last_name || signer.name?.split(' ').slice(1).join(' ') || '';
        const signerFullName = signer.name || [signerFirstName, signerLastName].filter(Boolean).join(' ') || '';

        subject = subject
          .replace(/\{\{signer_name\}\}/gi, signerFullName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signingUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signingUrl}">Click here to sign</a>`);

        body = body
          .replace(/\{\{signer_name\}\}/gi, signerFullName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
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
    console.error('[DD Stage Actions] Error executing contract sending:', error);
    results.push({
      action: 'send_contract',
      status: 'error',
      error: error.message
    });
  }

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
    // Fetch email action configs for this stage
    console.log('[DD Email Action] Querying stage_email_action for stageId:', stageId, 'tenantId:', tenantId);
    const { data: emailActions, error: eaError } = await supabase
      .from('stage_email_action')
      .select(`
        *,
        email_template:email_template_id (
          id, name, subject, body, from_email, reply_to
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (eaError) {
      console.log('[DD Email Action] Query error:', eaError);
      return results;
    }
    if (!emailActions || emailActions.length === 0) {
      console.log('[DD Email Action] No email action configs found for this stage. Returning empty results.');
      return results;
    }
    console.log('[DD Email Action] Found', emailActions.length, 'email action config(s):', emailActions.map(ea => ({ id: ea.id, template_id: ea.email_template_id, template_name: ea.email_template?.name })));

    const formSubmissionId = ddSubmission.form_submission_id;
    if (!formSubmissionId) {
      console.log('[DD Email Action] No form submission ID, skipping email actions');
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
      console.error('[DD Email Action] Could not find form submission:', subError);
      return results;
    }

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
  
  console.log('[DD Member Action] ========== START executeMemberCreationActions ==========');
  console.log('[DD Member Action] Params:', { stageId, tenantId, triggeredBy });
  console.log('[DD Member Action] ddSubmission ID:', ddSubmission?.id);
  
  try {
    // Fetch member creation configs for this stage
    const { data: memberActions, error: maError } = await supabase
      .from('stage_member_action')
      .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name, subject, from_email, reply_to)')
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

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
        login_enabled: false,
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
    
    const submissionData = formSubmission.submission_data || {};
    
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
        const { source_field_id, target_type, target_field } = mapping;
        
        // Get the value from form submission
        const sourceValue = submissionData[source_field_id];
        if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
          continue;
        }
        
        // Convert value to string for storage
        let storedValue = sourceValue;
        if (typeof sourceValue === 'object') {
          storedValue = JSON.stringify(sourceValue);
        } else {
          storedValue = String(sourceValue);
        }
        
        if (target_type === 'core') {
          // Validate core field is in allowlist
          const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'address', 'description'];
          if (!VALID_CORE_FIELDS.includes(target_field)) {
            console.warn(`[DD Field Mapping] Invalid core field ${target_field}, skipping`);
            mappingResults.push({ field: target_field, status: 'error', error: 'Invalid core field' });
            continue;
          }
          
          // Update core organization field
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

export async function executeStageActions(stageId, ddSubmission, tenantId, triggeredBy, options = {}) {
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
  
  const results = [];

  // Execute contract sending actions if stage has them configured
  if (stage) {
    // Support both "actions" and "stage_actions" keys for compatibility
    const stageActions = stage.actions || stage.stage_actions;
    if (stageActions?.send_contracts && stageActions.send_contracts.length > 0) {
      const contractResults = await executeContractSendingActions(
        stageActions.send_contracts,
        ddSubmission,
        tenantId,
        triggeredBy
      );
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
  const memberResults = await executeMemberCreationActions(
    stageId,
    ddSubmission,
    tenantId,
    triggeredBy,
    options
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

  return { stage_actions_results: results };
}

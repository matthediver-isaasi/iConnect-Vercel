import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { executeStageActions } from './_stageActions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { sourceSubmissionId, targetFormId, contractAction = 'relink' } = req.body;

    if (!sourceSubmissionId || !targetFormId) {
      return res.status(400).json({ error: 'sourceSubmissionId and targetFormId are required' });
    }

    const { data: sourceDDSubmission, error: sourceError } = await supabase
      .from('form_submission_due_diligence')
      .select(`
        *,
        form_submission:form_submission_id(
          id, 
          form_id, 
          submission_data,
          organization_id,
          tenant_id
        )
      `)
      .eq('id', sourceSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (sourceError || !sourceDDSubmission) {
      return res.status(404).json({ error: 'Source submission not found' });
    }

    if (sourceDDSubmission.archived_at) {
      return res.status(400).json({ error: 'Source submission is already archived' });
    }

    const sourceFormId = sourceDDSubmission.form_submission?.form_id;
    const organizationId = sourceDDSubmission.form_submission?.organization_id;

    const { data: forms, error: formsError } = await supabase
      .from('form')
      .select('id, name, fields, due_diligence_required')
      .eq('tenant_id', tenantCtx.tenantId)
      .in('id', [sourceFormId, targetFormId]);

    if (formsError) {
      console.error('[DD Swap Execute] Forms query error:', formsError);
      return res.status(500).json({ error: 'Failed to fetch form details' });
    }

    const sourceForm = forms.find(f => f.id === sourceFormId);
    const targetForm = forms.find(f => f.id === targetFormId);

    if (!sourceForm || !targetForm) {
      return res.status(404).json({ error: 'Source or target form not found' });
    }

    if (!targetForm.due_diligence_required) {
      return res.status(400).json({ error: 'Target form must have due diligence enabled' });
    }

    const { data: targetDDConfig } = await supabase
      .from('form_due_diligence_config')
      .select('workflow_stages')
      .eq('form_id', targetFormId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (!targetDDConfig) {
      return res.status(400).json({ error: 'Target form does not have a due diligence configuration' });
    }

    const sourceFields = sourceForm.fields || [];
    const targetFields = targetForm.fields || [];
    const sourceData = sourceDDSubmission.reviewed_form_values || 
                       sourceDDSubmission.original_form_values || 
                       sourceDDSubmission.form_submission?.submission_data || 
                       {};

    const sourceFieldsByLabel = {};
    sourceFields.forEach(field => {
      if (field.label) {
        sourceFieldsByLabel[field.label.toLowerCase().trim()] = field;
      }
    });

    const newFormValues = {};
    targetFields.forEach(targetField => {
      const targetLabel = (targetField.label || '').toLowerCase().trim();
      const matchingSourceField = sourceFieldsByLabel[targetLabel];
      
      if (matchingSourceField) {
        const sourceValue = sourceData[matchingSourceField.id] ?? sourceData[matchingSourceField.label];
        if (sourceValue !== undefined && sourceValue !== null) {
          newFormValues[targetField.id] = sourceValue;
        }
      }
    });

    const newFormSubmission = {
      form_id: targetFormId,
      tenant_id: tenantCtx.tenantId,
      organization_id: organizationId,
      submission_data: newFormValues,
      status: 'submitted',
      created_date: new Date().toISOString()
    };

    const { data: createdFormSubmission, error: fsInsertError } = await supabase
      .from('form_submission')
      .insert(newFormSubmission)
      .select()
      .single();

    if (fsInsertError) {
      console.error('[DD Swap Execute] Form submission insert error:', fsInsertError);
      return res.status(500).json({ error: 'Failed to create new form submission' });
    }

    const workflowStages = targetDDConfig?.workflow_stages || [];
    const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
    const initialStatus = initialStage?.id || 'new';

    const newDDRecord = {
      form_submission_id: createdFormSubmission.id,
      tenant_id: tenantCtx.tenantId,
      application_uid: `DD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      original_form_values: newFormValues,
      reviewed_form_values: newFormValues,
      field_review_status: {},
      workflow_status: initialStatus,
      swapped_from_submission_id: sourceDDSubmission.id,
      history_log: [{
        timestamp: new Date().toISOString(),
        event_type: 'swapped_from_form',
        user_email: member.email,
        details: {
          source_submission_id: sourceDDSubmission.id,
          source_form_id: sourceFormId,
          source_form_name: sourceForm.name,
          target_form_id: targetFormId,
          target_form_name: targetForm.name,
          fields_mapped: Object.keys(newFormValues).length
        }
      }]
    };

    const { data: createdDDSubmission, error: ddInsertError } = await supabase
      .from('form_submission_due_diligence')
      .insert(newDDRecord)
      .select()
      .single();

    if (ddInsertError) {
      console.error('[DD Swap Execute] DD submission insert error:', ddInsertError);
      await supabase.from('form_submission').delete().eq('id', createdFormSubmission.id);
      return res.status(500).json({ error: 'Failed to create new due diligence record' });
    }

    const sourceContractFields = sourceFields.filter(f => f.type === 'contact' && f.contract_form_id);
    const targetContractFields = targetFields.filter(f => f.type === 'contact' && f.contract_form_id);

    let contractsRelinked = 0;
    let contractsArchived = 0;

    if (contractAction === 'relink') {
      const { data: activeContracts } = await supabase
        .from('contract_instance')
        .select('id, form_id, source_contact_field_id, status')
        .eq('form_submission_id', sourceDDSubmission.form_submission_id)
        .eq('tenant_id', tenantCtx.tenantId)
        .in('status', ['pending', 'out_for_signing']);

      for (const contract of (activeContracts || [])) {
        const sourceContactField = sourceContractFields.find(f => f.id === contract.source_contact_field_id);
        
        if (sourceContactField) {
          const matchingTargetField = targetContractFields.find(
            tf => tf.contract_form_id === sourceContactField.contract_form_id
          );
          
          if (matchingTargetField) {
            const { error: relinkError } = await supabase
              .from('contract_instance')
              .update({ 
                form_submission_id: createdFormSubmission.id,
                source_contact_field_id: matchingTargetField.id,
                updated_at: new Date().toISOString()
              })
              .eq('id', contract.id);
            
            if (!relinkError) {
              contractsRelinked++;
            } else {
              console.error('[DD Swap Execute] Contract relink error:', relinkError);
            }
          } else {
            contractsArchived++;
          }
        }
      }
    }

    const archiveHistoryEntry = {
      timestamp: new Date().toISOString(),
      event_type: 'archived_due_to_swap',
      user_email: member.email,
      details: {
        target_submission_id: createdDDSubmission.id,
        target_form_id: targetFormId,
        target_form_name: targetForm.name,
        contracts_relinked: contractsRelinked,
        contracts_archived: contractsArchived
      }
    };

    const existingHistoryLog = sourceDDSubmission.history_log || [];

    const { error: archiveError } = await supabase
      .from('form_submission_due_diligence')
      .update({
        archived_at: new Date().toISOString(),
        archived_reason: `Swapped to form: ${targetForm.name}`,
        swapped_to_submission_id: createdDDSubmission.id,
        history_log: [...existingHistoryLog, archiveHistoryEntry],
        updated_at: new Date().toISOString()
      })
      .eq('id', sourceDDSubmission.id);

    if (archiveError) {
      console.error('[DD Swap Execute] Archive error:', archiveError);
    }

    let stageActionsResults = [];
    const hasStageActions = initialStage && (initialStage.actions || initialStage.stage_actions);
    if (hasStageActions) {
      try {
        const ddSubmissionData = {
          ...createdDDSubmission,
          form_submission_id: createdFormSubmission.id,
          form_id: targetFormId
        };
        const actionResults = await executeStageActions(
          initialStatus,
          ddSubmissionData,
          tenantCtx.tenantId,
          member.email
        );
        stageActionsResults = actionResults.stage_actions_results || [];
      } catch (actionError) {
        console.error('[DD Swap Execute] Stage actions error:', actionError);
      }
    }

    return res.status(201).json({
      success: true,
      newSubmission: {
        id: createdDDSubmission.id,
        formSubmissionId: createdFormSubmission.id,
        applicationUid: createdDDSubmission.application_uid
      },
      archivedSubmission: {
        id: sourceDDSubmission.id
      },
      summary: {
        fieldsMapped: Object.keys(newFormValues).length,
        contractsRelinked,
        contractsArchived,
        stageActionsExecuted: stageActionsResults.length
      }
    });

  } catch (error) {
    console.error('[DD Swap Execute] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

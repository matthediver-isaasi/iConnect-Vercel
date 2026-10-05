import { supabase } from '../_lib/database.js';
import { prepareSwapAnswers } from './_swapAnswers.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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
    const { sourceSubmissionId, targetFormId } = req.body;

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

    const { data: forms, error: formsError } = await supabase
      .from('form')
      .select('id, name, fields, pages, visibility_rules, due_diligence_required')
      .eq('tenant_id', tenantCtx.tenantId)
      .in('id', [sourceFormId, targetFormId]);

    if (formsError) {
      console.error('[DD Swap Preview] Forms query error:', formsError);
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
      .select('id')
      .eq('form_id', targetFormId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (!targetDDConfig) {
      return res.status(400).json({ error: 'Target form does not have a due diligence configuration' });
    }

    const sourceFields = sourceForm.fields || [];
    const targetFields = targetForm.fields || [];
    const prepared = await prepareSwapAnswers({
      db: supabase, tenantId: tenantCtx.tenantId, sourceDDSubmission, sourceForm, targetForm,
    });
    const { mapped: mappedFields, newEmpty: newEmptyFields, ignored: ignoredFields } = prepared.fieldMapping;

    const sourceContractFields = sourceFields.filter(f => f.type === 'contact' && f.contract_form_id);
    const targetContractFields = targetFields.filter(f => f.type === 'contact' && f.contract_form_id);

    const { data: activeContracts, error: contractsError } = await supabase
      .from('contract_instance')
      .select('id, form_id, source_contact_field_id, status, signers')
      .eq('form_submission_id', sourceDDSubmission.form_submission_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .in('status', ['pending', 'out_for_signing']);

    if (contractsError) {
      console.error('[DD Swap Preview] Contracts query error:', contractsError);
    }

    const contractMapping = [];
    const orphanedContracts = [];

    (activeContracts || []).forEach(contract => {
      const sourceContactField = sourceContractFields.find(f => f.id === contract.source_contact_field_id);
      
      if (sourceContactField) {
        const matchingTargetField = targetContractFields.find(
          tf => tf.contract_form_id === sourceContactField.contract_form_id
        );
        
        if (matchingTargetField) {
          contractMapping.push({
            contractId: contract.id,
            contractFormId: contract.form_id,
            status: contract.status,
            sourceContactFieldId: sourceContactField.id,
            sourceContactFieldLabel: sourceContactField.label,
            targetContactFieldId: matchingTargetField.id,
            targetContactFieldLabel: matchingTargetField.label,
            action: 'relink',
            signerCount: (contract.signers || []).length
          });
        } else {
          orphanedContracts.push({
            contractId: contract.id,
            contractFormId: contract.form_id,
            status: contract.status,
            sourceContactFieldId: sourceContactField.id,
            sourceContactFieldLabel: sourceContactField.label,
            action: 'archive',
            signerCount: (contract.signers || []).length
          });
        }
      }
    });

    return res.status(200).json({
      success: true,
      preview: {
        canSwap: prepared.canSwap,
        problems: prepared.problems,
        sourceForm: { id: sourceForm.id, name: sourceForm.name },
        targetForm: { id: targetForm.id, name: targetForm.name },
        fieldMapping: {
          ...prepared.fieldMapping
        },
        contractStatus: {
          willRelink: contractMapping,
          willArchive: orphanedContracts,
          totalActive: (activeContracts || []).length
        },
        summary: {
          fieldsToMap: mappedFields.length,
          fieldsWithValues: mappedFields.filter(f => f.hasValue).length,
          newEmptyFieldsCount: newEmptyFields.length,
          requiredEmptyFields: newEmptyFields.filter(f => f.required).length,
          ignoredFieldsCount: ignoredFields.length,
          ignoredFieldsWithValues: ignoredFields.filter(f => f.hasValue).length,
          contractsToRelink: contractMapping.length,
          contractsToArchive: orphanedContracts.length
        }
      }
    });

  } catch (error) {
    console.error('[DD Swap Preview] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

import { supabase } from '../_lib/database.js';
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
          organization_id
        )
      `)
      .eq('id', sourceSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (sourceError || !sourceDDSubmission) {
      return res.status(404).json({ error: 'Source submission not found' });
    }

    const sourceFormId = sourceDDSubmission.form_submission?.form_id;

    const { data: forms, error: formsError } = await supabase
      .from('form')
      .select('id, name, fields, due_diligence_required')
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
    const sourceData = sourceDDSubmission.reviewed_form_values || 
                       sourceDDSubmission.original_form_values || 
                       sourceDDSubmission.form_submission?.submission_data || 
                       {};

    const mappedFields = [];
    const newEmptyFields = [];
    const ignoredFields = [];

    const sourceFieldsByLabel = {};
    sourceFields.forEach(field => {
      if (field.label) {
        sourceFieldsByLabel[field.label.toLowerCase().trim()] = field;
      }
    });

    targetFields.forEach(targetField => {
      const targetLabel = (targetField.label || '').toLowerCase().trim();
      const matchingSourceField = sourceFieldsByLabel[targetLabel];
      
      if (matchingSourceField) {
        const sourceValue = sourceData[matchingSourceField.id] ?? sourceData[matchingSourceField.label];
        const hasValue = sourceValue !== undefined && sourceValue !== null && sourceValue !== '';
        mappedFields.push({
          targetFieldId: targetField.id,
          targetFieldLabel: targetField.label,
          targetFieldType: targetField.type,
          sourceFieldId: matchingSourceField.id,
          sourceFieldLabel: matchingSourceField.label,
          sourceFieldType: matchingSourceField.type,
          value: sourceValue,
          hasValue
        });
      } else {
        newEmptyFields.push({
          fieldId: targetField.id,
          fieldLabel: targetField.label,
          fieldType: targetField.type,
          required: targetField.required || false
        });
      }
    });

    const mappedSourceLabels = new Set(mappedFields.map(f => f.sourceFieldLabel?.toLowerCase().trim()));
    sourceFields.forEach(sourceField => {
      const sourceLabel = (sourceField.label || '').toLowerCase().trim();
      if (!mappedSourceLabels.has(sourceLabel)) {
        const sourceValue = sourceData[sourceField.id] ?? sourceData[sourceField.label];
        const hasValue = sourceValue !== undefined && sourceValue !== null && sourceValue !== '';
        ignoredFields.push({
          fieldId: sourceField.id,
          fieldLabel: sourceField.label,
          fieldType: sourceField.type,
          value: sourceValue,
          hasValue
        });
      }
    });

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
        sourceForm: { id: sourceForm.id, name: sourceForm.name },
        targetForm: { id: targetForm.id, name: targetForm.name },
        fieldMapping: {
          mapped: mappedFields,
          newEmpty: newEmptyFields,
          ignored: ignoredFields
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

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { formSubmissionId, fieldId, contractFormId, signer } = req.body;

  if (!formSubmissionId || !fieldId || !contractFormId || !signer?.email) {
    return res.status(400).json({ 
      error: 'Missing required fields: formSubmissionId, fieldId, contractFormId, and signer with email are required' 
    });
  }

  try {
    let existingContracts = [];
    
    const { data: fieldContracts, error: checkError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', formSubmissionId)
      .eq('source_contact_field_id', fieldId)
      .eq('tenant_id', tenantContext.tenantId);

    if (checkError) {
      console.error('[contracts/add-signer] Check error:', checkError);
    }

    existingContracts = fieldContracts || [];

    if (existingContracts.length === 0) {
      const { data: legacyCandidates } = await supabase
        .from('contract_instance')
        .select('*')
        .eq('form_submission_id', formSubmissionId)
        .eq('form_id', contractFormId)
        .is('source_contact_field_id', null)
        .eq('tenant_id', tenantContext.tenantId);

      if (legacyCandidates?.length === 1) {
        existingContracts = legacyCandidates;
      } else if (legacyCandidates?.length > 1) {
        return res.status(400).json({ 
          error: 'Cannot add signer: ambiguous legacy contract data. Please contact support.' 
        });
      }
    }

    const contractIds = existingContracts.map(c => c.id);
    
    let isFieldAlreadySigned = false;
    
    if (contractIds.length > 0) {
      const { data: submissions } = await supabase
        .from('form_submission')
        .select('id, data, contract_instance_id')
        .in('contract_instance_id', contractIds)
        .eq('tenant_id', tenantContext.tenantId);

      isFieldAlreadySigned = (submissions || []).some(sub => {
        if (!sub.data) return false;
        const email = sub.data.signer_email || sub.data.email;
        return !!email;
      });

      if (!isFieldAlreadySigned) {
        for (const contract of existingContracts) {
          const hasSignedSigner = (contract.signers || []).some(s => s.signed === true);
          if (hasSignedSigner) {
            isFieldAlreadySigned = true;
            break;
          }
        }
      }
    }

    if (isFieldAlreadySigned) {
      return res.status(400).json({ 
        error: 'This field has already been signed. Cannot add new signers.' 
      });
    }

    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('organization_id')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (subError || !formSubmission) {
      return res.status(404).json({ error: 'Form submission not found' });
    }

    const { data: contractForm, error: formError } = await supabase
      .from('form')
      .select('id, name, description, slug, contract_settings')
      .eq('id', contractFormId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (formError || !contractForm) {
      return res.status(404).json({ error: 'Contract form not found' });
    }

    const contractSettings = contractForm.contract_settings || {};
    const timeoutDays = contractSettings.timeout_days || 30;

    const newSigner = {
      first_name: signer.firstName,
      last_name: signer.lastName || '',
      email: signer.email,
      signed: false,
      added_at: new Date().toISOString()
    };

    let contractInstanceId;
    let existingContract = existingContracts?.[0];

    if (existingContract) {
      const updatedSigners = [...(existingContract.signers || []), newSigner];
      
      const { error: updateError } = await supabase
        .from('contract_instance')
        .update({ 
          signers: updatedSigners,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingContract.id);

      if (updateError) {
        console.error('[contracts/add-signer] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to add signer to contract' });
      }

      contractInstanceId = existingContract.id;
    } else {
      const { data: newContract, error: createError } = await supabase
        .from('contract_instance')
        .insert({
          tenant_id: tenantContext.tenantId,
          form_id: contractFormId,
          form_submission_id: formSubmissionId,
          organization_id: formSubmission.organization_id,
          source_contact_field_id: fieldId,
          signers: [newSigner],
          status: 'draft',
          timeout_days: timeoutDays
        })
        .select()
        .single();

      if (createError) {
        console.error('[contracts/add-signer] Create error:', createError);
        return res.status(500).json({ error: 'Failed to create contract instance' });
      }

      contractInstanceId = newContract.id;
    }

    console.log(`[contracts/add-signer] Added signer ${signer.email} to contract ${contractInstanceId} (not sent yet)`);

    return res.status(200).json({ 
      success: true, 
      message: 'Signer added successfully. Use the Send button to send them the contract.',
      contractInstanceId
    });

  } catch (error) {
    console.error('[contracts/add-signer] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext || !tenantContext.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { 
    formSubmissionId, 
    fieldId, 
    contractFormId, 
    signer, 
    submissionData, 
    overrideDate 
  } = req.body;

  if (!formSubmissionId || !fieldId || !contractFormId) {
    return res.status(400).json({ 
      error: 'Missing required fields: formSubmissionId, fieldId, and contractFormId are required' 
    });
  }

  if (!signer?.email) {
    return res.status(400).json({ error: 'Signer email is required' });
  }

  if (!submissionData || Object.keys(submissionData).length === 0) {
    return res.status(400).json({ error: 'Submission data is required for manual override' });
  }

  if (overrideDate) {
    const parsedDate = new Date(overrideDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid override date format' });
    }
  }

  try {
    const { data: existingContracts } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', formSubmissionId)
      .eq('source_contact_field_id', fieldId)
      .eq('tenant_id', tenantContext.tenantId);

    let contractInstance = existingContracts?.[0];

    if (!contractInstance) {
      const { data: legacyCandidates } = await supabase
        .from('contract_instance')
        .select('*')
        .eq('form_submission_id', formSubmissionId)
        .eq('form_id', contractFormId)
        .is('source_contact_field_id', null)
        .eq('tenant_id', tenantContext.tenantId);

      if (legacyCandidates?.length === 1) {
        contractInstance = legacyCandidates[0];
      } else if (legacyCandidates?.length > 1) {
        return res.status(400).json({ 
          error: 'Cannot override: ambiguous legacy contract data. Please contact support.' 
        });
      }
    }

    const contractIds = existingContracts?.map(c => c.id) || [];
    if (contractInstance && !contractIds.includes(contractInstance.id)) {
      contractIds.push(contractInstance.id);
    }

    if (contractIds.length > 0) {
      let fieldAlreadySigned = false;
      
      for (const cid of contractIds) {
        const { data: contract } = await supabase
          .from('contract_instance')
          .select('signers')
          .eq('id', cid)
          .single();
        
        const hasOtherSignedSigner = (contract?.signers || []).some(
          s => s.signed === true && (s.email || '').toLowerCase() !== signer.email.toLowerCase()
        );
        if (hasOtherSignedSigner) {
          fieldAlreadySigned = true;
          break;
        }
      }

      if (!fieldAlreadySigned) {
        const { data: submissions } = await supabase
          .from('form_submission')
          .select('id, submission_data')
          .in('contract_instance_id', contractIds)
          .eq('tenant_id', tenantContext.tenantId);

        fieldAlreadySigned = (submissions || []).some(sub => {
          if (!sub.submission_data) return false;
          const subEmail = (sub.submission_data.signer_email || sub.submission_data.email || '').toLowerCase();
          if (subEmail === signer.email.toLowerCase()) return false;
          return !!subEmail;
        });
      }

      if (fieldAlreadySigned) {
        return res.status(400).json({ error: 'This field has already been signed by another signer' });
      }
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

    const effectiveDate = overrideDate ? new Date(overrideDate) : new Date();
    const effectiveDateISO = effectiveDate.toISOString();

    const signerData = {
      first_name: signer.firstName || signer.first_name || '',
      last_name: signer.lastName || signer.last_name || '',
      email: signer.email,
      signed: true,
      signed_at: effectiveDateISO,
      added_at: effectiveDateISO,
      manual_override: true
    };

    if (!contractInstance) {
      const { data: newInstance, error: createError } = await supabase
        .from('contract_instance')
        .insert({
          tenant_id: tenantContext.tenantId,
          form_id: contractFormId,
          form_submission_id: formSubmissionId,
          organization_id: formSubmission.organization_id,
          source_contact_field_id: fieldId,
          signers: [signerData],
          status: 'received',
          timeout_days: timeoutDays,
          sent_at: effectiveDateISO,
          created_at: effectiveDateISO,
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError || !newInstance) {
        console.error('[contracts/manual-override] Create error:', createError);
        return res.status(500).json({ error: 'Failed to create contract instance' });
      }

      contractInstance = newInstance;
    } else {
      const existingSigners = contractInstance.signers || [];
      const signerIndex = existingSigners.findIndex(
        s => (s.email || '').toLowerCase() === signer.email.toLowerCase()
      );

      let updatedSigners;
      if (signerIndex >= 0) {
        updatedSigners = [...existingSigners];
        updatedSigners[signerIndex] = {
          ...updatedSigners[signerIndex],
          signed: true,
          signed_at: effectiveDateISO,
          manual_override: true
        };
      } else {
        updatedSigners = [...existingSigners, signerData];
      }

      const updateData = {
        signers: updatedSigners,
        status: 'received',
        updated_at: new Date().toISOString()
      };

      if (!contractInstance.sent_at) {
        updateData.sent_at = effectiveDateISO;
      }

      const { error: updateError } = await supabase
        .from('contract_instance')
        .update(updateData)
        .eq('id', contractInstance.id);

      if (updateError) {
        console.error('[contracts/manual-override] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update contract instance' });
      }
    }

    const fullSubmissionData = {
      ...submissionData,
      signer_email: signer.email,
      signer_first_name: signer.firstName || signer.first_name || '',
      signer_last_name: signer.lastName || signer.last_name || '',
      manual_override: true,
      override_date: effectiveDateISO
    };

    const { data: newSubmission, error: submissionError } = await supabase
      .from('form_submission')
      .insert({
        tenant_id: tenantContext.tenantId,
        form_id: contractFormId,
        organization_id: formSubmission.organization_id,
        contract_instance_id: contractInstance.id,
        submission_data: fullSubmissionData,
        created_date: effectiveDateISO,
        updated_date: new Date().toISOString(),
        status: 'submitted'
      })
      .select()
      .single();

    if (submissionError) {
      console.error('[contracts/manual-override] Submission create error:', submissionError);
      return res.status(500).json({ error: 'Failed to create contract submission' });
    }

    console.log(`[contracts/manual-override] Manual override completed for ${signer.email} on contract ${contractInstance.id}, submission ${newSubmission.id}`);

    return res.status(200).json({ 
      success: true,
      message: 'Manual contract override completed successfully',
      contractInstanceId: contractInstance.id,
      submissionId: newSubmission.id
    });

  } catch (error) {
    console.error('[contracts/manual-override] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

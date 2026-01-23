import { sendEmail } from '../_lib/emailService.js';
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

  if (!formSubmissionId || !fieldId || !contractFormId) {
    return res.status(400).json({ 
      error: 'Missing required fields: formSubmissionId, fieldId, and contractFormId are required' 
    });
  }

  if (!signer?.email) {
    return res.status(400).json({ error: 'Signer email is required' });
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
          error: 'Cannot send: ambiguous legacy contract data. Please contact support.' 
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
          .select('id, data')
          .in('contract_instance_id', contractIds)
          .eq('tenant_id', tenantContext.tenantId);

        fieldAlreadySigned = (submissions || []).some(sub => {
          if (!sub.data) return false;
          const subEmail = (sub.data.signer_email || sub.data.email || '').toLowerCase();
          if (subEmail === signer.email.toLowerCase()) return false;
          return Object.values(sub.data).some(v => 
            typeof v === 'object' && v?.type === 'signature'
          );
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

    const signerData = {
      first_name: signer.firstName || signer.first_name || '',
      last_name: signer.lastName || signer.last_name || '',
      email: signer.email,
      signed: false,
      added_at: new Date().toISOString()
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
          status: 'draft',
          timeout_days: timeoutDays,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError || !newInstance) {
        console.error('[contracts/send-original] Failed to create contract instance:', createError);
        return res.status(500).json({ error: 'Failed to create contract instance' });
      }

      contractInstance = newInstance;
    } else {
      const existingSigner = (contractInstance.signers || []).find(
        s => (s.email || '').toLowerCase() === signer.email.toLowerCase()
      );
      
      if (!existingSigner) {
        const updatedSigners = [...(contractInstance.signers || []), signerData];
        
        const { error: updateError } = await supabase
          .from('contract_instance')
          .update({ 
            signers: updatedSigners,
            updated_at: new Date().toISOString()
          })
          .eq('id', contractInstance.id);

        if (updateError) {
          console.error('[contracts/send-original] Failed to update signers:', updateError);
          return res.status(500).json({ error: 'Failed to update contract signers' });
        }
        
        contractInstance.signers = updatedSigners;
      }
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('*')
      .eq('id', tenantContext.tenantId)
      .single();

    const appUrl = `https://${tenant?.slug || 'app'}.iconn.app`;
    const signUrl = `${appUrl}/FormView?slug=${contractForm.slug}&signer_email=${encodeURIComponent(signer.email)}&signer_name=${encodeURIComponent(signerData.first_name || '')}&contract_instance=${contractInstance.id}`;

    const signerName = [signerData.first_name, signerData.last_name].filter(Boolean).join(' ') || 'Signer';

    let emailSubject = `Contract Ready for Signature: ${contractForm.name}`;
    let emailBody = `
      <p>Dear ${signerName},</p>
      <p>You have been requested to sign the following contract: <strong>${contractForm.name}</strong></p>
      ${contractForm.description ? `<p>${contractForm.description}</p>` : ''}
      <p>Please click the link below to review and sign the contract:</p>
      <p><a href="${signUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Review and Sign Contract</a></p>
      ${timeoutDays ? `<p>Please note: This contract will expire in ${timeoutDays} days.</p>` : ''}
      <p>Thank you.</p>
    `;

    const initialTemplateId = contractSettings.initial_email_template_id;
    if (initialTemplateId) {
      const { data: emailTemplate } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', initialTemplateId)
        .eq('tenant_id', tenantContext.tenantId)
        .single();

      if (emailTemplate) {
        const signerFirstName = signerData.first_name || '';
        const signerLastName = signerData.last_name || '';

        emailSubject = (emailTemplate.subject || emailSubject)
          .replace(/\{\{signer_name\}\}/gi, signerName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signUrl}">Click here to sign</a>`);

        emailBody = (emailTemplate.body || emailBody)
          .replace(/\{\{signer_name\}\}/gi, signerName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, contractForm.name)
          .replace(/\{\{signing_url\}\}/gi, signUrl)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signUrl}">Click here to sign</a>`);
      }
    }

    await sendEmail({
      to: signer.email,
      subject: emailSubject,
      html: emailBody,
      tenantId: tenantContext.tenantId,
      tenant
    });

    const updatedSigners = (contractInstance.signers || []).map(s => {
      if ((s.email || '').toLowerCase() === signer.email.toLowerCase()) {
        return {
          ...s,
          sent_at: s.sent_at || new Date().toISOString(),
          last_resent_at: new Date().toISOString()
        };
      }
      return s;
    });

    await supabase
      .from('contract_instance')
      .update({
        signers: updatedSigners,
        status: 'out_for_signing',
        sent_at: contractInstance.sent_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', contractInstance.id)
      .eq('tenant_id', tenantContext.tenantId);

    return res.status(200).json({
      success: true,
      contractInstanceId: contractInstance.id,
      message: 'Contract sent successfully'
    });

  } catch (error) {
    console.error('[contracts/send-original] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

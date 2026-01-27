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

  const { contractInstanceId, signerEmail } = req.body;

  if (!contractInstanceId) {
    return res.status(400).json({ error: 'Contract Instance ID is required' });
  }

  if (!signerEmail) {
    return res.status(400).json({ error: 'Signer email is required' });
  }

  try {
    const { data: contractInstance, error: instanceError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('id', contractInstanceId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (instanceError || !contractInstance) {
      console.error('[contracts/resend] Contract instance not found:', instanceError);
      return res.status(404).json({ error: 'Contract instance not found' });
    }

    const signer = (contractInstance.signers || []).find(
      s => (s.email || '').toLowerCase() === signerEmail.toLowerCase()
    );

    if (!signer) {
      return res.status(404).json({ error: 'Signer not found in this contract' });
    }

    if (signer.signed) {
      return res.status(400).json({ error: 'This signer has already signed the contract' });
    }

    let fieldContracts = [];
    if (contractInstance.source_contact_field_id) {
      const { data: contracts } = await supabase
        .from('contract_instance')
        .select('id, signers')
        .eq('form_submission_id', contractInstance.form_submission_id)
        .eq('source_contact_field_id', contractInstance.source_contact_field_id)
        .eq('tenant_id', tenantContext.tenantId);
      fieldContracts = contracts || [];
    } else if (contractInstance.form_submission_id) {
      const { data: legacyCandidates } = await supabase
        .from('contract_instance')
        .select('id, signers')
        .eq('form_submission_id', contractInstance.form_submission_id)
        .eq('form_id', contractInstance.form_id)
        .is('source_contact_field_id', null)
        .eq('tenant_id', tenantContext.tenantId);
      if (legacyCandidates?.length === 1) {
        fieldContracts = legacyCandidates;
      } else if (legacyCandidates?.length > 1) {
        return res.status(400).json({ error: 'Cannot resend: ambiguous legacy contract data. Please contact support.' });
      }
    }

    let fieldAlreadySigned = fieldContracts.some(c => 
      (c.signers || []).some(s => s.signed === true && s.email?.toLowerCase() !== signerEmail.toLowerCase())
    );

    if (!fieldAlreadySigned) {
      const contractIds = fieldContracts.map(c => c.id);
      if (contractIds.length > 0) {
        const { data: submissions } = await supabase
          .from('form_submission')
          .select('id, data')
          .in('contract_instance_id', contractIds)
          .eq('tenant_id', tenantContext.tenantId);

        fieldAlreadySigned = (submissions || []).some(sub => {
          if (!sub.data) return false;
          const subEmail = (sub.data.signer_email || sub.data.email || '').toLowerCase();
          if (subEmail === signerEmail.toLowerCase()) return false;
          return !!subEmail;
        });
      }
    }

    if (fieldAlreadySigned) {
      return res.status(400).json({ error: 'This field has already been signed by another signer' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, description, slug, contract_settings')
      .eq('id', contractInstance.form_id)
      .single();

    if (formError || !form) {
      console.error('[contracts/resend] Form not found:', formError);
      return res.status(404).json({ error: 'Contract form not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('*')
      .eq('id', tenantContext.tenantId)
      .single();

    const appUrl = `https://${tenant?.slug || 'app'}.iconn.app`;
    
    const signUrl = `${appUrl}/FormView?slug=${form.slug}&signer_email=${encodeURIComponent(signer.email)}&signer_name=${encodeURIComponent(signer.first_name || signer.name || '')}&contract_instance=${contractInstance.id}`;

    const signerName = [signer.first_name, signer.last_name].filter(Boolean).join(' ') || signer.name || 'Signer';

    let emailSubject = `Contract Ready for Signature: ${form.name}`;
    let emailBody = `
      <p>Dear ${signerName},</p>
      <p>You have been requested to sign the following contract: <strong>${form.name}</strong></p>
      ${form.description ? `<p>${form.description}</p>` : ''}
      <p>Please click the link below to review and sign the contract:</p>
      <p><a href="${signUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Review and Sign Contract</a></p>
      ${contractInstance.timeout_days ? `<p>Please note: This contract will expire in ${contractInstance.timeout_days} days from the original send date.</p>` : ''}
      <p>Thank you.</p>
    `;

    const contractSettings = form.contract_settings || {};
    const initialTemplateId = contractSettings.initial_email_template_id;

    if (initialTemplateId) {
      const { data: emailTemplate } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', initialTemplateId)
        .eq('tenant_id', tenantContext.tenantId)
        .single();

      if (emailTemplate) {
        const signerFirstName = signer.first_name || signer.name?.split(' ')[0] || '';
        const signerLastName = signer.last_name || signer.name?.split(' ').slice(1).join(' ') || '';

        emailSubject = (emailTemplate.subject || emailSubject)
          .replace(/\{\{signer_name\}\}/gi, signerName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, form.name)
          .replace(/\{\{sign_url\}\}/gi, signUrl)
          .replace(/\{\{signing_url\}\}/gi, signUrl)
          .replace(/\{\{sign_link\}\}/gi, `<a href="${signUrl}">Click here to sign</a>`)
          .replace(/\{\{signing_link\}\}/gi, `<a href="${signUrl}">Click here to sign</a>`);

        emailBody = (emailTemplate.body || emailBody)
          .replace(/\{\{signer_name\}\}/gi, signerName)
          .replace(/\{\{signer_first_name\}\}/gi, signerFirstName)
          .replace(/\{\{signer_last_name\}\}/gi, signerLastName)
          .replace(/\{\{signer_email\}\}/gi, signer.email)
          .replace(/\{\{contract_name\}\}/gi, form.name)
          .replace(/\{\{sign_url\}\}/gi, signUrl)
          .replace(/\{\{signing_url\}\}/gi, signUrl)
          .replace(/\{\{sign_link\}\}/gi, `<a href="${signUrl}">Click here to sign</a>`)
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
      if ((s.email || '').toLowerCase() === signerEmail.toLowerCase()) {
        return {
          ...s,
          sent_at: s.sent_at || new Date().toISOString(),
          last_resent_at: new Date().toISOString(),
          resend_count: (s.resend_count || 0) + 1
        };
      }
      return s;
    });

    const isSignerFirstSend = !signer.sent_at && !signer.last_resent_at;

    const updatePayload = {
      signers: updatedSigners,
      updated_at: new Date().toISOString()
    };

    if (isSignerFirstSend || contractInstance.status === 'draft') {
      updatePayload.status = 'out_for_signing';
      if (!contractInstance.sent_at) {
        updatePayload.sent_at = new Date().toISOString();
      }
    }

    await supabase
      .from('contract_instance')
      .update(updatePayload)
      .eq('id', contractInstanceId)
      .eq('tenant_id', tenantContext.tenantId);

    console.log(`[contracts/resend] Sent contract ${contractInstanceId} to ${signer.email}`);

    return res.status(200).json({
      success: true,
      message: `Contract resent to ${signer.email}`
    });

  } catch (error) {
    console.error('[contracts/resend] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

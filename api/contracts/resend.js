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

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, description, slug')
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

    const appUrl = process.env.APP_URL || `https://${tenant?.slug || 'app'}.replit.app`;
    
    const signUrl = `${appUrl}/form/${form.slug}?signer_email=${encodeURIComponent(signer.email)}&signer_name=${encodeURIComponent(signer.first_name || signer.name || '')}&contract_instance=${contractInstance.id}`;

    const signerName = [signer.first_name, signer.last_name].filter(Boolean).join(' ') || signer.name || 'Signer';

    const emailSubject = `Reminder: Contract Ready for Signature - ${form.name}`;
    const emailBody = `
      <p>Dear ${signerName},</p>
      <p>This is a reminder that you have been requested to sign the following contract: <strong>${form.name}</strong></p>
      ${form.description ? `<p>${form.description}</p>` : ''}
      <p>Please click the link below to review and sign the contract:</p>
      <p><a href="${signUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Review and Sign Contract</a></p>
      ${contractInstance.timeout_days ? `<p>Please note: This contract will expire in ${contractInstance.timeout_days} days from the original send date.</p>` : ''}
      <p>Thank you.</p>
    `;

    await sendEmail({
      to: signer.email,
      subject: emailSubject,
      body: emailBody,
      tenantId: tenantContext.tenantId,
      tenant
    });

    const updatedSigners = (contractInstance.signers || []).map(s => {
      if ((s.email || '').toLowerCase() === signerEmail.toLowerCase()) {
        return {
          ...s,
          last_resent_at: new Date().toISOString(),
          resend_count: (s.resend_count || 0) + 1
        };
      }
      return s;
    });

    await supabase
      .from('contract_instance')
      .update({
        signers: updatedSigners,
        updated_at: new Date().toISOString()
      })
      .eq('id', contractInstanceId)
      .eq('tenant_id', tenantContext.tenantId);

    console.log(`[contracts/resend] Resent contract ${contractInstanceId} to ${signer.email}`);

    return res.status(200).json({
      success: true,
      message: `Contract resent to ${signer.email}`
    });

  } catch (error) {
    console.error('[contracts/resend] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

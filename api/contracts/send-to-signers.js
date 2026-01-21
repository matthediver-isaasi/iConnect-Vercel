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

  const { formId } = req.body;

  if (!formId) {
    return res.status(400).json({ error: 'Form ID is required' });
  }

  try {
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('*')
      .eq('id', formId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (formError || !form) {
      return res.status(404).json({ error: 'Contract form not found' });
    }

    if (!form.is_contract) {
      return res.status(400).json({ error: 'This form is not a contract' });
    }

    const signers = form.contract_settings?.signers || [];
    
    if (signers.length === 0) {
      return res.status(400).json({ error: 'No signers configured for this contract' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('*')
      .eq('id', tenantContext.tenantId)
      .single();

    const appUrl = process.env.APP_URL || `https://${tenant?.slug || 'app'}.replit.app`;
    let sentCount = 0;
    let failedCount = 0;
    const results = [];

    for (const signer of signers) {
      if (!signer.email) {
        results.push({ signer: signer.name, status: 'skipped', reason: 'No email address' });
        continue;
      }

      const signUrl = `${appUrl}/form/${form.slug}?signer_email=${encodeURIComponent(signer.email)}&signer_name=${encodeURIComponent(signer.name || '')}`;

      const emailSubject = `Contract Ready for Signature: ${form.name}`;
      const emailBody = `
        <p>Dear ${signer.name || 'Signer'},</p>
        <p>You have been requested to sign the following contract: <strong>${form.name}</strong></p>
        ${form.description ? `<p>${form.description}</p>` : ''}
        <p>Please click the link below to review and sign the contract:</p>
        <p><a href="${signUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">Review and Sign Contract</a></p>
        ${form.contract_settings?.timeout_days ? `<p>Please note: This contract will expire in ${form.contract_settings.timeout_days} days.</p>` : ''}
        <p>Thank you.</p>
      `;

      try {
        await sendEmail({
          to: signer.email,
          subject: emailSubject,
          body: emailBody,
          tenantId: tenantContext.tenantId,
          tenant
        });

        sentCount++;
        results.push({ signer: signer.name, email: signer.email, status: 'sent' });
        console.log(`[contracts/send-to-signers] Sent contract ${formId} to ${signer.email}`);
      } catch (emailError) {
        failedCount++;
        results.push({ signer: signer.name, email: signer.email, status: 'failed', error: emailError.message });
        console.error(`[contracts/send-to-signers] Failed to send to ${signer.email}:`, emailError);
      }
    }

    await supabase
      .from('form')
      .update({
        contract_settings: {
          ...form.contract_settings,
          sent_at: new Date().toISOString(),
          status: 'out_for_signing'
        }
      })
      .eq('id', formId)
      .eq('tenant_id', tenantContext.tenantId);

    return res.status(200).json({
      success: true,
      sent: sentCount,
      failed: failedCount,
      results
    });

  } catch (error) {
    console.error('[contracts/send-to-signers] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

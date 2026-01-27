import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generateToken(contractId, round, secret) {
  const data = `${contractId}:${round}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function verifyToken(contractId, round, token, secret) {
  const expected = generateToken(contractId, round, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { contract_id, token, tenant, round, first_name, last_name, email } = req.body;

    if (!contract_id || !token) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    let tenantId = null;
    if (tenant) {
      const { data: tenantData, error: tenantError } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenant)
        .single();

      if (tenantError || !tenantData) {
        return res.status(400).json({ error: 'Invalid tenant' });
      }
      tenantId = tenantData.id;
    }

    const query = supabase
      .from('contract_instance')
      .select('*')
      .eq('id', contract_id);

    if (tenantId) {
      query.eq('tenant_id', tenantId);
    }

    const { data: contractInstance, error: contractError } = await query.single();

    if (contractError || !contractInstance) {
      console.error('[Alternative Signer] Contract not found:', contractError);
      return res.status(404).json({ error: 'Contract not found' });
    }

    const secret = process.env.ALTERNATIVE_SIGNER_TOKEN_SECRET || process.env.SESSION_SECRET || 'default-secret';
    const currentRound = contractInstance.timeout_notification_round || 0;
    const tokenRound = round !== undefined ? parseInt(round, 10) : currentRound;
    
    const isValid = verifyToken(contract_id, tokenRound.toString(), token, secret);
    
    if (!isValid) {
      console.log('[Alternative Signer] Token verification failed for contract:', contract_id, 'round:', tokenRound);
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    if (tokenRound !== currentRound) {
      return res.status(400).json({ error: 'This link has expired. A newer link may have been sent.' });
    }

    if (contractInstance.status === 'received') {
      return res.status(400).json({ error: 'This contract has already been signed' });
    }

    const existingSigners = contractInstance.signers || [];
    const newSigner = {
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      email: email.trim().toLowerCase(),
      status: 'pending',
      added_at: new Date().toISOString(),
      added_via: 'alternative_signer_form',
      round: (contractInstance.timeout_notification_round || 0) + 1
    };

    const emailExists = existingSigners.some(s => 
      s.email?.toLowerCase() === newSigner.email.toLowerCase() && 
      s.status !== 'expired'
    );

    if (emailExists) {
      return res.status(400).json({ error: 'This email is already a signer on this contract' });
    }

    const updatedSigners = [...existingSigners, newSigner];

    const { error: updateError } = await supabase
      .from('contract_instance')
      .update({
        signers: updatedSigners,
        status: 'pending',
        timeout_notification_round: (contractInstance.timeout_notification_round || 0) + 1,
        timeout_notification_sent_at: null,
        sent_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', contract_id);

    if (updateError) {
      console.error('[Alternative Signer] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to add signer' });
    }

    console.log('[Alternative Signer] New signer added:', {
      contract_id,
      new_signer: newSigner.email,
      round: newSigner.round
    });

    try {
      const { data: contractForm, error: formError } = await supabase
        .from('form')
        .select('id, name, slug, contract_settings')
        .eq('id', contractInstance.form_id)
        .single();

      if (formError || !contractForm) {
        console.warn('[Alternative Signer] Contract form not found, skipping auto-send');
        return res.status(200).json({ 
          success: true, 
          message: 'Signer added successfully. Contract will be sent manually.',
          signer_added: true,
          auto_sent: false
        });
      }

      const { data: orgData } = await supabase
        .from('organization')
        .select('name')
        .eq('id', contractInstance.organization_id)
        .single();

      const initialEmailTemplateId = contractForm.contract_settings?.initial_email_template_id || 
                                      contractInstance.initial_email_template_id;

      if (!initialEmailTemplateId) {
        console.log('[Alternative Signer] No email template configured, signer added but not sent');
        return res.status(200).json({ 
          success: true, 
          message: 'Signer added. No email template configured - contract needs manual send.',
          signer_added: true,
          auto_sent: false
        });
      }

      const { data: emailTemplate, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', initialEmailTemplateId)
        .single();

      if (templateError || !emailTemplate) {
        console.warn('[Alternative Signer] Email template not found:', initialEmailTemplateId);
        return res.status(200).json({ 
          success: true, 
          message: 'Signer added but email template not found.',
          signer_added: true,
          auto_sent: false
        });
      }

      const { data: tenant } = await supabase
        .from('tenant')
        .select('slug, name, contact_email, sender_email, sender_name')
        .eq('id', contractInstance.tenant_id)
        .single();

      const tenantSlug = tenant?.slug || 'app';
      const signingUrl = `https://${tenantSlug}.iconn.app/sign-contract/${contractInstance.id}?email=${encodeURIComponent(newSigner.email)}`;

      const placeholders = {
        first_name: newSigner.first_name,
        last_name: newSigner.last_name,
        email: newSigner.email,
        contract_name: contractForm.name,
        organization_name: orgData?.name || '',
        sign_url: signingUrl,
        signing_url: signingUrl,
        sign_link: `<a href="${signingUrl}">Click here to sign</a>`,
        signing_link: `<a href="${signingUrl}">Click here to sign</a>`,
        tenant_name: tenant?.name || ''
      };

      let emailBody = emailTemplate.body || '';
      let emailSubject = emailTemplate.subject || 'Contract for Signing';

      for (const [key, value] of Object.entries(placeholders)) {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
        emailBody = emailBody.replace(regex, value || '');
        emailSubject = emailSubject.replace(regex, value || '');
      }

      const senderEmail = tenant?.sender_email || tenant?.contact_email || 'noreply@iconn.app';
      const senderName = tenant?.sender_name || tenant?.name || 'Contract Signing';

      const emailPayload = {
        to: newSigner.email,
        from: `${senderName} <${senderEmail}>`,
        subject: emailSubject,
        html: emailBody,
        tenant_id: contractInstance.tenant_id
      };

      console.log('[Alternative Signer] Sending contract email to:', newSigner.email);

      const emailResponse = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/api/_lib/sendEmail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailPayload)
      });

      const { error: sentAtUpdateError } = await supabase
        .from('contract_instance')
        .update({
          sent_at: new Date().toISOString(),
          status: 'out_for_signing'
        })
        .eq('id', contract_id);

      if (sentAtUpdateError) {
        console.warn('[Alternative Signer] Failed to update sent_at:', sentAtUpdateError);
      }

      return res.status(200).json({ 
        success: true, 
        message: 'New signer added and contract sent for signing.',
        signer_added: true,
        auto_sent: true
      });

    } catch (sendError) {
      console.error('[Alternative Signer] Error sending contract:', sendError);
      return res.status(200).json({ 
        success: true, 
        message: 'Signer added but failed to auto-send. Contract needs manual send.',
        signer_added: true,
        auto_sent: false
      });
    }

  } catch (error) {
    console.error('[Alternative Signer] Submit error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

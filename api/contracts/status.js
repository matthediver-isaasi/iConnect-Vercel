import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { formId } = req.query;

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

    const { data: submissions, error: subError } = await supabase
      .from('form_submission')
      .select('*')
      .eq('form_id', formId);

    if (subError) {
      console.error('[contracts/status] Submissions fetch error:', subError);
    }

    const signers = form.contract_settings?.signers || [];
    const timeoutDays = form.contract_settings?.timeout_days || 30;
    const sentAt = form.contract_settings?.sent_at;

    const signedSigners = [];
    const unsignedSigners = [];

    for (const signer of signers) {
      const signerSubmission = (submissions || []).find(sub => {
        if (!sub.submission_data) return false;
        const subEmail = (sub.submission_data.signer_email || sub.submission_data.email || '').toLowerCase();
        const hasSignature = Object.values(sub.submission_data).some(v => 
          typeof v === 'object' && v?.type === 'signature'
        );
        return subEmail === (signer.email || '').toLowerCase() && hasSignature;
      });

      if (signerSubmission) {
        signedSigners.push({
          ...signer,
          signed_at: signerSubmission.created_date,
          submission_id: signerSubmission.id
        });
      } else {
        unsignedSigners.push(signer);
      }
    }

    let status = 'draft';
    let expiryDate = null;

    if (sentAt) {
      expiryDate = new Date(sentAt);
      expiryDate.setDate(expiryDate.getDate() + timeoutDays);

      if (signedSigners.length === signers.length && signers.length > 0) {
        status = 'received';
      } else if (new Date() > expiryDate) {
        status = 'expired';
      } else {
        status = 'out_for_signing';
      }
    }

    return res.status(200).json({
      formId: form.id,
      name: form.name,
      status,
      sentAt,
      expiryDate: expiryDate?.toISOString() || null,
      timeoutDays,
      totalSigners: signers.length,
      signedCount: signedSigners.length,
      signedSigners,
      unsignedSigners,
      isComplete: signedSigners.length === signers.length && signers.length > 0
    });

  } catch (error) {
    console.error('[contracts/status] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

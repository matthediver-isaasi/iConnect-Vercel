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

  const { organizationId } = req.query;

  if (!organizationId) {
    return res.status(400).json({ error: 'Organization ID is required' });
  }

  try {
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select('id, name')
      .eq('id', organizationId)
      .eq('tenant_id', tenantContext.tenantId)
      .single();

    if (orgError || !org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { data: contractForms, error: formsError } = await supabase
      .from('form')
      .select('*')
      .eq('is_contract', true)
      .eq('tenant_id', tenantContext.tenantId)
      .filter('contract_settings->organization_id', 'eq', organizationId);

    if (formsError) {
      console.error('[contracts/by-organization] Forms fetch error:', formsError);
      return res.status(500).json({ error: 'Failed to fetch contracts' });
    }

    if (!contractForms || contractForms.length === 0) {
      return res.status(200).json({ contracts: [] });
    }

    const formIds = contractForms.map(f => f.id);
    
    const { data: submissions, error: subError } = await supabase
      .from('form_submission')
      .select('id, form_id, data, created_at')
      .in('form_id', formIds);

    if (subError) {
      console.error('[contracts/by-organization] Submissions fetch error:', subError);
    }

    const submissionsByForm = {};
    (submissions || []).forEach(sub => {
      if (!submissionsByForm[sub.form_id]) {
        submissionsByForm[sub.form_id] = [];
      }
      submissionsByForm[sub.form_id].push(sub);
    });

    const contractsWithStatus = contractForms.map(form => {
      const formSubmissions = submissionsByForm[form.id] || [];
      const contractSettings = form.contract_settings || {};
      const signers = contractSettings.signers || [];
      const sentAt = contractSettings.sent_at;
      const timeoutDays = contractSettings.timeout_days || 30;

      let status = 'draft';
      let expiryDate = null;
      const signedSigners = [];
      const unsignedSigners = [];

      if (sentAt) {
        expiryDate = new Date(sentAt);
        expiryDate.setDate(expiryDate.getDate() + timeoutDays);

        for (const signer of signers) {
          const signerSubmission = formSubmissions.find(sub => {
            if (!sub.data) return false;
            const subEmail = (sub.data.signer_email || sub.data.email || '').toLowerCase();
            const hasSignature = Object.values(sub.data).some(v => 
              typeof v === 'object' && v?.type === 'signature'
            );
            return subEmail === (signer.email || '').toLowerCase() && hasSignature;
          });

          if (signerSubmission) {
            signedSigners.push({
              ...signer,
              signed_at: signerSubmission.created_at
            });
          } else {
            unsignedSigners.push(signer);
          }
        }

        if (signedSigners.length === signers.length && signers.length > 0) {
          status = 'received';
        } else if (new Date() > expiryDate) {
          status = 'expired';
        } else {
          status = 'out_for_signing';
        }
      }

      return {
        id: form.id,
        name: form.name,
        description: form.description,
        slug: form.slug,
        status,
        sentAt,
        expiryDate: expiryDate?.toISOString() || null,
        timeoutDays,
        fieldsCount: form.fields?.length || 0,
        signedCount: signedSigners.length,
        totalSigners: signers.length,
        signedSigners,
        unsignedSigners,
        lastUpdated: formSubmissions.length > 0 
          ? formSubmissions[formSubmissions.length - 1].created_at 
          : form.updated_at || form.created_at
      };
    });

    return res.status(200).json({ contracts: contractsWithStatus });

  } catch (error) {
    console.error('[contracts/by-organization] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

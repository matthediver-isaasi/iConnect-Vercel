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

  const { formSubmissionId } = req.query;

  if (!formSubmissionId) {
    return res.status(400).json({ error: 'Form Submission ID is required' });
  }

  try {
    const { data: contractInstances, error: instancesError } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantContext.tenantId)
      .order('created_at', { ascending: false });

    if (instancesError) {
      console.error('[contracts/by-submission] Instances fetch error:', instancesError);
      if (instancesError.code === '42P01' || instancesError.code === 'PGRST200') {
        return res.status(200).json({ contracts: [], message: 'Contract instances not yet set up' });
      }
      return res.status(500).json({ error: 'Failed to fetch contracts' });
    }

    if (!contractInstances || contractInstances.length === 0) {
      return res.status(200).json({ contracts: [] });
    }

    const formIds = [...new Set(contractInstances.map(i => i.form_id).filter(Boolean))];
    let formsMap = {};
    
    if (formIds.length > 0) {
      const { data: forms } = await supabase
        .from('form')
        .select('id, name, description, slug, fields')
        .in('id', formIds);
      
      (forms || []).forEach(f => {
        formsMap[f.id] = f;
      });
    }

    const instanceIds = contractInstances.map(i => i.id);
    
    const { data: submissions, error: subError } = await supabase
      .from('form_submission')
      .select('id, form_id, submission_data, created_date, contract_instance_id')
      .in('contract_instance_id', instanceIds);

    if (subError) {
      console.error('[contracts/by-submission] Submissions fetch error:', subError);
    }

    const submissionsByInstance = {};
    (submissions || []).forEach(sub => {
      if (sub.contract_instance_id) {
        if (!submissionsByInstance[sub.contract_instance_id]) {
          submissionsByInstance[sub.contract_instance_id] = [];
        }
        submissionsByInstance[sub.contract_instance_id].push(sub);
      }
    });

    const contractsWithStatus = contractInstances.map(instance => {
      const instanceSubmissions = submissionsByInstance[instance.id] || [];
      const signers = instance.signers || [];
      const sentAt = instance.sent_at;
      const timeoutDays = instance.timeout_days || 30;
      const form = formsMap[instance.form_id] || null;

      let status = instance.status || 'pending';
      let expiryDate = null;
      const signedSigners = [];
      const unsignedSigners = [];

      if (sentAt) {
        expiryDate = new Date(sentAt);
        expiryDate.setDate(expiryDate.getDate() + timeoutDays);

        for (const signer of signers) {
          if (signer.signed) {
            signedSigners.push(signer);
          } else {
            const signerSubmission = instanceSubmissions.find(sub => {
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
                signed: true,
                signed_at: signerSubmission.created_date
              });
            } else {
              unsignedSigners.push(signer);
            }
          }
        }

        if (signedSigners.length === signers.length && signers.length > 0) {
          status = 'received';
        } else if (new Date() > expiryDate && status !== 'received') {
          status = 'expired';
        } else if (status === 'pending') {
          status = 'out_for_signing';
        }
      }

      return {
        id: instance.id,
        formId: instance.form_id,
        sourceContactFieldId: instance.source_contact_field_id,
        name: form?.name || 'Unknown Contract',
        description: form?.description,
        slug: form?.slug,
        status,
        sentAt,
        expiryDate: expiryDate?.toISOString() || null,
        timeoutDays,
        fieldsCount: form?.fields?.length || 0,
        signedCount: signedSigners.length,
        totalSigners: signers.length,
        signedSigners,
        unsignedSigners,
        signers,
        createdAt: instance.created_at,
        lastUpdated: instanceSubmissions.length > 0 
          ? instanceSubmissions[instanceSubmissions.length - 1].created_at 
          : instance.created_at
      };
    });

    return res.status(200).json({ contracts: contractsWithStatus });

  } catch (error) {
    console.error('[contracts/by-submission] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

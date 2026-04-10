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

  const { formSubmissionId, fieldId, contractFormId, signerEmail } = req.body;

  if (!formSubmissionId || !fieldId || !contractFormId || !signerEmail) {
    return res.status(400).json({
      error: 'Missing required fields: formSubmissionId, fieldId, contractFormId, and signerEmail are required'
    });
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
          error: 'Cannot demote: ambiguous legacy contract data. Please contact support.'
        });
      }
    }

    if (!contractInstance) {
      return res.status(404).json({ error: 'Contract instance not found' });
    }

    const signers = contractInstance.signers || [];
    const signerIndex = signers.findIndex(
      s => (s.email || '').toLowerCase() === signerEmail.toLowerCase()
    );

    if (signerIndex === -1) {
      return res.status(404).json({ error: 'Signer not found in contract instance' });
    }

    const targetSigner = signers[signerIndex];
    if (!targetSigner.signed) {
      return res.status(400).json({ error: 'This signer is not currently a winner' });
    }

    const updatedSigners = [...signers];
    updatedSigners[signerIndex] = {
      ...updatedSigners[signerIndex],
      signed: false,
      signed_at: null,
      demoted_at: new Date().toISOString()
    };

    const hasSentSigners = updatedSigners.some(s => s.sent_at || s.last_resent_at || s.added_at);
    const newStatus = hasSentSigners ? 'out_for_signing' : 'pending';

    const { error: updateError } = await supabase
      .from('contract_instance')
      .update({
        signers: updatedSigners,
        status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', contractInstance.id)
      .eq('tenant_id', tenantContext.tenantId);

    if (updateError) {
      console.error('[contracts/demote-winner] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to demote winner' });
    }

    console.log(`[contracts/demote-winner] Demoted winner ${signerEmail} on contract ${contractInstance.id}, status changed to ${newStatus}`);

    return res.status(200).json({
      success: true,
      message: 'Winner demoted successfully. You can now add a new recipient.',
      contractInstanceId: contractInstance.id
    });

  } catch (error) {
    console.error('[contracts/demote-winner] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

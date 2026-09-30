import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  const { id: ddSubmissionId } = req.query;

  if (!ddSubmissionId) {
    return res.status(400).json({ error: 'Submission ID is required' });
  }

  try {
    console.log('[DD Delete] Starting cascade deletion for:', ddSubmissionId);

    const { data: ddSubmission, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('*, form_submission_id')
      .eq('id', ddSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (ddError || !ddSubmission) {
      console.error('[DD Delete] Submission not found:', ddError);
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    const formSubmissionId = ddSubmission.form_submission_id;
    const deletionResults = {
      dd_submission: false,
      form_submission: false,
      contract_instances: 0,
      contract_reminder_logs: 0,
      submission_documents: 0
    };

    if (formSubmissionId) {
      const { error: docError, count: docCount } = await supabase
        .from('submission_document')
        .delete()
        .eq('form_submission_id', formSubmissionId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (docError) {
        console.warn('[DD Delete] Error deleting submission documents:', docError);
      } else {
        deletionResults.submission_documents = docCount || 0;
        console.log('[DD Delete] Deleted submission documents:', docCount);
      }
    }

    const { data: contractInstances } = await supabase
      .from('contract_instance')
      .select('id')
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (contractInstances && contractInstances.length > 0) {
      const contractInstanceIds = contractInstances.map(c => c.id);
      console.log('[DD Delete] Found contract instances to delete:', contractInstanceIds.length);

      const { error: reminderLogError, count: reminderCount } = await supabase
        .from('contract_reminder_log')
        .delete()
        .in('contract_instance_id', contractInstanceIds)
        .eq('tenant_id', tenantCtx.tenantId);

      if (reminderLogError) {
        console.warn('[DD Delete] Error deleting reminder logs:', reminderLogError);
      } else {
        deletionResults.contract_reminder_logs = reminderCount || 0;
        console.log('[DD Delete] Deleted reminder logs:', reminderCount);
      }

      const { error: contractError, count: contractCount } = await supabase
        .from('contract_instance')
        .delete()
        .eq('form_submission_id', formSubmissionId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (contractError) {
        console.error('[DD Delete] Error deleting contract instances:', contractError);
      } else {
        deletionResults.contract_instances = contractCount || 0;
        console.log('[DD Delete] Deleted contract instances:', contractCount);
      }
    }

    const { error: ddDeleteError } = await supabase
      .from('form_submission_due_diligence')
      .delete()
      .eq('id', ddSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (ddDeleteError) {
      console.error('[DD Delete] Error deleting DD submission:', ddDeleteError);
      return res.status(500).json({ error: 'Failed to delete due diligence submission' });
    }
    deletionResults.dd_submission = true;
    console.log('[DD Delete] Deleted DD submission');

    if (formSubmissionId) {
      const { error: formSubError } = await supabase
        .from('form_submission')
        .delete()
        .eq('id', formSubmissionId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (formSubError) {
        console.warn('[DD Delete] Error deleting form submission:', formSubError);
      } else {
        deletionResults.form_submission = true;
        console.log('[DD Delete] Deleted form submission');
      }
    }

    console.log('[DD Delete] Cascade deletion complete:', deletionResults);

    return res.status(200).json({
      success: true,
      message: 'Due diligence submission and related data deleted successfully',
      deleted: deletionResults
    });

  } catch (error) {
    console.error('[DD Delete] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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

  try {
    const {
      submissionId,
      reviewedFormValues,
      fieldReviewStatus,
      fieldNotes,
      staticQuestionResponses,
      staticQuestionNotes,
      notes
      // NOTE: workflowStatus is NOT accepted here - use update-status endpoint for status changes
    } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    // Get current submission state with tenant isolation
    const { data: ddSubmission, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('*')
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (ddError || !ddSubmission) {
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    const updateData = {
      updated_at: new Date().toISOString(),
      reviewed_by: member.email,
      reviewed_date: new Date().toISOString()
    };

    if (reviewedFormValues !== undefined) {
      updateData.reviewed_form_values = reviewedFormValues;
    }
    if (fieldReviewStatus !== undefined) {
      updateData.field_review_status = fieldReviewStatus;
    }
    if (fieldNotes !== undefined) {
      updateData.field_notes = fieldNotes;
    }
    if (staticQuestionResponses !== undefined) {
      updateData.static_question_responses = staticQuestionResponses;
    }
    if (staticQuestionNotes !== undefined) {
      updateData.static_question_notes = staticQuestionNotes;
    }
    if (notes !== undefined) {
      updateData.notes = notes;
    }
    // workflowStatus is intentionally NOT handled here to prevent bypassing stage validation

    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update(updateData)
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[DD Review] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to save review' });
    }

    // Add to history log
    await addHistoryLogEntry(submissionId, tenantCtx.tenantId, 'submission_updated', member.email, {
      fields_updated: Object.keys(updateData).filter(k => k !== 'updated_at')
    });

    return res.status(200).json({
      success: true,
      message: 'Review saved successfully'
    });

  } catch (error) {
    console.error('[DD Review] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function addHistoryLogEntry(submissionId, tenantId, eventType, userEmail, details) {
  try {
    const { data: submission } = await supabase
      .from('form_submission_due_diligence')
      .select('history_log')
      .eq('id', submissionId)
      .eq('tenant_id', tenantId)
      .single();

    const historyLog = submission?.history_log || [];
    historyLog.push({
      timestamp: new Date().toISOString(),
      event_type: eventType,
      user_email: userEmail,
      details
    });

    await supabase
      .from('form_submission_due_diligence')
      .update({ history_log: historyLog })
      .eq('id', submissionId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[DD History] Failed to add log entry:', err);
  }
}

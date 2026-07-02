import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { calculateTrafficLightScore, calculateDynamicScore, determineRiskLevel } from './_scoring.js';

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
    const { submissionId, formValues, scoringApproach } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    // Get the due diligence submission record with tenant isolation
    const { data: ddSubmission, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('*, form_submission:form_submission_id(id, form_id)')
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (ddError || !ddSubmission) {
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    // Get the form's due diligence config with tenant isolation
    const { data: ddConfig, error: configError } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', ddSubmission.form_submission.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (configError || !ddConfig) {
      return res.status(404).json({ error: 'Due diligence config not found for this form' });
    }

    const approach = scoringApproach || ddConfig.scoring_approach || 'dynamic';
    const dataToScore = formValues || ddSubmission.reviewed_form_values || {};
    
    let result;
    
    if (approach === 'static_traffic_light') {
      result = calculateTrafficLightScore(
        ddSubmission.static_question_responses || {},
        ddConfig.static_questions || [],
        ddSubmission.static_question_not_applicable || {}
      );
    } else {
      result = calculateDynamicScore(
        dataToScore,
        ddConfig.scoring_rules || {}
      );
    }

    // Determine risk level based on score and thresholds
    const riskLevel = determineRiskLevel(result.score, ddConfig.custom_risk_levels || []);

    // Update the due diligence submission with the score (with tenant isolation)
    const { error: updateError } = await supabase
      .from('form_submission_due_diligence')
      .update({
        due_diligence_score: result.score,
        risk_level: riskLevel,
        updated_at: new Date().toISOString()
      })
      .eq('id', submissionId)
      .eq('tenant_id', tenantCtx.tenantId);

    if (updateError) {
      console.error('[DD Score] Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update score' });
    }

    // Add to history log
    await addHistoryLogEntry(submissionId, tenantCtx.tenantId, 'score_calculated', member.email, {
      score: result.score,
      risk_level: riskLevel,
      scoring_approach: approach,
      breakdown: result.breakdown
    });

    return res.status(200).json({
      success: true,
      score: result.score,
      risk_level: riskLevel,
      breakdown: result.breakdown,
      scoring_approach: approach
    });

  } catch (error) {
    console.error('[DD Score] Error:', error);
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

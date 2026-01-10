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
        ddConfig.static_questions || []
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

function calculateDynamicScore(formValues, scoringRules) {
  const rules = scoringRules.rules || [];
  const breakdown = [];
  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const rule of rules) {
    const fieldValue = formValues[rule.field];
    const weight = rule.weight || 1;
    let fieldScore = 0;

    if (rule.type === 'notEmpty') {
      fieldScore = (fieldValue && fieldValue.toString().trim() !== '') ? (rule.notEmptyScore || 100) : 0;
    } else if (rule.type === 'option' && rule.scoring) {
      const valueStr = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '').toString();
      fieldScore = rule.scoring[valueStr] || rule.scoring['*'] || 0;
    } else if (rule.type === 'range') {
      const numValue = parseFloat(fieldValue);
      if (!isNaN(numValue) && rule.ranges) {
        for (const range of rule.ranges) {
          if (numValue >= (range.min || -Infinity) && numValue <= (range.max || Infinity)) {
            fieldScore = range.score || 0;
            break;
          }
        }
      }
    }

    breakdown.push({
      field: rule.field,
      value: fieldValue,
      score: fieldScore,
      weight: weight,
      weighted_score: fieldScore * weight
    });

    totalWeightedScore += fieldScore * weight;
    totalWeight += weight;
  }

  const finalScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

  return {
    score: Math.min(100, Math.max(0, finalScore)),
    breakdown
  };
}

function calculateTrafficLightScore(responses, staticQuestions) {
  const breakdown = [];
  let greenCount = 0;
  let amberCount = 0;
  let redCount = 0;
  let totalQuestions = 0;

  const questions = staticQuestions.filter(q => q.type !== 'header');

  for (const question of questions) {
    const response = responses[question.id];
    totalQuestions++;

    if (response === 'green') {
      greenCount++;
    } else if (response === 'amber') {
      amberCount++;
    } else if (response === 'red') {
      redCount++;
    }

    breakdown.push({
      question_id: question.id,
      question: question.question || question.label,
      response: response || 'unanswered',
      weight: question.weight || 1
    });
  }

  let score = 0;
  if (totalQuestions > 0) {
    const greenScore = greenCount * 100;
    const amberScore = amberCount * 50;
    const redScore = redCount * 0;
    score = Math.round((greenScore + amberScore + redScore) / totalQuestions);
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    counts: { green: greenCount, amber: amberCount, red: redCount, total: totalQuestions }
  };
}

function determineRiskLevel(score, customRiskLevels) {
  const defaultLevels = [
    { name: 'low', threshold: 80 },
    { name: 'medium', threshold: 50 },
    { name: 'high', threshold: 20 },
    { name: 'critical', threshold: 0 }
  ];

  const levels = (customRiskLevels && customRiskLevels.length > 0) 
    ? customRiskLevels.map(l => ({ name: l.name.toLowerCase().replace(' ', '_'), threshold: l.threshold }))
    : defaultLevels;

  const sortedLevels = [...levels].sort((a, b) => b.threshold - a.threshold);

  for (const level of sortedLevels) {
    if (score >= level.threshold) {
      return level.name;
    }
  }

  return sortedLevels[sortedLevels.length - 1]?.name || 'unknown';
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

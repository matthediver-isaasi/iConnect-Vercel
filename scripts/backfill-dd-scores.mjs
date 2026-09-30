import { createClient } from '@supabase/supabase-js';
import { calculateTrafficLightScore, determineRiskLevel } from '../api/due-diligence/_scoring.js';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function backfillScores() {
  console.log('Starting DD score backfill...');

  // Get all submissions that have static responses but null scores
  const { data: submissions, error: subErr } = await supabase
    .from('form_submission_due_diligence')
    .select('id, tenant_id, static_question_responses, static_question_not_applicable, form_submission:form_submission_id(form_id)')
    .is('due_diligence_score', null)
    .not('static_question_responses', 'is', null);

  if (subErr) {
    console.error('Error fetching submissions:', subErr);
    return;
  }

  console.log(`Found ${submissions.length} submissions to process`);

  // Get all DD configs
  const formIds = [...new Set(submissions.map(s => s.form_submission?.form_id).filter(Boolean))];
  const { data: configs, error: configErr } = await supabase
    .from('form_due_diligence_config')
    .select('form_id, tenant_id, scoring_approach, static_questions, custom_risk_levels')
    .in('form_id', formIds);

  if (configErr) {
    console.error('Error fetching configs:', configErr);
    return;
  }

  const configMap = {};
  configs.forEach(c => {
    configMap[c.form_id] = c;
  });

  let updated = 0;
  let skipped = 0;

  for (const submission of submissions) {
    const formId = submission.form_submission?.form_id;
    const config = configMap[formId];

    if (!config || config.scoring_approach !== 'static_traffic_light') {
      skipped++;
      continue;
    }

    // Check that we have actual responses (not just empty object)
    const responses = submission.static_question_responses || {};
    if (Object.keys(responses).length === 0) {
      skipped++;
      continue;
    }

    const result = calculateTrafficLightScore(
      responses,
      config.static_questions || [],
      submission.static_question_not_applicable || {}
    );

    const riskLevel = determineRiskLevel(result.score, config.custom_risk_levels || []);

    const { error: updateErr } = await supabase
      .from('form_submission_due_diligence')
      .update({
        due_diligence_score: result.score,
        risk_level: riskLevel,
        updated_at: new Date().toISOString()
      })
      .eq('id', submission.id)
      .eq('tenant_id', submission.tenant_id);

    if (updateErr) {
      console.error(`Error updating ${submission.id}:`, updateErr);
    } else {
      console.log(`Updated ${submission.id}: score=${result.score}, risk=${riskLevel}`);
      updated++;
    }
  }

  console.log(`\nBackfill complete: ${updated} updated, ${skipped} skipped`);
}

backfillScores().catch(console.error);

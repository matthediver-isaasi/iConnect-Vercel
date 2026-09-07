import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { loadTenantLmicCodes } from '../_lib/tenantLmicCodes.js';
import { evaluateLmicCondition } from '../_lib/formLmicConditions.js';
import { evaluateScoreCondition } from '../../client/src/lib/surveyConditions.js';
import { evaluateFormLogicCondition } from '../../client/src/lib/formLogicConditions.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { assignmentWindowState } from '../_lib/surveyAssignment.js';
import { COUNTRIES } from '../../shared/countries.js';
import { FORM_NO_RELATIONSHIP_VALUE } from '../../shared/formNoRelationshipChoice.js';
import {
  findPersistedOpenFormAction,
  mapFormTransitionValues,
  normalizeFormTransitionMappings,
} from '../../shared/formOpenTransition.js';

const MAX_ANSWERS_BYTES = 128 * 1024;

function evaluateCondition(form, answers, condition, lmicCodes) {
  if (!condition?.field_id) return false;
  let triggerValue = answers?.[condition.field_id];
  const relationshipEmpty = triggerValue === FORM_NO_RELATIONSHIP_VALUE;
  const lmic = evaluateLmicCondition(triggerValue, condition.operator, lmicCodes);
  if (lmic !== undefined) return lmic;
  if (typeof triggerValue === 'string' && /^[A-Z]{2}$/.test(triggerValue)) {
    triggerValue = COUNTRIES.find(country => country.code === triggerValue)?.name || triggerValue;
  }
  const score = evaluateScoreCondition(triggerValue, condition.operator, condition.value);
  if (score !== undefined) return score;
  return evaluateFormLogicCondition(triggerValue, condition.operator, condition.value, {
    relationshipEmpty,
  });
}

export function ruleMatches(form, answers, rule, lmicCodes) {
  if (Array.isArray(rule?.conditions) && rule.conditions.length > 0) {
    const results = rule.conditions.map(condition =>
      evaluateCondition(form, answers, condition, lmicCodes));
    return (rule.logic || 'and') === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
  if (rule?.trigger_field_id) {
    return evaluateCondition(form, answers, {
      field_id: rule.trigger_field_id,
      operator: rule.operator,
      value: rule.value,
    }, lmicCodes);
  }
  return false;
}

async function loadEffectiveRules(supabase, form) {
  if (form.form_type !== 'survey' || form.survey_settings?.status !== 'published') {
    return { fields: form.fields || [], visibility_rules: form.visibility_rules || [] };
  }
  const version = Number(form.survey_settings?.current_version);
  if (!Number.isInteger(version) || version < 1) return null;
  const { data } = await supabase
    .from('survey_version')
    .select('fields, visibility_rules')
    .eq('tenant_id', form.tenant_id)
    .eq('form_id', form.id)
    .eq('version_number', version)
    .maybeSingle();
  return data || null;
}

async function canOpenPublishedSurvey(supabase, form, {
  isTenantAuthenticated,
  assignmentToken = null,
} = {}) {
  if (form.form_type !== 'survey' || form.survey_settings?.status !== 'published') return true;
  const { data: activeAssignments, error } = await supabase
    .from('event_survey_assignment')
    .select('id')
    .eq('tenant_id', form.tenant_id)
    .eq('form_id', form.id)
    .eq('status', 'active')
    .limit(1);
  if (error || !activeAssignments?.length) return !error;
  if (isTenantAuthenticated) return true;
  if (!assignmentToken) return false;
  const { data: assignment } = await supabase
    .from('event_survey_assignment')
    .select('id, status, opens_at, closes_at, access_mode')
    .eq('tenant_id', form.tenant_id)
    .eq('form_id', form.id)
    .eq('token', assignmentToken)
    .maybeSingle();
  return !!assignment
    && assignmentWindowState(assignment) === 'open'
    && assignment.access_mode !== 'authenticated';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    source_form_id: sourceFormId,
    action_id: actionId,
    answers = {},
    condition_answers: conditionAnswers = answers,
    source_assignment_token: sourceAssignmentToken = null,
  } = req.body || {};
  if (!sourceFormId || !actionId || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'A source form, action and answers are required' });
  }
  if (!conditionAnswers || typeof conditionAnswers !== 'object' || Array.isArray(conditionAnswers)) {
    return res.status(400).json({ error: 'Condition answers must be an object' });
  }
  if (Buffer.byteLength(JSON.stringify({ answers, conditionAnswers }), 'utf8') > MAX_ANSWERS_BYTES) {
    return res.status(413).json({ error: 'Form answers are too large' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const authContext = await getTenantContext(req);
    const isTenantAuthenticated = authContext?.isAuthenticated === true
      && String(authContext.tenantId || '') === String(tenant.id);

    const { data: source } = await supabase
      .from('form')
      .select('id, tenant_id, is_active, deactivate_at, access_policy, require_authentication, fields, visibility_rules, form_type, survey_settings')
      .eq('id', sourceFormId)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!source || !isFormScheduleAvailable(source)) {
      return res.status(404).json({ error: 'Source form not found or inactive' });
    }
    if (source.require_authentication && !isTenantAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const sourceSurveyStatus = source.survey_settings?.status || 'draft';
    if (source.form_type === 'survey'
        && (sourceSurveyStatus === 'archived'
          || (sourceSurveyStatus !== 'published' && !isTenantAuthenticated))) {
      return res.status(404).json({ error: 'Source form not found or inactive' });
    }
    if (!await canOpenPublishedSurvey(supabase, source, {
      isTenantAuthenticated,
      assignmentToken: sourceAssignmentToken,
    })) {
      return res.status(404).json({ error: 'Source form not found or inactive' });
    }
    const sourceAccess = await resolveFormAccess({
      supabase, req, tenantId: tenant.id, policy: source.access_policy,
    });
    if (!sourceAccess.allowed) return sendFormAccessDenied(res, sourceAccess);

    const effective = await loadEffectiveRules(supabase, source);
    if (!effective) return res.status(404).json({ error: 'Source form is unavailable' });
    const persisted = findPersistedOpenFormAction(effective.visibility_rules, actionId);
    if (!persisted || !persisted.action.destination_form_id
        || String(persisted.action.destination_form_id) === String(source.id)) {
      return res.status(400).json({ error: 'The form change is not configured' });
    }

    const lmicCodes = await loadTenantLmicCodes(supabase, tenant.id);
    if (!ruleMatches(source, conditionAnswers, persisted.rule, lmicCodes)) {
      return res.status(409).json({ error: 'The form change condition is not met' });
    }

    const { data: target } = await supabase
      .from('form')
      .select('id, slug, tenant_id, is_active, deactivate_at, access_policy, require_authentication, fields, visibility_rules, form_type, survey_settings')
      .eq('id', persisted.action.destination_form_id)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!target || !target.slug || !isFormScheduleAvailable(target)) {
      return res.status(404).json({ error: 'Destination form not found or inactive' });
    }
    if (target.require_authentication && !isTenantAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const targetSurveyStatus = target.survey_settings?.status || 'draft';
    if (target.form_type === 'survey'
        && (targetSurveyStatus === 'archived'
          || (targetSurveyStatus !== 'published' && !isTenantAuthenticated))) {
      return res.status(404).json({ error: 'Destination form not found or inactive' });
    }
    if (!await canOpenPublishedSurvey(supabase, target, { isTenantAuthenticated })) {
      return res.status(404).json({ error: 'Destination form not found or inactive' });
    }
    const targetAccess = await resolveFormAccess({
      supabase, req, tenantId: tenant.id, policy: target.access_policy,
    });
    if (!targetAccess.allowed) return sendFormAccessDenied(res, targetAccess);

    const targetEffective = await loadEffectiveRules(supabase, target);
    if (!targetEffective) {
      return res.status(404).json({ error: 'Destination form is unavailable' });
    }
    const mappingResult = normalizeFormTransitionMappings(
      persisted.action,
      effective.fields,
      targetEffective.fields,
    );
    if (!mappingResult.valid) {
      return res.status(400).json({ error: 'The form change mappings are invalid' });
    }

    return res.json({
      target_form_id: target.id,
      target_slug: target.slug,
      mapped_values: mapFormTransitionValues(mappingResult.mappings, answers),
    });
  } catch (error) {
    console.error('[Form Transition] Failed:', error);
    return res.status(500).json({ error: 'The destination form could not be opened' });
  }
}
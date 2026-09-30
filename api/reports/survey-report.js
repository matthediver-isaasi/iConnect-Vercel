// Task #3332: Survey reporting & exports.
//
// Single tenant-scoped endpoint powering /SurveyReports. Aggregation runs
// server-side against the normalized survey_answer table (indexed by
// tenant/form, submission and category) plus form_submission survey columns.
//
// Views (GET ?view=):
//   filters       — survey forms + (per form) versions, event assignments, categories
//   summary       — summary cards, question/category aggregates, event comparison,
//                   trend/volume series. NEVER includes free text.
//   distribution  — one question's response distribution (on demand)
//   comments      — paginated free-text answers (search/event/question/date filters,
//                   export=csv for CSV download)
//   responses     — paginated response-level rows (permission-gated)
//   export        — type=summary (csv|xlsx) or type=responses (xlsx, multi-sheet)
//
// RBAC (existing pattern, admin bypass):
//   forms.survey-reports                   — aggregate reporting
//   forms.survey-reports.response-detail   — response-level rows, identity, response export
//
// Anonymity: for anonymous surveys, identity is never returned anywhere and
// respondent-level detail (responses view, Responses/Comments export sheets,
// comments view) is suppressed until the survey's anonymity threshold is met.
// Anonymous drilldowns use generated response references (hash of id).

import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getSessionMember } from '../_lib/session.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';
import { escapeCsvCell, CSV_BOM, CSV_ROW_SEPARATOR } from '../_lib/csvCell.js';
import { isScoreField, getScoreRange, IDENTITY_FIELD_TYPES } from '../_lib/surveyScoring.js';
import { computeSetAnonymity } from '../_lib/surveyReportAnonymity.js';

const PAGE_SIZE = 1000;
const MAX_TOTAL_ROWS = 50000;
const AGGREGATE_KEY = 'forms.survey-reports';
const RESPONSE_KEY = 'forms.survey-reports.response-detail';
const IDENTITY_NAME_RE = /(e-?mail|phone|mobile|telephone|first.?name|last.?name|full.?name|surname|your.?name|contact)/i;
const TEXT_FIELD_TYPES = ['text', 'textarea', 'long_text', 'paragraph'];

const round = (n, dp = 4) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

// Deterministic, non-reversible response reference for anonymous drilldowns.
function responseRef(submissionId) {
  return 'R-' + crypto.createHash('sha256').update(String(submissionId)).digest('hex').slice(0, 8).toUpperCase();
}

async function fetchAllPaged(buildQuery) {
  const rows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1));
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    if (rows.length >= MAX_TOTAL_ROWS) {
      throw new Error(`Report would scan more than ${MAX_TOTAL_ROWS} rows. Narrow the filters (date range or events).`);
    }
  }
  return rows;
}

function parseListParam(v) {
  return [...new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean))];
}

function dayStartIso(d) { return new Date(d + 'T00:00:00.000Z').toISOString(); }
function dayEndExclusiveIso(d) {
  const t = new Date(d + 'T00:00:00.000Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadContext(tenantId, formId) {
  const { data: form, error: formErr } = await supabase
    .from('form')
    .select('id, name, form_type, survey_settings, fields')
    .eq('tenant_id', tenantId)
    .eq('id', formId)
    .maybeSingle();
  if (formErr) throw new Error(formErr.message);
  if (!form || form.form_type !== 'survey') {
    const e = new Error('Survey not found');
    e.status = 404;
    throw e;
  }

  const [{ data: versions, error: vErr }, { data: assignments, error: aErr }] = await Promise.all([
    supabase
      .from('survey_version')
      .select('id, version_number, fields, survey_settings, created_date')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .order('version_number', { ascending: true }),
    supabase
      .from('event_survey_assignment')
      .select('id, event_type, event_id, complex_event_id, event_title, event_start_date, status, response_count, survey_version_number')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .order('event_start_date', { ascending: false, nullsFirst: false }),
  ]);
  if (vErr) throw new Error(vErr.message);
  if (aErr) throw new Error(aErr.message);

  return { form, versions: versions || [], assignments: assignments || [] };
}

// Build per-question metadata across the version snapshots actually in play.
// Later versions win for display metadata; range union keeps min/max honest.
function buildQuestionMeta(versions) {
  const meta = new Map(); // field_id -> { ... }
  for (const v of versions) {
    for (const f of (Array.isArray(v.fields) ? v.fields : [])) {
      if (!isScoreField(f)) continue;
      const { min, max } = getScoreRange(f);
      const existing = meta.get(f.id);
      meta.set(f.id, {
        fieldId: f.id,
        label: f.reporting_name || f.label || f.id,
        rawLabel: f.label || '',
        category: f.reporting_category || null,
        weight: Number(f.weight) > 0 ? Number(f.weight) : 1,
        includeInOverall: f.include_in_overall !== false,
        allowNa: f.allow_na === true,
        min: existing ? Math.min(existing.min, min) : min,
        max: existing ? Math.max(existing.max, max) : max,
        style: f.score_style || 'stars',
        versions: [...new Set([...(existing?.versions || []), v.version_number])],
      });
    }
  }
  return meta;
}

function buildTextFieldMeta(versions) {
  const meta = new Map();
  for (const v of versions) {
    for (const f of (Array.isArray(v.fields) ? v.fields : [])) {
      if (!f || !TEXT_FIELD_TYPES.includes(f.type)) continue;
      // Never surface identity-bearing text fields as "comments".
      if (IDENTITY_FIELD_TYPES.includes(f.type) || IDENTITY_NAME_RE.test(`${f.label || ''} ${f.id}`)) continue;
      meta.set(f.id, { fieldId: f.id, label: f.label || f.id });
    }
  }
  return meta;
}

// Resolve the effective filter set from query params + load filtered
// submissions (without answers). Returns { submissions, assignmentById,
// versionIdsPresent, filters }.
async function loadFilteredSubmissions(tenantId, formId, ctx, query) {
  const {
    versionNumber, assignmentIds: assignmentIdsRaw,
    eventDateFrom, eventDateTo, dateFrom, dateTo,
    identityType, completion,
  } = query;

  const assignmentIds = parseListParam(assignmentIdsRaw);
  const assignmentById = new Map(ctx.assignments.map((a) => [a.id, a]));

  // Event-date range filters resolve to an assignment-id set server-side.
  let allowedAssignmentIds = null;
  if (assignmentIds.length > 0) {
    allowedAssignmentIds = new Set(assignmentIds.filter((id) => assignmentById.has(id)));
  }
  if (eventDateFrom || eventDateTo) {
    const fromMs = eventDateFrom ? new Date(dayStartIso(eventDateFrom)).getTime() : null;
    const toMs = eventDateTo ? new Date(dayEndExclusiveIso(eventDateTo)).getTime() : null;
    const inRange = (a) => {
      if (!a.event_start_date) return false;
      const ms = new Date(a.event_start_date).getTime();
      if (Number.isNaN(ms)) return false;
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms >= toMs) return false;
      return true;
    };
    const dateSet = new Set(ctx.assignments.filter(inRange).map((a) => a.id));
    allowedAssignmentIds = allowedAssignmentIds
      ? new Set([...allowedAssignmentIds].filter((id) => dateSet.has(id)))
      : dateSet;
  }

  // Version filter maps a version number to its snapshot id(s).
  let versionIdFilter = null;
  if (versionNumber) {
    const n = Number(versionNumber);
    versionIdFilter = ctx.versions.filter((v) => v.version_number === n).map((v) => v.id);
    if (versionIdFilter.length === 0) versionIdFilter = ['00000000-0000-0000-0000-000000000000'];
  }

  const submissions = await fetchAllPaged(() => {
    let q = supabase
      .from('form_submission')
      .select('id, created_date, survey_version_id, survey_score_weighted, survey_score_unweighted, is_anonymous, survey_assignment_id, event_id, complex_event_id, submitted_by_email, submitted_by_name')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .order('id', { ascending: true });
    if (versionIdFilter) q = q.in('survey_version_id', versionIdFilter);
    if (allowedAssignmentIds) {
      q = q.in('survey_assignment_id', allowedAssignmentIds.size > 0 ? [...allowedAssignmentIds] : ['00000000-0000-0000-0000-000000000000']);
    }
    if (dateFrom) q = q.gte('created_date', dayStartIso(dateFrom));
    if (dateTo) q = q.lt('created_date', dayEndExclusiveIso(dateTo));
    if (identityType === 'identified') q = q.or('is_anonymous.is.null,is_anonymous.eq.false');
    if (identityType === 'anonymous') q = q.eq('is_anonymous', true);
    return q;
  });

  // Only submissions with a survey version stamp are survey responses.
  const surveySubs = submissions.filter((s) => s.survey_version_id);

  return {
    submissions: surveySubs,
    assignmentById,
    completionFilter: completion || 'all',
  };
}

async function loadAnswersForSubmissions(tenantId, formId, submissionIds) {
  const answers = [];
  for (let i = 0; i < submissionIds.length; i += 150) {
    const chunk = submissionIds.slice(i, i + 150);
    const rows = await fetchAllPaged(() =>
      supabase
        .from('survey_answer')
        .select('submission_id, survey_version_id, field_id, reporting_name, reporting_category, raw_score, is_na, normalised_score, weight, weighted_contribution, included_in_overall')
        .eq('tenant_id', tenantId)
        .eq('form_id', formId)
        .in('submission_id', chunk)
        .order('id', { ascending: true })
    );
    answers.push(...rows);
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Aggregation (always from underlying answers — never averages of averages)
// ---------------------------------------------------------------------------

function aggregate(ctx, submissions, answers, questionMeta, categoryFilter) {
  const versionById = new Map(ctx.versions.map((v) => [v.id, v]));
  const answersBySubmission = new Map();
  for (const a of answers) {
    if (categoryFilter && (a.reporting_category || '') !== categoryFilter) continue;
    if (!answersBySubmission.has(a.submission_id)) answersBySubmission.set(a.submission_id, []);
    answersBySubmission.get(a.submission_id).push(a);
  }

  // Completion: a submission is complete when it answered (score or N/A)
  // every score question in ITS version snapshot; optional skipped questions
  // make it partial. (Hidden questions can't be distinguished post-hoc, so
  // this is a best-effort definition, explained in the UI tooltip.)
  const scoreFieldCountByVersion = new Map();
  for (const v of ctx.versions) {
    scoreFieldCountByVersion.set(v.id, (Array.isArray(v.fields) ? v.fields : []).filter(isScoreField).length);
  }

  const perSubmission = submissions.map((s) => {
    const subAnswers = answersBySubmission.get(s.id) || [];
    const expected = scoreFieldCountByVersion.get(s.survey_version_id) ?? null;
    const complete = expected !== null && subAnswers.length >= expected && expected > 0;
    return { submission: s, answers: subAnswers, complete };
  });

  // Overall cumulative scores computed from ALL underlying included answers.
  let wNum = 0, wDen = 0, uSum = 0, uCount = 0, rawTotal = 0;
  const questionAgg = new Map();
  const categoryAgg = new Map();

  const feed = (bucketMap, key, a) => {
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { valid: 0, na: 0, rawSum: 0, normSum: 0, weightSum: 0, weightedSum: 0, min: null, max: null });
    }
    const b = bucketMap.get(key);
    if (a.is_na) { b.na += 1; return; }
    if (a.raw_score === null || a.raw_score === undefined) return;
    b.valid += 1;
    b.rawSum += Number(a.raw_score);
    b.normSum += Number(a.normalised_score) || 0;
    const w = Number(a.weight) > 0 ? Number(a.weight) : 1;
    b.weightSum += w;
    b.weightedSum += (Number(a.normalised_score) || 0) * w;
    b.min = b.min === null ? Number(a.raw_score) : Math.min(b.min, Number(a.raw_score));
    b.max = b.max === null ? Number(a.raw_score) : Math.max(b.max, Number(a.raw_score));
  };

  for (const { answers: subAnswers } of perSubmission) {
    for (const a of subAnswers) {
      feed(questionAgg, a.field_id, a);
      feed(categoryAgg, a.reporting_category || '(uncategorised)', a);
      if (!a.is_na && a.raw_score !== null && a.raw_score !== undefined) {
        rawTotal += Number(a.raw_score);
        if (a.included_in_overall !== false) {
          const w = Number(a.weight) > 0 ? Number(a.weight) : 1;
          const norm = Number(a.normalised_score) || 0;
          wNum += norm * w;
          wDen += w;
          uSum += norm;
          uCount += 1;
        }
      }
    }
  }

  const questions = [];
  for (const [fieldId, b] of questionAgg) {
    const meta = questionMeta.get(fieldId) || { fieldId, label: fieldId, category: null, weight: 1, min: null, max: null, includeInOverall: true, versions: [] };
    // Skipped: submissions of a version containing this question with no answer row.
    let eligible = 0;
    for (const { submission: s, answers: subAnswers } of perSubmission) {
      const v = versionById.get(s.survey_version_id);
      const hasField = v && (Array.isArray(v.fields) ? v.fields : []).some((f) => f.id === fieldId && isScoreField(f));
      if (hasField && !subAnswers.some((a) => a.field_id === fieldId)) eligible += 1;
    }
    questions.push({
      fieldId,
      label: meta.label,
      category: meta.category,
      rangeMin: meta.min,
      rangeMax: meta.max,
      weight: meta.weight,
      includeInOverall: meta.includeInOverall,
      validCount: b.valid,
      naCount: b.na,
      skippedCount: eligible,
      rawAverage: b.valid > 0 ? round(b.rawSum / b.valid) : null,
      normalisedAverage: b.valid > 0 ? round(b.normSum / b.valid) : null,
      weightedContribution: b.weightSum > 0 ? round(b.weightedSum / b.weightSum) : null,
      minScore: b.min,
      maxScore: b.max,
      versions: meta.versions,
    });
  }
  questions.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.label.localeCompare(b.label));

  const categories = [];
  for (const [name, b] of categoryAgg) {
    categories.push({
      category: name,
      validCount: b.valid,
      naCount: b.na,
      rawAverage: b.valid > 0 ? round(b.rawSum / b.valid) : null,
      normalisedAverage: b.valid > 0 ? round(b.normSum / b.valid) : null,
      weightedAverage: b.weightSum > 0 ? round(b.weightedSum / b.weightSum) : null,
    });
  }
  categories.sort((a, b) => a.category.localeCompare(b.category));

  return {
    perSubmission,
    summary: {
      responses: perSubmission.length,
      completed: perSubmission.filter((p) => p.complete).length,
      partial: perSubmission.filter((p) => !p.complete).length,
      weightedAverage: wDen > 0 ? round(wNum / wDen) : null,
      unweightedAverage: uCount > 0 ? round(uSum / uCount) : null,
      totalRawScore: round(rawTotal, 2),
    },
    questions,
    categories,
  };
}

// Per-event comparison, cumulative from underlying answers per event.
function aggregateEvents(ctx, perSubmission) {
  const byAssignment = new Map();
  for (const p of perSubmission) {
    const key = p.submission.survey_assignment_id || '(none)';
    if (!byAssignment.has(key)) byAssignment.set(key, []);
    byAssignment.get(key).push(p);
  }
  const events = [];
  for (const [assignmentId, subs] of byAssignment) {
    const a = ctx.assignments.find((x) => x.id === assignmentId) || null;
    let wNum = 0, wDen = 0, uSum = 0, uCount = 0;
    const catAgg = new Map();
    for (const p of subs) {
      for (const ans of p.answers) {
        if (ans.is_na || ans.raw_score === null || ans.raw_score === undefined) continue;
        const w = Number(ans.weight) > 0 ? Number(ans.weight) : 1;
        const norm = Number(ans.normalised_score) || 0;
        if (ans.included_in_overall !== false) {
          wNum += norm * w; wDen += w; uSum += norm; uCount += 1;
        }
        const cat = ans.reporting_category || '(uncategorised)';
        if (!catAgg.has(cat)) catAgg.set(cat, { weightedSum: 0, weightSum: 0 });
        const cb = catAgg.get(cat);
        cb.weightedSum += norm * w;
        cb.weightSum += w;
      }
    }
    let best = null, worst = null;
    for (const [cat, cb] of catAgg) {
      if (cb.weightSum <= 0) continue;
      const avg = cb.weightedSum / cb.weightSum;
      if (!best || avg > best.avg) best = { category: cat, avg };
      if (!worst || avg < worst.avg) worst = { category: cat, avg };
    }
    events.push({
      assignmentId: assignmentId === '(none)' ? null : assignmentId,
      eventTitle: a?.event_title || (assignmentId === '(none)' ? 'No event (direct responses)' : 'Deleted assignment'),
      eventDate: a?.event_start_date || null,
      eventType: a?.event_type || null,
      eventId: a?.event_id || a?.complex_event_id || null,
      responses: subs.length,
      weightedAverage: wDen > 0 ? round(wNum / wDen) : null,
      unweightedAverage: uCount > 0 ? round(uSum / uCount) : null,
      bestCategory: best ? { category: best.category, average: round(best.avg) } : null,
      worstCategory: worst ? { category: worst.category, average: round(worst.avg) } : null,
    });
  }
  events.sort((a, b) => new Date(b.eventDate || 0) - new Date(a.eventDate || 0));
  return events;
}

// Response-volume series bucketed by month, on the chosen date basis.
function buildVolumeSeries(perSubmission, assignmentById, dateBasis) {
  const buckets = new Map();
  for (const p of perSubmission) {
    let d = p.submission.created_date;
    if (dateBasis === 'event') {
      const a = p.submission.survey_assignment_id ? assignmentById.get(p.submission.survey_assignment_id) : null;
      d = a?.event_start_date || p.submission.created_date;
    }
    if (!d) continue;
    const key = String(d).slice(0, 7); // YYYY-MM
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }));
}

// Response rate: only when every filtered response belongs to an event
// assignment (a reliable attendee denominator can then be derived from
// active bookings for those events).
async function computeResponseRate(tenantId, perSubmission, assignmentById) {
  const assignments = new Set();
  for (const p of perSubmission) {
    if (!p.submission.survey_assignment_id) return null;
    assignments.add(p.submission.survey_assignment_id);
  }
  if (assignments.size === 0) return null;
  const simpleIds = [], complexIds = [];
  for (const id of assignments) {
    const a = assignmentById.get(id);
    if (!a) return null;
    if (a.event_type === 'complex_event' && a.complex_event_id) complexIds.push(a.complex_event_id);
    else if (a.event_id) simpleIds.push(a.event_id);
    else return null; // deleted event — no reliable denominator
  }
  let denominator = 0;
  if (simpleIds.length > 0) {
    const { count, error } = await supabase
      .from('booking')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('event_id', simpleIds)
      .neq('status', 'cancelled');
    if (error) return null;
    denominator += count || 0;
  }
  if (complexIds.length > 0) {
    const { count, error } = await supabase
      .from('complex_event_booking')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('event_id', complexIds)
      .neq('status', 'cancelled');
    if (error) return null;
    denominator += count || 0;
  }
  if (denominator <= 0) return null;
  return { denominator, rate: round(perSubmission.length / denominator) };
}

// ---------------------------------------------------------------------------
// Anonymity helpers
// ---------------------------------------------------------------------------

function anonymityInfo(form) {
  const settings = form.survey_settings || {};
  const identityMode = settings.response_identity || 'identified';
  const isAnonymous = identityMode !== 'identified';
  const threshold = Number.isFinite(Number(settings.anonymity_threshold)) ? Number(settings.anonymity_threshold) : 3;
  return { isAnonymous, threshold, identityMode };
}

// ---------------------------------------------------------------------------
// Export audit (server-authored entries on the form's survey_audit_log)
// ---------------------------------------------------------------------------

async function recordExportAudit(tenantId, formId, entry) {
  try {
    const { data: row } = await supabase
      .from('form')
      .select('survey_audit_log')
      .eq('tenant_id', tenantId)
      .eq('id', formId)
      .maybeSingle();
    const log = Array.isArray(row?.survey_audit_log) ? row.survey_audit_log : [];
    log.push({ action: 'report_export', at: new Date().toISOString(), ...entry });
    const { error } = await supabase
      .from('form')
      .update({ survey_audit_log: log.slice(-200) })
      .eq('tenant_id', tenantId)
      .eq('id', formId);
    if (error) console.error('[Survey Report] export audit write failed:', error.message);
  } catch (err) {
    console.error('[Survey Report] export audit failed:', err?.message);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  try {
    const ctxAuth = await getTenantContext(req);
    if (!ctxAuth?.tenantId || !ctxAuth.isAuthenticated) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { tenantId } = ctxAuth;

    // RBAC: admins bypass; members checked against effective exclusions.
    const isAdmin = await hasAdminAccess(ctxAuth);
    let canResponseDetail = true;
    let actorEmail = null;
    if (!isAdmin) {
      const member = await getSessionMember(req);
      if (!member) return res.status(403).json({ error: 'Access denied' });
      actorEmail = member.email || null;
      const exclusions = await resolveMemberExclusions(
        { roleId: member.role_id, memberExcludedFeatures: member.member_excluded_features },
        supabase
      );
      const access = makeFeatureAccessChecker(exclusions);
      if (!access.canAccessFeature(AGGREGATE_KEY)) {
        return res.status(403).json({ error: 'You do not have access to Survey Reports.', code: 'feature_excluded' });
      }
      canResponseDetail = access.canAccessFeature(RESPONSE_KEY);
    } else {
      const member = await getSessionMember(req).catch(() => null);
      actorEmail = member?.email || null;
    }

    const { view = 'summary', formId } = req.query;

    // ---- filters view (no formId required) --------------------------------
    if (view === 'filters') {
      const { data: forms, error } = await supabase
        .from('form')
        .select('id, name, survey_settings')
        .eq('tenant_id', tenantId)
        .eq('form_type', 'survey')
        .order('name', { ascending: true });
      if (error) throw new Error(error.message);
      let detail = null;
      if (formId) {
        const ctx = await loadContext(tenantId, formId);
        const categories = new Set();
        for (const v of ctx.versions) {
          for (const f of (Array.isArray(v.fields) ? v.fields : [])) {
            if (isScoreField(f) && f.reporting_category) categories.add(f.reporting_category);
          }
        }
        detail = {
          versions: ctx.versions.map((v) => ({ id: v.id, versionNumber: v.version_number })),
          assignments: ctx.assignments.map((a) => ({
            id: a.id, eventTitle: a.event_title, eventDate: a.event_start_date,
            eventType: a.event_type, status: a.status, responseCount: a.response_count,
          })),
          categories: [...categories].sort(),
          anonymity: anonymityInfo(ctx.form),
          canResponseDetail,
        };
      }
      return res.status(200).json({
        surveys: (forms || []).map((f) => ({ id: f.id, name: f.name })),
        detail,
        canResponseDetail,
      });
    }

    if (!formId) return res.status(400).json({ error: 'formId is required' });

    const ctx = await loadContext(tenantId, formId);
    const questionMeta = buildQuestionMeta(ctx.versions);
    const versionById = new Map(ctx.versions.map((v) => [v.id, v]));
    const loaded = await loadFilteredSubmissions(tenantId, formId, ctx, req.query);
    const answers = await loadAnswersForSubmissions(tenantId, formId, loaded.submissions.map((s) => s.id));
    const categoryFilter = req.query.category || null;
    const agg = aggregate(ctx, loaded.submissions, answers, questionMeta, categoryFilter);

    // Completion-status filter is applied AFTER answer join (it derives from answers).
    let perSubmission = agg.perSubmission;
    if (loaded.completionFilter === 'completed') perSubmission = perSubmission.filter((p) => p.complete);
    if (loaded.completionFilter === 'partial') perSubmission = perSubmission.filter((p) => !p.complete);
    const filteredAgg = loaded.completionFilter === 'all'
      ? agg
      : aggregate(ctx, perSubmission.map((p) => p.submission), answers.filter((a) => perSubmission.some((p) => p.submission.id === a.submission_id)), questionMeta, categoryFilter);

    const events = aggregateEvents(ctx, perSubmission);
    const versionNumbersPresent = [...new Set(perSubmission
      .map((p) => ctx.versions.find((v) => v.id === p.submission.survey_version_id)?.version_number)
      .filter((n) => n !== undefined))].sort((a, b) => a - b);
    // Anonymity is governed by each response's VERSION SNAPSHOT settings
    // (live form settings are mutable and must never re-identify history).
    // Strictest protection wins for mixed-version sets.
    const setAnon = computeSetAnonymity(perSubmission.map((p) => p.submission), versionById, ctx.form);
    const suppressed = setAnon.allSuppressed;

    // ---- summary -----------------------------------------------------------
    if (view === 'summary') {
      const dateBasis = req.query.dateBasis === 'submission' ? 'submission' : 'event';
      const responseRate = await computeResponseRate(tenantId, perSubmission, loaded.assignmentById);
      const eventsIncluded = events.filter((e) => e.assignmentId).length;
      return res.status(200).json({
        survey: { id: ctx.form.id, name: ctx.form.name },
        anonymity: { isAnonymous: setAnon.isAnonymous, threshold: setAnon.threshold, suppressed },
        multiVersion: versionNumbersPresent.length > 1,
        versionNumbersPresent,
        summary: {
          ...filteredAgg.summary,
          eventsIncluded,
          avgResponsesPerEvent: eventsIncluded > 0 ? round(perSubmission.length / eventsIncluded, 2) : null,
          responseRate,
        },
        questions: filteredAgg.questions,
        categories: filteredAgg.categories,
        events,
        volume: buildVolumeSeries(perSubmission, loaded.assignmentById, dateBasis),
        dateBasis,
        canResponseDetail,
      });
    }

    // ---- distribution ------------------------------------------------------
    if (view === 'distribution') {
      const fieldId = req.query.fieldId;
      if (!fieldId) return res.status(400).json({ error: 'fieldId is required' });
      const meta = questionMeta.get(fieldId);
      if (!meta) return res.status(404).json({ error: 'Question not found' });
      const counts = new Map();
      let na = 0;
      const subIds = new Set(perSubmission.map((p) => p.submission.id));
      for (const a of answers) {
        if (a.field_id !== fieldId || !subIds.has(a.submission_id)) continue;
        if (a.is_na) { na += 1; continue; }
        if (a.raw_score === null || a.raw_score === undefined) continue;
        counts.set(Number(a.raw_score), (counts.get(Number(a.raw_score)) || 0) + 1);
      }
      const distribution = [];
      for (let s = meta.min; s <= meta.max; s += 1) {
        distribution.push({ score: s, count: counts.get(s) || 0 });
      }
      return res.status(200).json({ fieldId, label: meta.label, rangeMin: meta.min, rangeMax: meta.max, naCount: na, distribution });
    }

    // ---- comments (respondent-level: threshold-gated when anonymous) -------
    if (view === 'comments') {
      if (suppressed) {
        return res.status(200).json({ suppressed: true, threshold: setAnon.threshold, comments: [], pagination: null });
      }
      const textMeta = buildTextFieldMeta(ctx.versions);
      const questionFilter = req.query.commentFieldId || null;
      const search = (req.query.search || '').toLowerCase().trim();

      // Free text lives in submission_data — fetched only here, never in summary.
      const subIds = perSubmission.map((p) => p.submission.id);
      const dataRows = [];
      for (let i = 0; i < subIds.length; i += 150) {
        const chunk = subIds.slice(i, i + 150);
        const rows = await fetchAllPaged(() =>
          supabase
            .from('form_submission')
            .select('id, created_date, survey_assignment_id, submission_data')
            .eq('tenant_id', tenantId)
            .in('id', chunk)
            .order('id', { ascending: true })
        );
        dataRows.push(...rows);
      }
      const subById = new Map(perSubmission.map((p) => [p.submission.id, p.submission]));
      const comments = [];
      for (const row of dataRows) {
        const sub = subById.get(row.id);
        if (!sub) continue;
        const rowAnon = setAnon.isAnonymousRow(sub);
        // Below-threshold anonymous rows are withheld entirely.
        if (rowAnon && setAnon.suppressAnonymousRows) continue;
        const data = row.submission_data || {};
        for (const [fid, value] of Object.entries(data)) {
          if (!textMeta.has(fid)) continue;
          if (questionFilter && fid !== questionFilter) continue;
          const text = typeof value === 'string' ? value.trim() : '';
          if (!text) continue;
          if (search && !text.toLowerCase().includes(search)) continue;
          const a = row.survey_assignment_id ? loaded.assignmentById.get(row.survey_assignment_id) : null;
          comments.push({
            reference: responseRef(row.id),
            submissionId: rowAnon ? null : row.id,
            date: row.created_date,
            eventTitle: a?.event_title || null,
            question: textMeta.get(fid).label,
            fieldId: fid,
            text,
          });
        }
      }
      comments.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

      if (req.query.export === 'csv') {
        await recordExportAudit(tenantId, formId, {
          export_type: 'comments_csv', by: actorEmail, filters: sanitizeFilterEcho(req.query),
        });
        const header = ['Reference', 'Date', 'Event', 'Question', 'Comment'];
        const lines = [header.map(escapeCsvCell).join(',')];
        for (const c of comments) {
          lines.push([c.reference, c.date || '', c.eventTitle || '', c.question, c.text].map(escapeCsvCell).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="survey-comments-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.status(200).send(CSV_BOM + lines.join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR);
      }

      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const sizeNum = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
      return res.status(200).json({
        suppressed: false,
        commentQuestions: [...textMeta.values()],
        comments: comments.slice((pageNum - 1) * sizeNum, pageNum * sizeNum),
        pagination: { page: pageNum, pageSize: sizeNum, totalRows: comments.length, totalPages: Math.max(1, Math.ceil(comments.length / sizeNum)) },
      });
    }

    // ---- responses (permission + threshold gated) ---------------------------
    if (view === 'responses') {
      if (!canResponseDetail) {
        return res.status(403).json({ error: 'You do not have access to response-level survey data.', code: 'feature_excluded' });
      }
      if (suppressed) {
        return res.status(200).json({ suppressed: true, threshold: setAnon.threshold, rows: [], pagination: null });
      }
      const rowsAll = perSubmission
        .filter((p) => !(setAnon.isAnonymousRow(p.submission) && setAnon.suppressAnonymousRows))
        .sort((a, b) => new Date(b.submission.created_date || 0) - new Date(a.submission.created_date || 0))
        .map((p) => buildResponseRow(p, ctx, loaded.assignmentById, setAnon.isAnonymousRow(p.submission)));
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const sizeNum = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
      return res.status(200).json({
        suppressed: false,
        anonymous: setAnon.isAnonymous,
        rows: rowsAll.slice((pageNum - 1) * sizeNum, pageNum * sizeNum),
        pagination: { page: pageNum, pageSize: sizeNum, totalRows: rowsAll.length, totalPages: Math.max(1, Math.ceil(rowsAll.length / sizeNum)) },
      });
    }

    // ---- exports -------------------------------------------------------------
    if (view === 'export') {
      const type = req.query.type === 'responses' ? 'responses' : 'summary';
      const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
      const dateBasis = req.query.dateBasis === 'submission' ? 'submission' : 'event';

      if (type === 'responses' && !canResponseDetail) {
        return res.status(403).json({ error: 'You do not have access to response-level survey exports.', code: 'feature_excluded' });
      }

      await recordExportAudit(tenantId, formId, {
        export_type: `${type}_${format}`, by: actorEmail, filters: sanitizeFilterEcho(req.query),
      });

      const stamp = new Date().toISOString().slice(0, 10);
      const summaryRows = buildSummarySheetRows(ctx, filteredAgg, events, perSubmission, setAnon, suppressed, versionNumbersPresent);

      if (type === 'summary' && format === 'csv') {
        const lines = summaryRows.csvSections.map((section) =>
          section.map((r) => r.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR)
        ).join(CSV_ROW_SEPARATOR + CSV_ROW_SEPARATOR);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="survey-report-${stamp}.csv"`);
        return res.status(200).send(CSV_BOM + lines + CSV_ROW_SEPARATOR);
      }

      const XLSX = (await import('xlsx')).default || (await import('xlsx'));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows.summarySheet), 'Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows.eventsSheet), 'Events');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows.questionsSheet), 'Questions');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows.categoriesSheet), 'Categories');

      if (type === 'responses') {
        if (suppressed) {
          const note = [[`Respondent-level detail is suppressed until at least ${setAnon.threshold} responses are received.`]];
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), 'Responses');
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(note), 'Comments');
        } else {
          // Responses sheet. Identity columns only when the set has any
          // identified rows; anonymous rows are redacted per row and
          // below-threshold anonymous rows are omitted entirely.
          const exportable = perSubmission.filter((p) => !(setAnon.isAnonymousRow(p.submission) && setAnon.suppressAnonymousRows));
          const hasIdentified = exportable.some((p) => !setAnon.isAnonymousRow(p.submission));
          const qCols = [...questionMeta.values()];
          const respHeader = ['Reference', ...(hasIdentified ? ['Respondent', 'Email'] : []), 'Event', 'Date', 'Version', 'Completion', 'Weighted score', 'Unweighted score', ...qCols.map((q) => q.label)];
          const respRows = [respHeader];
          for (const p of exportable) {
            const rowAnon = setAnon.isAnonymousRow(p.submission);
            const r = buildResponseRow(p, ctx, loaded.assignmentById, rowAnon);
            const byField = new Map(p.answers.map((a) => [a.field_id, a]));
            respRows.push([
              r.reference,
              ...(hasIdentified ? [r.respondentName || '', r.respondentEmail || ''] : []),
              r.eventTitle || '', r.date || '', r.versionNumber ?? '', r.complete ? 'Completed' : 'Partial',
              r.weightedScore ?? '', r.unweightedScore ?? '',
              ...qCols.map((q) => {
                const a = byField.get(q.fieldId);
                if (!a) return '';
                return a.is_na ? 'N/A' : a.raw_score;
              }),
            ]);
          }
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(respRows), 'Responses');

          // Comments sheet (re-derives free text)
          const textMeta = buildTextFieldMeta(ctx.versions);
          const commentRows = [['Reference', 'Date', 'Event', 'Question', 'Comment']];
          const subIds = exportable.map((p) => p.submission.id);
          for (let i = 0; i < subIds.length; i += 150) {
            const chunk = subIds.slice(i, i + 150);
            const rows = await fetchAllPaged(() =>
              supabase
                .from('form_submission')
                .select('id, created_date, survey_assignment_id, submission_data')
                .eq('tenant_id', tenantId)
                .in('id', chunk)
                .order('id', { ascending: true })
            );
            for (const row of rows) {
              for (const [fid, value] of Object.entries(row.submission_data || {})) {
                if (!textMeta.has(fid)) continue;
                const text = typeof value === 'string' ? value.trim() : '';
                if (!text) continue;
                const a = row.survey_assignment_id ? loaded.assignmentById.get(row.survey_assignment_id) : null;
                commentRows.push([responseRef(row.id), row.created_date || '', a?.event_title || '', textMeta.get(fid).label, text]);
              }
            }
          }
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(commentRows), 'Comments');
        }
      }

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="survey-${type}-${stamp}.xlsx"`);
      return res.status(200).send(buf);
    }

    return res.status(400).json({ error: `Unknown view "${view}"` });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[Survey Report] Error:', error);
    return res.status(status).json({ error: error.message || 'Internal server error' });
  }
}

function sanitizeFilterEcho(q) {
  const keep = ['formId', 'versionNumber', 'assignmentIds', 'eventDateFrom', 'eventDateTo', 'dateFrom', 'dateTo', 'category', 'identityType', 'completion', 'dateBasis'];
  const out = {};
  for (const k of keep) if (q[k]) out[k] = String(q[k]).slice(0, 500);
  return out;
}

function buildResponseRow(p, ctx, assignmentById, rowAnonymous) {
  const s = p.submission;
  const a = s.survey_assignment_id ? assignmentById.get(s.survey_assignment_id) : null;
  const v = ctx.versions.find((x) => x.id === s.survey_version_id);
  return {
    reference: responseRef(s.id),
    submissionId: rowAnonymous ? null : s.id,
    respondentName: rowAnonymous ? null : (s.submitted_by_name || null),
    respondentEmail: rowAnonymous ? null : (s.submitted_by_email || null),
    eventTitle: a?.event_title || null,
    date: s.created_date || null,
    versionNumber: v?.version_number ?? null,
    complete: p.complete,
    weightedScore: s.survey_score_weighted !== null && s.survey_score_weighted !== undefined ? round(Number(s.survey_score_weighted)) : null,
    unweightedScore: s.survey_score_unweighted !== null && s.survey_score_unweighted !== undefined ? round(Number(s.survey_score_unweighted)) : null,
    answeredCount: p.answers.length,
  };
}

function buildSummarySheetRows(ctx, agg, events, perSubmission, anon, suppressed, versionNumbersPresent) {
  const s = agg.summary;
  const summarySheet = [
    ['Survey', ctx.form.name],
    ['Generated', new Date().toISOString()],
    ['Responses', s.responses],
    ['Completed', s.completed],
    ['Partial', s.partial],
    ['Average weighted score (0-1)', s.weightedAverage ?? ''],
    ['Average unweighted score (0-1)', s.unweightedAverage ?? ''],
    ['Total raw score', s.totalRawScore ?? ''],
    ['Versions included', versionNumbersPresent.join(', ')],
    ['Anonymous survey', anon.isAnonymous ? 'Yes' : 'No'],
    ...(anon.isAnonymous ? [['Respondent detail suppressed', suppressed ? `Yes (below threshold of ${anon.threshold})` : 'No']] : []),
  ];
  const eventsSheet = [
    ['Event', 'Date', 'Responses', 'Weighted average', 'Unweighted average', 'Best category', 'Worst category'],
    ...events.map((e) => [e.eventTitle, e.eventDate || '', e.responses, e.weightedAverage ?? '', e.unweightedAverage ?? '', e.bestCategory?.category || '', e.worstCategory?.category || '']),
  ];
  const questionsSheet = [
    ['Question', 'Category', 'Range', 'Valid', 'Skipped', 'N/A', 'Raw average', 'Normalised average (0-1)', 'Weighted contribution (0-1)', 'Min', 'Max', 'Weight', 'In overall'],
    ...agg.questions.map((q) => [q.label, q.category || '', `${q.rangeMin}-${q.rangeMax}`, q.validCount, q.skippedCount, q.naCount, q.rawAverage ?? '', q.normalisedAverage ?? '', q.weightedContribution ?? '', q.minScore ?? '', q.maxScore ?? '', q.weight, q.includeInOverall ? 'Yes' : 'No']),
  ];
  const categoriesSheet = [
    ['Category', 'Valid answers', 'N/A', 'Raw average', 'Normalised average (0-1)', 'Weighted average (0-1)'],
    ...agg.categories.map((c) => [c.category, c.validCount, c.naCount, c.rawAverage ?? '', c.normalisedAverage ?? '', c.weightedAverage ?? '']),
  ];
  return {
    summarySheet, eventsSheet, questionsSheet, categoriesSheet,
    csvSections: [summarySheet, eventsSheet, questionsSheet, categoriesSheet],
  };
}

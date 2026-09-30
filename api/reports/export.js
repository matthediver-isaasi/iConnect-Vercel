import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  parseFilters,
  buildRangePredicate,
  buildStageMaps,
  mkMatchers,
  getVerifiedAt,
  getOutcomeAt,
  getDecisionAt,
  findCurrentStageEnteredAt,
  findActorForFirstTransition,
  CANONICAL,
  toCsv,
  formatDuration,
} from './_ddReportHelpers.js';

const REPORT_TYPES = new Set(['funnel', 'verification', 'due-diligence', 'decisions']);

const fmtDate = (d) => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString();
};

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    const { tenantId } = tenantContext;
    const reportType = String(req.query.reportType || req.query.report || '').toLowerCase();
    if (!REPORT_TYPES.has(reportType)) {
      return res.status(400).json({ error: `Invalid report type. Must be one of: ${Array.from(REPORT_TYPES).join(', ')}` });
    }
    const filters = parseFilters(req.query);
    const inFilterRange = buildRangePredicate(filters);
    const now = new Date();

    let formsQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    if (filters.formId) formsQuery = formsQuery.eq('form_id', filters.formId);
    const { data: ddConfigs } = await formsQuery;
    const formIds = (ddConfigs || []).map((c) => c.form_id);
    if (formIds.length === 0) return sendCsv(res, `${reportType}-empty.csv`, 'no_data\n');

    const { stageMaps, isHeldDecisionForForm } = buildStageMaps(ddConfigs);
    const matchers = mkMatchers(stageMaps);

    const { data: ddRows } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, due_diligence_score, risk_level, created_at, archived_at, reviewed_by, application_uid')
      .eq('tenant_id', tenantId)
      .is('archived_at', null);

    const fsIds = (ddRows || []).map((r) => r.form_submission_id).filter(Boolean);
    const fsMap = {};
    if (fsIds.length > 0) {
      const { data: fsList } = await supabase
        .from('form_submission')
        .select('id, form_id, created_at, updated_at')
        .in('id', fsIds);
      (fsList || []).forEach((fs) => { fsMap[fs.id] = fs; });
    }

    const enriched = (ddRows || [])
      .map((r) => {
        const fs = fsMap[r.form_submission_id];
        if (!fs || !formIds.includes(fs.form_id)) return null;
        return {
          ...r,
          _formId: fs.form_id,
          _submissionCreatedAt: fs.created_at || r.created_at,
          _submissionUpdatedAt: fs.updated_at || r.created_at,
        };
      })
      .filter(Boolean);

    if (reportType === 'funnel') {
      const rows = enriched
        .filter((s) => inFilterRange(s._submissionCreatedAt))
        .map((s) => ({
          submission_id: s.form_submission_id,
          application_uid: s.application_uid || '',
          form_id: s._formId,
          workflow_status: s.workflow_status,
          created_at: fmtDate(s._submissionCreatedAt),
          last_status_change_at: fmtDate(findCurrentStageEnteredAt(s.history_log, s.workflow_status, s._submissionCreatedAt)),
          age_days: Math.round((now - new Date(s._submissionCreatedAt)) / 86_400_000 * 10) / 10,
        }));
      const csv = toCsv(rows, [
        { key: 'submission_id', label: 'Submission ID' },
        { key: 'application_uid', label: 'Application UID' },
        { key: 'form_id', label: 'Form ID' },
        { key: 'workflow_status', label: 'Workflow Status' },
        { key: 'created_at', label: 'Created At' },
        { key: 'last_status_change_at', label: 'Entered Current Stage At' },
        { key: 'age_days', label: 'Age (days)' },
      ]);
      return sendCsv(res, `funnel-${Date.now()}.csv`, csv);
    }

    if (reportType === 'verification') {
      const rows = enriched
        .map((s) => {
          const verifiedAt = getVerifiedAt(s, matchers);
          const enteredAt = findCurrentStageEnteredAt(s.history_log, s.workflow_status, s._submissionCreatedAt);
          const isVerified = matchers.isVerified(s.workflow_status);
          const isOutstanding = matchers.isInReview(s.workflow_status) || matchers.isNew(s.workflow_status) || !s.workflow_status;
          if (!isVerified && !isOutstanding) return null;
          if (isVerified && verifiedAt && !inFilterRange(verifiedAt)) return null;
          // Outstanding rows: filter by history-derived current-stage entry
          // timestamp so the CSV matches the verification stats outstanding
          // cohort (which moved off submission-creation time).
          if (!isVerified) {
            const outstandingAt = enteredAt || (s._submissionCreatedAt ? new Date(s._submissionCreatedAt) : null);
            if (!outstandingAt || !inFilterRange(outstandingAt)) return null;
          }
          const reviewer = isVerified
            ? (findActorForFirstTransition(s.history_log, (c) => c === CANONICAL.verified || matchers.isVerified(c)) || s.reviewed_by || '')
            : '';
          return {
            submission_id: s.form_submission_id,
            application_uid: s.application_uid || '',
            form_id: s._formId,
            workflow_status: s.workflow_status,
            state: isVerified ? 'verified' : 'outstanding',
            reviewer,
            created_at: fmtDate(s._submissionCreatedAt),
            verified_at: fmtDate(verifiedAt),
            current_stage_entered_at: fmtDate(enteredAt),
            turnaround_days: isVerified && verifiedAt
              ? Math.round((verifiedAt - new Date(s._submissionCreatedAt)) / 86_400_000 * 10) / 10
              : '',
            age_days: !isVerified
              ? Math.round((now - (enteredAt || new Date(s._submissionCreatedAt))) / 86_400_000 * 10) / 10
              : '',
          };
        })
        .filter(Boolean);
      const csv = toCsv(rows, [
        { key: 'submission_id', label: 'Submission ID' },
        { key: 'application_uid', label: 'Application UID' },
        { key: 'form_id', label: 'Form ID' },
        { key: 'workflow_status', label: 'Workflow Status' },
        { key: 'state', label: 'State' },
        { key: 'reviewer', label: 'Reviewer' },
        { key: 'created_at', label: 'Created At' },
        { key: 'verified_at', label: 'Verified At' },
        { key: 'current_stage_entered_at', label: 'Current Stage Entered At' },
        { key: 'turnaround_days', label: 'Turnaround (days)' },
        { key: 'age_days', label: 'Outstanding Age (days)' },
      ]);
      return sendCsv(res, `verification-${Date.now()}.csv`, csv);
    }

    if (reportType === 'due-diligence') {
      // Mirror the stats endpoint cohort definitions: a row qualifies when its
      // outcome transition (preferred) OR verified-stage transition falls in
      // the active range. Falls back to submission creation time only when no
      // history transition is available so legacy rows still appear.
      // The scheduling_days metric is verified -> outcome (matches stats).
      const rows = enriched
        .map((s) => {
          const outcomeAt = getOutcomeAt(s, matchers);
          const verifiedAt = getVerifiedAt(s, matchers);
          const eventAt = outcomeAt || verifiedAt
            || (s._submissionCreatedAt ? new Date(s._submissionCreatedAt) : null);
          if (!eventAt || !inFilterRange(eventAt)) return null;
          const startAt = verifiedAt
            || (s._submissionCreatedAt ? new Date(s._submissionCreatedAt) : null);
          return {
            submission_id: s.form_submission_id,
            application_uid: s.application_uid || '',
            form_id: s._formId,
            workflow_status: s.workflow_status,
            score: s.due_diligence_score ?? '',
            risk_level: s.risk_level ?? '',
            created_at: fmtDate(s._submissionCreatedAt),
            verified_at: fmtDate(verifiedAt),
            outcome_at: fmtDate(outcomeAt),
            scheduling_days: outcomeAt && startAt
              ? Math.round((outcomeAt - startAt) / 86_400_000 * 10) / 10
              : '',
          };
        })
        .filter(Boolean);
      const csv = toCsv(rows, [
        { key: 'submission_id', label: 'Submission ID' },
        { key: 'application_uid', label: 'Application UID' },
        { key: 'form_id', label: 'Form ID' },
        { key: 'workflow_status', label: 'Workflow Status' },
        { key: 'score', label: 'DD Score' },
        { key: 'risk_level', label: 'Risk Level' },
        { key: 'created_at', label: 'Created At' },
        { key: 'verified_at', label: 'Verified At' },
        { key: 'outcome_at', label: 'Meeting Outcome At' },
        { key: 'scheduling_days', label: 'Scheduling (days)' },
      ]);
      return sendCsv(res, `due-diligence-${Date.now()}.csv`, csv);
    }

    if (reportType === 'decisions') {
      const rows = enriched
        .map((s) => {
          const isApproved = matchers.isApproved(s.workflow_status);
          const isDeclined = matchers.isRejected(s.workflow_status);
          const isOnHold = matchers.isHeld(s.workflow_status) && isHeldDecisionForForm(s._formId);
          if (!isApproved && !isDeclined && !isOnHold) return null;
          const decisionAt = getDecisionAt(s, matchers, isHeldDecisionForForm, s._formId);
          if (decisionAt && !inFilterRange(decisionAt)) return null;
          if (!decisionAt && !inFilterRange(s._submissionCreatedAt)) return null;
          const reviewer = findActorForFirstTransition(s.history_log, (c) => {
            if (isApproved) return matchers.isApproved(c);
            if (isDeclined) return matchers.isRejected(c);
            return matchers.isHeld(c);
          }) || '';
          return {
            submission_id: s.form_submission_id,
            application_uid: s.application_uid || '',
            form_id: s._formId,
            workflow_status: s.workflow_status,
            decision: isApproved ? 'approved' : isDeclined ? 'declined' : 'on_hold',
            score: s.due_diligence_score ?? '',
            risk_level: s.risk_level ?? '',
            reviewer,
            created_at: fmtDate(s._submissionCreatedAt),
            decision_at: fmtDate(decisionAt),
            time_to_decision_days: decisionAt
              ? Math.round((decisionAt - new Date(s._submissionCreatedAt)) / 86_400_000 * 10) / 10
              : '',
          };
        })
        .filter(Boolean);
      const csv = toCsv(rows, [
        { key: 'submission_id', label: 'Submission ID' },
        { key: 'application_uid', label: 'Application UID' },
        { key: 'form_id', label: 'Form ID' },
        { key: 'workflow_status', label: 'Workflow Status' },
        { key: 'decision', label: 'Decision' },
        { key: 'score', label: 'DD Score' },
        { key: 'risk_level', label: 'Risk Level' },
        { key: 'reviewer', label: 'Reviewer' },
        { key: 'created_at', label: 'Created At' },
        { key: 'decision_at', label: 'Decision At' },
        { key: 'time_to_decision_days', label: 'Time to Decision (days)' },
      ]);
      return sendCsv(res, `decisions-${Date.now()}.csv`, csv);
    }

    return res.status(400).json({ error: 'Unsupported report type' });
  } catch (error) {
    console.error('[reports/export] fatal', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

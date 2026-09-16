import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canonicalizeKey, findCurrentStageEnteredAt } from '../reports/_ddReportHelpers.js';
import {
  attachDueDiligenceReferences,
  getDueDiligenceReferenceProjection,
  resolveDueDiligenceSubmissionReferences,
} from './submissionReferences.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

function parseBoundedInteger(value, fallback, { min, max, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    const error = new Error(`${name} must be a finite non-negative integer`);
    error.statusCode = 400;
    throw error;
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} must be between ${min} and ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

/**
 * Reports cards link out to this endpoint with canonical status keys
 * (e.g. `in-review`, `verified`, `dd-meet-attended`, `held`, `approved`,
 * `rejected`, `new`, `incomplete`). Each tenant's workflow_status however is
 * a tenant-configurable stage_id. Translate canonical -> { all equivalent
 * stored representations } so the dashboard cohort matches regardless of
 * whether the row stores a stage UUID or a label.
 */
async function resolveStatusValues(status, formId, tenantId) {
  if (!status) return null;
  const rawCanonical = canonicalizeKey(status);
  const candidates = new Set([status]);
  // Common label spellings derived from the canonical key.
  candidates.add(rawCanonical);
  candidates.add(rawCanonical.replace(/\s+/g, '-'));
  candidates.add(rawCanonical.replace(/\s+/g, '_'));
  candidates.add(
    rawCanonical
      .split(' ')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ')
  );
  try {
    let cfgQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId);
    if (formId) cfgQuery = cfgQuery.eq('form_id', formId);
    const { data: configs } = await cfgQuery;
    (configs || []).forEach((cfg) => {
      const stages = cfg.workflow_stages || [];
      stages.forEach((stage) => {
        if (canonicalizeKey(stage.label) === rawCanonical && stage.id) {
          candidates.add(stage.id);
        }
      });
    });
  } catch (err) {
    console.error('[DD List] Stage id resolution error:', err);
  }
  return Array.from(candidates).filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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
    const { formId, status, riskLevel, startDate, endDate } = req.query;
    const limit = parseBoundedInteger(req.query.limit, DEFAULT_LIMIT, {
      min: 1,
      max: MAX_LIMIT,
      name: 'limit',
    });
    const offset = parseBoundedInteger(req.query.offset, 0, {
      min: 0,
      max: MAX_OFFSET,
      name: 'offset',
    });

    // Optional submission-date range (ISO datetimes, inclusive). Reject
    // unparseable values explicitly rather than silently ignoring them.
    let startIso = null;
    let endIso = null;
    if (startDate) {
      const d = new Date(startDate);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate' });
      }
      startIso = d.toISOString();
    }
    if (endDate) {
      const d = new Date(endDate);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid endDate' });
      }
      endIso = d.toISOString();
    }
    if (startIso && endIso && endIso < startIso) {
      return res.status(400).json({ error: 'endDate must not be before startDate' });
    }

    // Check if we should include archived submissions
    const includeArchived = req.query.includeArchived === 'true';

    let query = supabase
      .from('form_submission_due_diligence')
      .select(`
        id,
        form_submission_id,
        application_uid,
        workflow_status,
        due_diligence_score,
        risk_level,
        reviewed_by,
        reviewed_date,
        created_at,
        updated_at,
        history_log,
        original_form_values,
        archived_at,
        archived_reason,
        swapped_from_submission_id,
        swapped_to_submission_id,
        owner_member_id,
        owner_name,
         form_submission:form_submission_id!inner(
          id,
          form_id,
           tenant_id,
          submission_data,
          status,
          created_date,
           organization_id,
           member_id,
           created_member_id,
           created_organization_id
        )
      `, { count: 'exact' })
      .eq('tenant_id', tenantCtx.tenantId)
       .eq('form_submission.tenant_id', tenantCtx.tenantId)
      .order('created_at', { ascending: false })
       .range(offset, offset + limit - 1);

    // By default, exclude archived submissions
    if (!includeArchived) {
      query = query.is('archived_at', null);
    }

    if (status) {
      const resolvedStatuses = await resolveStatusValues(status, formId, tenantCtx.tenantId);
      if (resolvedStatuses && resolvedStatuses.length > 0) {
        query = query.in('workflow_status', resolvedStatuses);
      } else {
        query = query.eq('workflow_status', status);
      }
    }

    if (riskLevel) {
      query = query.eq('risk_level', riskLevel);
    }

    // Apply the form filter to the joined relation before range/limit so the
    // returned page and exact count describe the same cohort.
    if (formId) {
      query = query.eq('form_submission.form_id', formId);
    }

    if (startIso) {
      query = query.gte('created_at', startIso);
    }
    if (endIso) {
      query = query.lte('created_at', endIso);
    }

    const { data: submissions, error: listError, count } = await query;

    if (listError) {
      console.error('[DD List] Query error:', listError);
      return res.status(500).json({ error: 'Failed to list submissions' });
    }

    let filteredSubmissions = submissions || [];

    // Compute current_stage_entered_at from history_log so the dashboard's
    // outstanding-days drill-through is accurate (falls back to updated_at /
    // created_at when no transition is logged).
    filteredSubmissions = filteredSubmissions.map((sub) => {
      const log = Array.isArray(sub.history_log)
        ? sub.history_log
        : (sub.history_log
            ? (() => { try { return JSON.parse(sub.history_log); } catch { return []; } })()
            : []);
      const enteredAt = findCurrentStageEnteredAt(log, sub.workflow_status, sub.updated_at || sub.created_at);
      return {
        ...sub,
        current_stage_entered_at: enteredAt ? enteredAt.toISOString() : null,
      };
    });

    // Resolve member and organisation references independently.  A member
    // UUID must never be sent through the organisation lookup; the resolver
    // also checks the typed pipeline entity links for legacy submissions.
    const formSubmissions = filteredSubmissions
      .map((submission) => submission.form_submission)
      .filter(Boolean);
    const references = await resolveDueDiligenceSubmissionReferences({
      db: supabase,
      tenantId: tenantCtx.tenantId,
      formSubmissions,
    });
    filteredSubmissions = filteredSubmissions.map((submission) => ({
      ...submission,
      ...getDueDiligenceReferenceProjection(submission.form_submission, references),
      form_submission: attachDueDiligenceReferences(
        submission.form_submission,
        references,
      ),
    }));

    // Collect all reviewed_by emails to look up member names
    const reviewerEmails = [...new Set(
      filteredSubmissions
        .map(s => s.reviewed_by)
        .filter(Boolean)
    )];

    // Fetch member names for reviewers
    let reviewerMap = {};
    if (reviewerEmails.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('email, first_name, last_name')
        .in('email', reviewerEmails)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (members) {
        reviewerMap = Object.fromEntries(
          members.map(m => [m.email, `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email])
        );
      }
    }

    // Attach reviewer names to submissions
    filteredSubmissions = filteredSubmissions.map(sub => {
      if (sub.reviewed_by && reviewerMap[sub.reviewed_by]) {
        return {
          ...sub,
          reviewed_by_name: reviewerMap[sub.reviewed_by]
        };
      }
      return sub;
    });

    // Collect all form IDs to look up form names
    const formIds = [...new Set(
      filteredSubmissions
        .map(s => s.form_submission?.form_id)
        .filter(Boolean)
    )];

    // Fetch form names
    let formMap = {};
    if (formIds.length > 0) {
      const { data: forms } = await supabase
        .from('form')
       .select('id, name, application_level')
        .in('id', formIds)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (forms) {
        formMap = Object.fromEntries(forms.map(f => [
          f.id,
          { name: f.name, application_level: f.application_level || 'member' },
        ]));
      }
    }

    // Attach form names to submissions
    filteredSubmissions = filteredSubmissions.map(sub => {
      const formId = sub.form_submission?.form_id;
       if (formId && formMap[formId]) {
        return {
          ...sub,
           form_name: formMap[formId].name,
           application_level: formMap[formId].application_level,
        };
      }
      return sub;
    });
    // Recompute the entity label once the form's application level is known.
    // This prevents organisation applications that also create a contact
    // from being labelled with the member name.
    filteredSubmissions = filteredSubmissions.map((sub) => {
      const formId = sub.form_submission?.form_id;
      const form = formId ? formMap[formId] : null;
      return {
        ...sub,
        ...getDueDiligenceReferenceProjection(sub.form_submission, references, {
          applicationLevel: form?.application_level || 'member',
          applicationUid: sub.application_uid,
        }),
      };
    });

    return res.status(200).json({
      success: true,
      submissions: filteredSubmissions,
       total: count || 0,
       limit,
       offset
    });

  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('[DD List] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

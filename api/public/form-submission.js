import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest, getHostFromRequest } from '../_lib/tenantResolver.js';
import { executeStageActions } from '../due-diligence/_stageActions.js';
import { sendSubmitterCopyEmail } from '../forms/send-submitter-copy.js';
import { getSessionMember } from '../_lib/session.js';
import { sendSubmissionEmailsGuarded } from '../_lib/formSubmissionEmails.js';
import { scoreSubmission, redactIdentityAnswers, anonymizeSubmissionRecord, activeVersionNumber } from '../_lib/surveyScoring.js';
import { createHmac } from 'node:crypto';
import { assignmentSubmissionRejection, respondentKeyInput, requiresAssignmentLink } from '../_lib/surveyAssignment.js';
import { resolveSubmitControl } from '../_lib/formSubmitControl.js';
import { rulesUseLmicOperators } from '../_lib/formLmicConditions.js';
import { loadTenantLmicCodes } from '../_lib/tenantLmicCodes.js';
import { computeHiddenFieldIds, findPaymentField, derivePaymentAmount } from '../_lib/formFieldVisibility.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import {
  createFormCommunicationSnapshot,
  collectMemberPipelineCommunicationSelections,
  finalizeFormCommunicationSnapshot,
  prepareInitialMemberCommunicationSnapshot,
  promoteAwaitingMemberCommunicationSnapshot,
  safeSubscriptionDiagnostic,
} from '../_lib/formCommunicationSubscriptions.js';
import { snapshotFormNotListedLabels } from '../../shared/formNotListedChoice.js';
import { validateFormOrganisationGroupAnswers } from '../_lib/formOrganisationGroups.js';
import { validateRepeatableRowSubmission } from '../_lib/formRepeatableRowValidation.js';

export default async function handler(req, res) {
  console.log('[Public Form Submission] === ENDPOINT CALLED ===');
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { form_id, form_name, answers, submission_data, source, tenant, prefill_organization_id, contract_instance_id, role_id: clientRoleId, brief_id, vacancy_id, submitterCopyRequested, submitterCopyEmail, idempotency_key, assignment_token } = req.body;
  console.log('[Public Form Submission] form_id:', form_id, 'form_name:', form_name, 'brief_id:', brief_id || 'none', 'vacancy_id:', vacancy_id || 'none');

  if (!form_id) {
    return res.status(400).json({ error: 'Form ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenantData = await resolveTenantFromRequest(req);
    // Use host from request, or derive from tenant domain if not available
    const host = getHostFromRequest(req) || (tenantData?.domain) || `${tenantData?.slug}.iconn.app`;

    if (!tenantData) {
      console.error('[Public Form Submission] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Verify the form exists and belongs to this tenant
    // Include fields, entity_pipelines, field_mappings for post-submission processing
    // Include due_diligence_required for auto-creating DD records
    // Include communication_category_id for newsletter subscription
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, name, tenant_id, require_authentication, access_policy, fields, entity_pipelines, field_mappings, application_level, due_diligence_required, communication_category_id, allow_submitter_email_copy, prevent_duplicate_email_submission, is_event_related, related_event_id, deactivate_at, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type, survey_settings')
      .eq('id', form_id)
      .eq('tenant_id', tenantData.id)
      .eq('is_active', true)
      .single();

    if (formError || !form) {
      console.error('[Public Form Submission] Form not found:', { 
        form_id, 
        tenant_id: tenantData.id, 
        error: formError?.message,
        code: formError?.code 
      });
      return res.status(404).json({ error: 'Form not found' });
    }

    // Scheduled deactivation: reject submissions once the configured time has
    // passed, even though is_active is still true. Mirrors the read-time guard
    // in api/public/form/[slug].js so a known form_id can't be POSTed after the
    // deadline.
    if (!isFormScheduleAvailable(form)) {
      return res.status(404).json({ error: 'Form not found or inactive' });
    }

    // Resolve the authenticated submitter (if any) from the server-side
    // session. Public form submissions are session-OPTIONAL: a logged-in
    // member who applies (e.g. a vacancy "Express interest") should have their
    // real name persisted, but a truly anonymous/public visitor with no
    // session must still succeed. We never trust the client-sent name — it is
    // derived from the session member here. Any session lookup failure is
    // swallowed so it can never block a public submission.
    let sessionMemberName = null;
    let sessionMemberEmail = null;
    let hasTenantSession = false;
    try {
      const sessionMember = await getSessionMember(req);
      // Only honour a session that belongs to THIS tenant, so a member's
      // session for another tenant can't attach their identity here. A member's
      // tenant may be set directly or inherited from their organisation
      // (mirrors api/_lib/tenantContext.js resolution).
      const memberTenantId =
        sessionMember?.tenant_id || sessionMember?.organization?.tenant_id || null;
      if (sessionMember && memberTenantId === tenantData.id) {
        hasTenantSession = true;
        const fullName = [sessionMember.first_name, sessionMember.last_name]
          .filter((p) => typeof p === 'string' && p.trim())
          .join(' ')
          .trim();
        sessionMemberName = fullName || null;
        if (typeof sessionMember.email === 'string' && sessionMember.email.trim()) {
          sessionMemberEmail = sessionMember.email.trim().toLowerCase();
        }
      }
    } catch (sessionErr) {
      console.warn('[Public Form Submission] Session member lookup failed (continuing as anonymous):', sessionErr?.message);
    }

    // Forms that require authentication cannot be submitted publicly —
    // EXCEPT surveys with a verified same-tenant session: surveys always
    // submit through this endpoint (it's the only scoring path), so an
    // authenticated member with a valid session for this tenant is allowed.
    if (form.require_authentication) {
      const isAuthedSurvey = form.form_type === 'survey' && hasTenantSession;
      if (!isAuthedSurvey) {
        return res.status(403).json({ error: 'This form requires authentication' });
      }
    }

    const formAccess = await resolveFormAccess({
      supabase,
      req,
      tenantId: tenantData.id,
      policy: form.access_policy,
    });
    if (!formAccess.allowed) return sendFormAccessDenied(res, formAccess);

    // --- Event survey assignment (Task #3331) ---------------------------
    // When the survey was opened via an assignment link, the ASSIGNMENT is
    // the source of truth for the event, the response window and the access
    // mode. The client sends only the opaque token — event id, assignment id
    // and version are all stamped server-side from the resolved row.
    let surveyAssignment = null;
    if (assignment_token) {
      if (form.form_type !== 'survey') {
        return res.status(400).json({ error: 'Assignment links are only valid for surveys' });
      }
      const { data: assignmentRow, error: assignmentErr } = await supabase
        .from('event_survey_assignment')
        .select('*')
        .eq('token', String(assignment_token))
        .eq('tenant_id', tenantData.id)
        .eq('form_id', form.id)
        .maybeSingle();
      if (assignmentErr || !assignmentRow) {
        return res.status(404).json({ error: 'Survey assignment not found' });
      }
      const rejection = assignmentSubmissionRejection(assignmentRow, { hasTenantSession });
      if (rejection) {
        return res.status(rejection.status).json({ error: rejection.error, code: rejection.code });
      }
      surveyAssignment = assignmentRow;
    } else if (form.form_type === 'survey') {
      // Direct-access policy (Task #3331): once a survey has any ACTIVE event
      // assignment, responses are accepted ONLY through an assignment link —
      // the event is always server-resolved and the per-assignment dedupe
      // scope cannot be bypassed via the plain slug URL.
      const { data: activeAssignments, error: activeErr } = await supabase
        .from('event_survey_assignment')
        .select('id')
        .eq('form_id', form.id)
        .eq('tenant_id', tenantData.id)
        .eq('status', 'active')
        .limit(1);
      if (activeErr) {
        console.error('[Public Form Submission] Active-assignment check failed:', activeErr);
        return res.status(500).json({ error: 'Failed to validate submission' });
      }
      if (requiresAssignmentLink(activeAssignments?.length)) {
        return res.status(403).json({
          error: 'This survey collects responses through its event links. Please use the survey link you were given.',
          code: 'ASSIGNMENT_REQUIRED'
        });
      }
    }

    // --- Survey handling (Task #3330) -----------------------------------
    // For survey forms, answers are validated and scored server-side against
    // the PUBLISHED version snapshot — never client-supplied config. Weights,
    // ranges and reverse-scoring all come from the snapshot.
    const isSurvey = form.form_type === 'survey';
    const surveySettings = (isSurvey && form.survey_settings && typeof form.survey_settings === 'object')
      ? form.survey_settings
      : {};
    let surveyVersion = null;
    let surveyScoring = null;
    if (isSurvey) {
      if (surveySettings.status !== 'published') {
        return res.status(403).json({ error: 'This survey is not accepting responses' });
      }
      const { data: versionRow, error: versionError } = await supabase
        .from('survey_version')
        .select('id, version_number, fields, pages, visibility_rules, survey_settings')
        .eq('form_id', form.id)
        .eq('tenant_id', tenantData.id)
        // The ACTIVE snapshot is the one the published form points at
        // (current_version) — never just the highest version_number, which
        // could be a superseded snapshot after an older config is re-published.
        .eq('version_number', activeVersionNumber(surveySettings))
        .limit(1)
        .maybeSingle();
      if (versionError || !versionRow) {
        console.error('[Public Form Submission] Survey has no published version:', versionError?.message);
        return res.status(403).json({ error: 'This survey is not accepting responses' });
      }
      surveyVersion = versionRow;
      surveyScoring = scoreSubmission(surveyVersion, submission_data || {});
      if (surveyScoring.errors.length > 0) {
        return res.status(400).json({
          error: 'Survey answers failed validation',
          details: surveyScoring.errors
        });
      }
    }

    // Conditional-logic submit control (Task #3474): enforce the STORED
    // rules (published snapshot for surveys, live form otherwise) against
    // the submitted answers BEFORE any submission row or side effect. The
    // client disables the Submit button with the same shared evaluator, so
    // this only fires when the UI was bypassed.
    {
      let submitControlRules = null;
      if (isSurvey) {
        submitControlRules = surveyVersion?.visibility_rules;
      } else {
        const { data: rulesRow, error: rulesError } = await supabase
          .from('form')
          .select('visibility_rules')
          .eq('id', form_id)
          .maybeSingle();
        if (rulesError) {
          console.error('[Public Form Submission] Failed to load visibility rules for submit-control check:', rulesError);
          return res.status(500).json({ error: 'Failed to validate submission rules' });
        }
        submitControlRules = rulesRow?.visibility_rules;
      }
      // Task #3477: LMIC operators compare against the tenant's STORED LMIC
      // list so submit rules can't be bypassed.
      const submitControlOptions = {};
      if (rulesUseLmicOperators(submitControlRules)) {
        submitControlOptions.lmicCodes = await loadTenantLmicCodes(supabase, form?.tenant_id || tenantData?.id);
      }
      const submitControl = resolveSubmitControl(submitControlRules, submission_data || {}, submitControlOptions);
      if (submitControl.disabled) {
        return res.status(400).json({
          error: submitControl.message || 'This form cannot be submitted with the current answers.',
          code: 'SUBMIT_DISABLED_BY_RULE',
        });
      }

      // Task #3483: generic Payment field — a normal (unpaid) submit is
      // rejected when the form carries a VISIBLE payment field with a
      // positive server-derived amount and at least one enabled provider.
      // Such submissions must go through /api/public/form-payment so the
      // payment is taken; hidden-field / zero-amount cases legitimately
      // fall back to this plain path.
      if (!isSurvey) {
        const paymentField = findPaymentField(form);
        const enabledProviders = Array.isArray(paymentField?.payment_providers)
          ? paymentField.payment_providers : [];
        if (paymentField && enabledProviders.length > 0) {
          const amountDue = derivePaymentAmount(paymentField, submission_data || {});
          if (amountDue > 0) {
            // Need pages for hidden-page propagation (not in the main select).
            let pages = [];
            try {
              const { data: pagesRow } = await supabase
                .from('form')
                .select('pages')
                .eq('id', form_id)
                .maybeSingle();
              pages = pagesRow?.pages || [];
            } catch { /* best effort */ }
            const hiddenIds = computeHiddenFieldIds(
              { ...form, pages, visibility_rules: submitControlRules },
              submission_data || {},
              submitControlOptions
            );
            if (!hiddenIds.has(paymentField.id)) {
              return res.status(400).json({
                error: 'This form requires payment. Please complete payment to submit.',
                code: 'PAYMENT_REQUIRED',
              });
            }
          }
        }
      }
    }

    // Relationship dropdowns store record IDs. Validate those IDs against the
    // saved field, its submitted organisation parent, active relationship edge,
    // and active related record before any duplicate handling or side effects.
    try {
      await validateRepeatableRowSubmission({
        db: supabase,
        tenantId: tenantData.id,
        form: isSurvey ? { ...form, fields: surveyVersion?.fields || [] } : form,
        submissionData: submission_data || {},
      });
      await createFormRelationshipService({
        db: supabase,
        tenantId: tenantData.id,
      }).validateSubmission({
        form: isSurvey ? { ...form, fields: surveyVersion?.fields || [] } : form,
        submissionData: submission_data || {},
      });
    } catch (error) {
      if (error instanceof FormRelationshipError && error.status < 500) {
        if (error.details) {
          return res.status(400).json({
            error: 'Invalid repeatable row submission',
            code: error.code,
            details: error.details,
          });
        }
        return res.status(400).json({ error: 'Invalid relationship selection' });
      }
      console.error('[Public Form Submission] Relationship selection validation failed:', error);
      return res.status(500).json({ error: 'Failed to validate submission' });
    }

    try {
      await validateFormOrganisationGroupAnswers({
        db: supabase,
        tenantId: tenantData.id,
        fields: isSurvey ? (surveyVersion?.fields || []) : (form.fields || []),
        submissionData: submission_data || {},
      });
    } catch (error) {
      if (error?.code === 'INVALID_ORGANISATION_GROUP') {
        return res.status(400).json({ error: 'Invalid organisation group selection' });
      }
      console.error('[Public Form Submission] Organisation group validation failed:', error);
      return res.status(500).json({ error: 'Failed to validate submission' });
    }

    // Extract the submitter's email from the submission_data by walking the
    // form's fields and picking the first email-typed field (or any field
    // whose id/label looks email-ish) whose value parses as an email.
    // Returns null if no usable email is present.
    const extractSubmitterEmail = () => {
      const data = submission_data || {};
      // Surveys: derive identity ONLY from the immutable published snapshot's
      // fields (the same source used for validation/scoring/redaction).
      const fields = isSurvey ? (surveyVersion?.fields || []) : (form.fields || []);
      const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
      // Prefer fields explicitly typed as email or named like email.
      for (const field of fields) {
        if (!field || !field.id) continue;
        const idLower = (field.id || '').toLowerCase();
        const labelLower = (field.label || '').toLowerCase();
        const looksLikeEmail =
          field.type === 'email' ||
          idLower.includes('email') || idLower.includes('e-mail') ||
          labelLower.includes('email') || labelLower.includes('e-mail');
        if (!looksLikeEmail) continue;
        const val = data[field.id];
        if (isEmail(val)) return val.trim();
      }
      // Fallback: any string value that parses as an email.
      for (const value of Object.values(data)) {
        if (isEmail(value)) return value.trim();
      }
      return null;
    };

    // Resolve the submitter's canonical email ONCE. We use this both for the
    // duplicate-check below (when the toggle is on) and as the value we
    // persist on the new form_submission row, so future duplicate checks
    // compare against a single canonical column instead of re-scanning
    // arbitrary JSON blobs.
    const resolvedSubmitterEmail = extractSubmitterEmail();
    const canonicalSubmitterEmail = resolvedSubmitterEmail
      ? resolvedSubmitterEmail.trim().toLowerCase()
      : null;

    // --- Survey respondent identity & duplicate prevention (Task #3330) ---
    // identified          -> identity stored as usual
    // anonymous           -> no identity stored, no dedupe possible
    // anonymous_dedupe    -> no identity stored; a one-way hash of the
    //                        respondent (session/collected email) prevents
    //                        duplicates without being reversible to identity.
    // Identity/dedupe behaviour comes from the IMMUTABLE published snapshot's
    // settings — never the live row, which an admin could mutate after
    // publishing (e.g. flipping anonymous -> identified).
    const snapshotSettings = (isSurvey && surveyVersion?.survey_settings && typeof surveyVersion.survey_settings === 'object')
      ? surveyVersion.survey_settings
      : surveySettings;
    const surveyIdentityMode = isSurvey ? (snapshotSettings.response_identity || 'identified') : null;
    const surveyIsAnonymous = isSurvey && surveyIdentityMode !== 'identified';
    let surveyRespondentKey = null;
    if (isSurvey) {
      const respondentIdentity = sessionMemberEmail || canonicalSubmitterEmail || null;
      const wantsDedupe = surveyIdentityMode === 'anonymous_dedupe' ||
        (snapshotSettings.one_submission_per_respondent === true && surveyIdentityMode !== 'anonymous');
      // Fail CLOSED: dedupe-enabled surveys REQUIRE a canonical respondent
      // identity (verified session email or submitted email). Without one
      // there is no key to dedupe on, so an anonymous caller could submit
      // unlimited responses by simply omitting the email.
      if (wantsDedupe && !respondentIdentity) {
        return res.status(400).json({
          error: 'This survey requires an email address to prevent duplicate responses.',
          code: 'RESPONDENT_IDENTITY_REQUIRED'
        });
      }
      if (wantsDedupe && respondentIdentity) {
        // Keyed HMAC (server secret) rather than a bare hash so the stored
        // key cannot be reversed by offline guessing of common emails.
        // Fail CLOSED if the secret is missing — a predictable key would
        // make the "irreversible" hash guessable.
        if (!process.env.SESSION_SECRET) {
          console.error('[Public Form Submission] SESSION_SECRET missing — cannot derive survey respondent key');
          return res.status(500).json({ error: 'Server is not configured for anonymous duplicate prevention' });
        }
        // Assignment-scoped dedupe (Task #3331): the same reusable survey can
        // be assigned to MANY events — one response per respondent applies
        // per assignment, so the assignment id is part of the key. Direct
        // (non-assignment) responses keep the original per-form key; the two
        // scopes can never be mixed because the direct path is blocked while
        // any assignment is active (ASSIGNMENT_REQUIRED above). Concurrency
        // stays race-proof: same respondent + same assignment produce the
        // SAME key, so the unique partial index on
        // (form_id, survey_respondent_key) rejects the concurrent loser.
        surveyRespondentKey = createHmac('sha256', process.env.SESSION_SECRET)
          .update(respondentKeyInput(tenantData.id, form.id, surveyAssignment?.id || null, respondentIdentity))
          .digest('hex');
        const { data: priorResponse, error: priorErr } = await supabase
          .from('form_submission')
          .select('id')
          .eq('form_id', form.id)
          .eq('tenant_id', tenantData.id)
          .eq('survey_respondent_key', surveyRespondentKey)
          .limit(1)
          .maybeSingle();
        if (!priorErr && priorResponse) {
          return res.status(409).json({
            error: 'You have already responded to this survey.',
            duplicate: true
          });
        }
      }
    }

    // Enforce "one submission per email" if the form opts in. The check runs
    // BEFORE inserting the submission row and BEFORE any pipeline / DD /
    // contract / email side effects, so a duplicate produces no partial state.
    // If we can't extract an email from the submission, the setting silently
    // does not apply (documented behaviour — submissions without an email
    // cannot be deduplicated).
    if (form.prevent_duplicate_email_submission && canonicalSubmitterEmail) {
      // Compare against the canonical submitted_by_email column only.
      // .ilike() escapes nothing, but our regex above only accepts strings
      // matching ^[^\s@]+@[^\s@]+\.[^\s@]+$ so SQL LIKE metacharacters
      // (%, _) can never appear in canonicalSubmitterEmail.
      const { data: candidates, error: dupErr } = await supabase
        .from('form_submission')
        .select('id')
        .eq('form_id', form_id)
        .eq('tenant_id', tenantData.id)
        .ilike('submitted_by_email', canonicalSubmitterEmail)
        .limit(1);
      if (dupErr) {
        console.error('[Public Form Submission] Duplicate-email check failed:', dupErr);
        return res.status(500).json({ error: 'Failed to validate submission' });
      }
      if (candidates && candidates.length > 0) {
        console.log('[Public Form Submission] Rejecting duplicate-email submission for form', form_id);
        return res.status(409).json({
          error: 'This form has already been submitted using this email address.',
        });
      }
    }

    // --- Duplicate-submission guard (Task: prevent duplicate public submissions) ---
    // Builds the success payload for an already-existing submission row so a
    // duplicate attempt gets the ORIGINAL submission's success response
    // instead of creating a second row or surfacing an error.
    const originalSuccessResponse = (row) => res.status(200).json({
      success: true,
      id: row.id,
      message: 'Form submitted successfully',
      created_member_id: row.created_member_id || null,
      created_organization_id: row.organization_id || null,
      duplicate: true,
    });

    const resumeDuplicateFinalization = async (row) => {
      let state = row.communication_finalization_state;
      if (!state || state.status === 'completed') return originalSuccessResponse(row);
      if (state.status === 'awaiting_member') {
        if (!row.created_member_id) {
          return res.status(503).json({
            error: 'Your form is still being completed. Please retry.',
            code: 'COMMUNICATION_FINALIZATION_PENDING',
            submission_id: row.id,
            retryable: true,
          });
        }
        try {
          state = await promoteAwaitingMemberCommunicationSnapshot(supabase, row);
        } catch (error) {
          console.error('[Public Form Submission] Failed to promote awaiting-member snapshot:', {
            submission_id: row.id,
            diagnostic: safeSubscriptionDiagnostic(error),
          });
          return res.status(503).json({
            error: 'Your form was saved, but communication preferences are still being completed. Please retry.',
            code: 'COMMUNICATION_FINALIZATION_PENDING',
            submission_id: row.id,
            retryable: true,
          });
        }
      }
      try {
        await finalizeFormCommunicationSnapshot({
          database: supabase,
          tenantId: tenantData.id,
          submissionId: row.id,
          formId: form.id,
          snapshot: state,
        });
        return originalSuccessResponse(row);
      } catch (error) {
        console.error('[Public Form Submission] Duplicate communication finalization replay failed:', {
          submission_id: row.id,
          diagnostic: safeSubscriptionDiagnostic(error),
        });
        return res.status(503).json({
          error: 'Your form was saved, but communication preferences are still being completed. Please retry.',
          code: 'COMMUNICATION_FINALIZATION_PENDING',
          submission_id: row.id,
          retryable: true,
        });
      }
    };

    // 1) Idempotency key: the public form generates one key per form-filling
    //    session. If a submission with the same (form_id, key) already exists,
    //    short-circuit with its success payload. A unique partial index on
    //    (form_id, idempotency_key) makes this race-proof — see the 23505
    //    handling on the insert below.
    const idemKey = (typeof idempotency_key === 'string' && idempotency_key.trim().length >= 8 && idempotency_key.trim().length <= 128)
      ? idempotency_key.trim()
      : null;
    if (idemKey) {
      const { data: existing, error: idemErr } = await supabase
        .from('form_submission')
        .select('id, created_member_id, organization_id, communication_finalization_state')
        .eq('form_id', form_id)
        .eq('tenant_id', tenantData.id)
        .eq('idempotency_key', idemKey)
        .maybeSingle();
      if (idemErr && idemErr.code !== '42703') {
        console.error('[Public Form Submission] Idempotency lookup failed:', idemErr);
        return res.status(500).json({ error: 'Failed to validate submission' });
      }
      if (existing) {
        console.log('[Public Form Submission] Duplicate idempotency key — returning original submission', existing.id);
        return resumeDuplicateFinalization(existing);
      }
    }

    // 2) Short-window backstop for callers that don't send a key (curl,
    //    automated integrations, old cached clients): the same form + the same
    //    organisation or lowercased email within the last 10 seconds is treated
    //    as a duplicate burst, matching the double-click / retry pattern seen
    //    in production. Legitimate repeat submissions minutes apart are
    //    unaffected. Anonymous submissions with no email AND no organisation
    //    can't be matched and are allowed through unchanged.
    if (!idemKey && (canonicalSubmitterEmail || prefill_organization_id)) {
      try {
        const windowStart = new Date(Date.now() - 10 * 1000).toISOString();
        let windowQuery = supabase
          .from('form_submission')
          .select('id, created_member_id, organization_id, created_date, communication_finalization_state')
          .eq('form_id', form_id)
          .eq('tenant_id', tenantData.id)
          .gte('created_date', windowStart)
          .order('created_date', { ascending: true })
          .limit(1);
        if (prefill_organization_id && canonicalSubmitterEmail) {
          windowQuery = windowQuery.or(
            `organization_id.eq.${prefill_organization_id},submitted_by_email.eq.${canonicalSubmitterEmail}`
          );
        } else if (prefill_organization_id) {
          windowQuery = windowQuery.eq('organization_id', prefill_organization_id);
        } else {
          windowQuery = windowQuery.eq('submitted_by_email', canonicalSubmitterEmail);
        }
        const { data: recent, error: windowErr } = await windowQuery;
        if (windowErr) {
          // Backstop only — never block a legitimate submission on a guard failure.
          console.warn('[Public Form Submission] Duplicate-window check failed (continuing):', windowErr.message);
        } else if (recent && recent.length > 0) {
          console.log('[Public Form Submission] Duplicate within 10s window — returning original submission', recent[0].id);
          return resumeDuplicateFinalization(recent[0]);
        }
      } catch (windowCheckErr) {
        console.warn('[Public Form Submission] Duplicate-window check threw (continuing):', windowCheckErr?.message);
      }
    }

    const hasEntityPipelines = (form.entity_pipelines?.members?.length > 0) || (form.entity_pipelines?.organisations?.length > 0);
    const hasMemberPipelines = form.entity_pipelines?.members?.length > 0;
    const pipelineCommunicationSelections = collectMemberPipelineCommunicationSelections(
      form.entity_pipelines,
      submission_data || {}
    );
    let initialCommunicationSnapshot = surveyIsAnonymous
      ? null
      : createFormCommunicationSnapshot({
          form,
          submissionData: submission_data || {},
          mappedSelections: pipelineCommunicationSelections,
          fallbackEmail: canonicalSubmitterEmail || sessionMemberEmail || '',
        });
    initialCommunicationSnapshot = prepareInitialMemberCommunicationSnapshot(
      initialCommunicationSnapshot,
      hasMemberPipelines
    );
    let communicationSnapshot = initialCommunicationSnapshot;

    // Create the form submission - match FormView structure exactly
    // SECURITY: Include tenant_id for proper multi-tenant isolation
    // Persist the resolved submitter email (lowercased) on the row so
    // future duplicate-email checks (and the per-row admin views) have a
    // canonical column to read instead of re-deriving from submission_data.
    const submissionRecord = {
      form_id,
      form_name,
      // Prefer the email the form itself collected; fall back to the
      // authenticated member's email so logged-in applicants are attributable
      // even when the form has no email field.
      // Anonymous surveys must store NO member identity on the submission
      // (only the irreversible respondent hash when dedupe is enabled).
      submitted_by_email: surveyIsAnonymous ? null : (canonicalSubmitterEmail || sessionMemberEmail),
      // Persist the authenticated member's real name (null for genuinely
      // anonymous/public submissions, which keep falling back to the email /
      // "Anonymous submission" label in admin views).
      submitted_by_name: surveyIsAnonymous ? null : sessionMemberName,
      // Anonymous surveys: redact identity-bearing answers (email/phone/name/
      // contact/signature fields) from the stored payload as well — the
      // dedupe key above was already derived before redaction.
      // IMPORTANT: redaction uses the IMMUTABLE published snapshot's fields
      // (same source as validation/scoring) — never the mutable live form
      // config, which an admin could edit after publishing.
      submission_data: snapshotFormNotListedLabels(
        isSurvey ? (surveyVersion?.fields || []) : (form.fields || []),
        surveyIsAnonymous
          ? redactIdentityAnswers(surveyVersion.fields || [], submission_data || {}).data
          : (submission_data || {}),
      ),
      created_date: new Date().toISOString(),
      tenant_id: tenantData.id,
      ...(contract_instance_id && { contract_instance_id }),
      ...(prefill_organization_id && { organization_id: prefill_organization_id }),
      // For event-linked forms, associate the submission with the form's
      // chosen event so admins can review submissions per event.
      // Survey assignments (Task #3331) take precedence: the event comes
      // from the SERVER-resolved assignment, never a client-supplied id or
      // the form's single related_event_id link.
      ...(surveyAssignment
        ? {
            survey_assignment_id: surveyAssignment.id,
            ...(surveyAssignment.event_type === 'event' && surveyAssignment.event_id
              ? { event_id: surveyAssignment.event_id }
              : {}),
            ...(surveyAssignment.event_type === 'complex_event' && surveyAssignment.complex_event_id
              ? { complex_event_id: surveyAssignment.complex_event_id }
              : {})
          }
        : (form.is_event_related && form.related_event_id ? { event_id: form.related_event_id } : {})),
      // Task #1539: when the form was opened from a member-group vacancy
      // ("Express interest"), carry the vacancy association onto the row so the
      // group admin's submissions review modal can find it.
      ...(vacancy_id && { vacancy_id }),
      // Duplicate-submission guard: persist the key so retries/second tabs
      // hit the unique index instead of creating a second row.
      ...(idemKey && { idempotency_key: idemKey }),
      ...(!surveyIsAnonymous && {
        communication_finalization_state: initialCommunicationSnapshot,
      }),
      // Survey scoring (computed server-side against the published version)
      ...(isSurvey && {
        survey_version_id: surveyVersion.id,
        survey_score_weighted: surveyScoring.overallWeighted,
        survey_score_unweighted: surveyScoring.overallUnweighted,
        is_anonymous: surveyIsAnonymous,
        ...(surveyRespondentKey && { survey_respondent_key: surveyRespondentKey })
      })
    };

    // Anonymous surveys: final belt-and-braces anonymity pass — nulls member
    // identity AND network metadata (ip_address, user_agent) so no
    // construction path above can reintroduce respondent-identifying columns.
    const finalSubmissionRecord = surveyIsAnonymous
      ? anonymizeSubmissionRecord(submissionRecord)
      : submissionRecord;

    // Surveys write the submission row and normalised answer rows in ONE DB
    // transaction (RPC) — the answers ARE the survey result, so no
    // half-state is ever observable. Standard forms keep the plain insert.
    let submission = null;
    let insertError = null;
    if (isSurvey) {
      const answersPayload = surveyScoring.answers.map((answer) => ({
        ...answer,
        tenant_id: tenantData.id,
        form_id: form.id,
        survey_version_id: surveyVersion.id
      }));
      const { data: rpcRows, error: rpcError } = await supabase
        .rpc('create_survey_submission', {
          p_submission: finalSubmissionRecord,
          p_answers: answersPayload
        });
      submission = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      insertError = rpcError;
    } else {
      const insertResult = await supabase
        .from('form_submission')
        .insert(finalSubmissionRecord)
        .select()
        .single();
      submission = insertResult.data;
      insertError = insertResult.error;
    }

    // Race safety: two truly concurrent requests with the same idempotency
    // key both pass the pre-check above; the unique partial index on
    // (form_id, idempotency_key) rejects the loser with 23505. Return the
    // winner's row as the original success payload.
    // Race safety for survey respondent dedupe: the unique partial index on
    // (form_id, survey_respondent_key) rejects the concurrent loser — return
    // the same 409 the pre-insert check would have produced.
    if (insertError && insertError.code === '23505'
        && surveyRespondentKey
        && /respondent/i.test(`${insertError.message || ''}${insertError.details || ''}`)) {
      return res.status(409).json({
        error: 'A response has already been recorded for this respondent',
        code: 'DUPLICATE_SURVEY_RESPONSE'
      });
    }

    if (insertError && insertError.code === '23505' && idemKey) {
      console.log('[Public Form Submission] Concurrent duplicate (unique violation) — fetching original row');
      const { data: winner, error: winnerErr } = await supabase
        .from('form_submission')
        .select('id, created_member_id, organization_id, communication_finalization_state')
        .eq('form_id', form_id)
        .eq('tenant_id', tenantData.id)
        .eq('idempotency_key', idemKey)
        .maybeSingle();
      if (winner) {
        return resumeDuplicateFinalization(winner);
      }
      console.error('[Public Form Submission] Unique violation but original row not found:', winnerErr);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    if (insertError) {
      console.error('[Public Form Submission] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    console.log('[Public Form Submission] Submission created successfully:', submission.id);

    // Link submission back to article_brief if brief_id context parameter is present.
    // The submitted form may be either the case-study Permission form
    // (case_study_form_id -> case_study_submission_id) or the brief-level
    // Copyright Assignment form (copyright_form_id -> copyright_submission_id).
    // Anonymous surveys never link to article briefs — the brief inbox item
    // is built from unredacted submitted values (email/name/files).
    if (brief_id && !surveyIsAnonymous) {
      try {
        console.log('[Public Form Submission] Linking submission to article_brief:', brief_id);
        const { data: matchingBrief, error: briefLookupError } = await supabase
          .from('article_brief')
          .select('id, case_study_form_id, case_study_form_sent_at, case_study_submission_id, copyright_form_id, copyright_form_sent_at, copyright_submission_id')
          .eq('id', brief_id)
          .eq('tenant_id', tenantData.id)
          .maybeSingle();

        if (briefLookupError) {
          console.error('[Public Form Submission] Failed to look up brief for linking:', briefLookupError);
        } else if (!matchingBrief) {
          console.warn('[Public Form Submission] No matching brief found for linking (brief_id:', brief_id, ')');
        } else {
          // Slot matching is intentionally robust to in-flight form swaps: an
          // editor can change copyright_form_id (or case_study_form_id) on the
          // brief between hitting "Send" and the writer actually submitting,
          // which would otherwise orphan the submission against the *previous*
          // form. The simplest safe heuristic for each slot is to claim the
          // submission when ANY of:
          //   1. the slot's current form_id is null,
          //   2. the slot's current form_id equals the submitted form_id, OR
          //   3. the slot currently has no *_submission_id and *_form_sent_at
          //      is set (a send is outstanding for that slot, so this is the
          //      submission the editor was waiting on — even if they have
          //      since changed which form is selected).
          // Copyright is checked before case-study in the fallback because it
          // is the brief-level slot most likely to have been re-sent.
          const copyrightSlotClaim =
            matchingBrief.copyright_form_id === null ||
            matchingBrief.copyright_form_id === form_id ||
            (
              !matchingBrief.copyright_submission_id &&
              !!matchingBrief.copyright_form_sent_at
            );
          const caseStudySlotClaim =
            matchingBrief.case_study_form_id === null ||
            matchingBrief.case_study_form_id === form_id ||
            (
              !matchingBrief.case_study_submission_id &&
              !!matchingBrief.case_study_form_sent_at
            );

          // Direct form_id matches still take precedence (and case-study wins
          // a direct copyright match because the case-study slot is more
          // specific when the form_id is configured there).
          let updateField = null;
          if (matchingBrief.case_study_form_id === form_id) {
            updateField = 'case_study_submission_id';
          } else if (matchingBrief.copyright_form_id === form_id) {
            updateField = 'copyright_submission_id';
          } else if (copyrightSlotClaim) {
            updateField = 'copyright_submission_id';
          } else if (caseStudySlotClaim) {
            updateField = 'case_study_submission_id';
          }

          if (!updateField) {
            console.warn('[Public Form Submission] Submitted form does not match any brief form slot (brief_id:', brief_id, 'form_id:', form_id, ')');
          } else {
            const { error: briefUpdateError } = await supabase
              .from('article_brief')
              .update({ [updateField]: submission.id })
              .eq('id', brief_id)
              .eq('tenant_id', tenantData.id);

            if (briefUpdateError) {
              console.error('[Public Form Submission] Failed to link submission to brief:', briefUpdateError);
            } else {
              console.log('[Public Form Submission] Successfully linked submission to brief field', updateField, 'for brief:', brief_id);

              // Emit a Brief Management inbox item (permission/copyright). Files
              // attached to the submission ride along on metadata.files (not a
              // separate files_uploaded item) so one event = one inbox row.
              // Non-blocking: failures must not break the public submission.
              try {
                const eventType = updateField === 'copyright_submission_id'
                  ? 'copyright_submitted'
                  : 'permission_submitted';

                const fields = form.fields || [];
                let submitterEmailForInbox = null;
                let submitterFirstNameForInbox = null;
                let submitterLastNameForInbox = null;
                const uploadedFiles = [];

                for (const field of fields) {
                  const value = submission_data?.[field.id];
                  if (value === undefined || value === null || value === '') continue;

                  if (field.type === 'email' || field.id?.toLowerCase().includes('email')) {
                    if (!submitterEmailForInbox && typeof value === 'string') {
                      submitterEmailForInbox = value;
                    }
                  }
                  if (field.type === 'text') {
                    const idLower = (field.id || '').toLowerCase();
                    const labelLower = (field.label || '').toLowerCase();
                    if (idLower.includes('first_name') || labelLower.includes('first name')) {
                      if (!submitterFirstNameForInbox) submitterFirstNameForInbox = value;
                    }
                    if (idLower.includes('last_name') || labelLower.includes('last name')) {
                      if (!submitterLastNameForInbox) submitterLastNameForInbox = value;
                    }
                  }
                  if (field.type === 'file') {
                    try {
                      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
                      // Form file fields can be a single {file_url, file_name}
                      // object or an array of them (multi-file uploads).
                      const entries = Array.isArray(parsed) ? parsed : [parsed];
                      for (const entry of entries) {
                        if (entry && entry.file_url) {
                          uploadedFiles.push({
                            file_name: entry.file_name || null,
                            file_url: entry.file_url,
                            field_label: field.label || null,
                          });
                        }
                      }
                    } catch (parseErr) {
                      // Non-JSON file value; ignore
                    }
                  }
                }

                const submitterName = [submitterFirstNameForInbox, submitterLastNameForInbox]
                  .filter(Boolean)
                  .join(' ')
                  .trim() || null;

                const inboxMetadata = {
                  submission_id: submission.id,
                  form_id,
                  form_title: form.name || null,
                  submitter_email: submitterEmailForInbox,
                  submitter_name: submitterName,
                  file_count: uploadedFiles.length,
                };
                if (uploadedFiles.length > 0) {
                  inboxMetadata.files = uploadedFiles.slice(0, 10);
                }

                const { error: inboxInsertError } = await supabase
                  .from('article_brief_inbox_item')
                  .insert({
                    tenant_id: tenantData.id,
                    article_brief_id: brief_id,
                    event_type: eventType,
                    metadata: inboxMetadata,
                  });

                if (inboxInsertError) {
                  if (inboxInsertError.code === '42P01' || /does not exist/i.test(inboxInsertError.message || '')) {
                    console.warn('[Public Form Submission] article_brief_inbox_item table missing; skipping inbox creation');
                  } else {
                    console.error('[Public Form Submission] Failed to create inbox item:', inboxInsertError);
                  }
                } else {
                  console.log('[Public Form Submission] Created inbox item for brief', brief_id, 'event:', eventType);
                }
              } catch (inboxError) {
                console.error('[Public Form Submission] Error creating inbox item:', inboxError);
              }
            }
          }
        }
      } catch (briefLinkError) {
        console.error('[Public Form Submission] Error linking submission to brief:', briefLinkError);
      }
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;

    // Process entity pipelines if configured (members/organisations creation)
    let pipelineCreatedMemberId = null;
    let pipelineCreatedOrgId = null;
    // Anonymous surveys never run identity-creating pipelines.
    if (hasEntityPipelines && !surveyIsAnonymous) {
      try {
        console.log('[Public Form Submission] Processing entity pipelines for tenant:', tenantData.id);
        const pipelineResponse = await fetch(`${baseUrl}/api/forms/process-application`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            form_id: form.id,
            form_values: submission_data || {},
            fields: form.fields || [],
            field_mappings: form.field_mappings || [],
            application_level: form.application_level || 'member',
            submission_id: submission.id,
            prefill_organization_id: prefill_organization_id || null,
            role_id: clientRoleId || null,
            entity_pipelines: form.entity_pipelines,
            tenant_id: tenantData.id,
            defer_communication_subscriptions: true
          })
        });
        
        // Safely parse response - handle empty bodies and non-JSON responses
        const contentType = pipelineResponse.headers.get('content-type') || '';
        const hasJsonBody = contentType.includes('application/json');
        
        if (!pipelineResponse.ok) {
          // Pipeline failed - rollback the form_submission record to prevent orphaned data
          console.log('[Public Form Submission] Rolling back submission due to pipeline failure:', submission.id);
          await supabase.from('form_submission').delete().eq('id', submission.id);
          
          if (hasJsonBody) {
            try {
              const errorData = await pipelineResponse.json();
              console.error('[Public Form Submission] Entity pipeline processing failed:', errorData);
              
              // Return uniqueness conflict errors with user-friendly message
              if (pipelineResponse.status === 409 && errorData.code === 'UNIQUENESS_CONFLICT') {
                const conflictMessages = (errorData.conflicts || [])
                  .map(c => c.message || `${c.field_label}: Duplicate value`)
                  .join('. ');
                return res.status(409).json({
                  error: conflictMessages || 'A record with this information already exists',
                  conflicts: errorData.conflicts || [],
                  code: 'UNIQUENESS_CONFLICT'
                });
              }
              
              // Return all other pipeline errors to the frontend (don't swallow them)
              return res.status(pipelineResponse.status).json({
                error: errorData.error || errorData.message || 'Failed to process application',
                code: errorData.code || 'PIPELINE_ERROR'
              });
            } catch (parseErr) {
              console.error('[Public Form Submission] Entity pipeline failed with status:', pipelineResponse.status);
              return res.status(pipelineResponse.status).json({
                error: 'Failed to process application',
                code: 'PIPELINE_ERROR'
              });
            }
          } else {
            console.error('[Public Form Submission] Entity pipeline failed with status:', pipelineResponse.status);
            return res.status(pipelineResponse.status).json({
              error: 'Failed to process application',
              code: 'PIPELINE_ERROR'
            });
          }
        } else {
          if (hasJsonBody) {
            try {
              const result = await pipelineResponse.json();
              console.log('[Public Form Submission] Entity pipeline processed:', result);
              
              // If the pipeline resolved an organization (created or existing) and we don't already have an org ID,
              // update the submission record with the organization_id
              const resolvedOrgId = result.organization_id || result.created_organization_id;
              const resolvedMemberId = result.created_member_id || result.member_id;
              pipelineCreatedMemberId = resolvedMemberId || null;
              pipelineCreatedOrgId = resolvedOrgId || null;
              const submissionUpdates = {};
              if (resolvedOrgId && !submissionRecord.organization_id) {
                submissionUpdates.organization_id = resolvedOrgId;
              }
              communicationSnapshot = createFormCommunicationSnapshot({
                form,
                submissionData: submission_data || {},
                mappedSelections: pipelineCommunicationSelections,
                resolvedMemberId: pipelineCreatedMemberId,
                fallbackEmail: canonicalSubmitterEmail || sessionMemberEmail || '',
              });
              if (Object.keys(submissionUpdates).length > 0) {
                console.log('[Public Form Submission] Updating submission with:', JSON.stringify(submissionUpdates));
                const { error: updateError } = await supabase
                  .from('form_submission')
                  .update(submissionUpdates)
                  .eq('id', submission.id);
                
                if (updateError) {
                  console.error('[Public Form Submission] Failed to update submission:', updateError);
                } else {
                  console.log('[Public Form Submission] Submission updated successfully');
                }
              }
              if (hasMemberPipelines && resolvedMemberId) {
                try {
                  communicationSnapshot = await promoteAwaitingMemberCommunicationSnapshot(
                    supabase,
                    {
                      id: submission.id,
                      created_member_id: resolvedMemberId || null,
                      communication_finalization_state: initialCommunicationSnapshot,
                    },
                    communicationSnapshot
                  );
                } catch (promotionError) {
                  console.error('[Public Form Submission] Failed to promote final communication snapshot:', {
                    submission_id: submission.id,
                    diagnostic: safeSubscriptionDiagnostic(promotionError),
                  });
                  return res.status(503).json({
                    error: 'Your form was saved, but communication preferences could not be prepared. Please retry.',
                    code: 'COMMUNICATION_FINALIZATION_PENDING',
                    submission_id: submission.id,
                    retryable: true,
                  });
                }
              }
            } catch (parseErr) {
              console.log('[Public Form Submission] Entity pipeline completed (no JSON body)');
            }
          } else {
            console.log('[Public Form Submission] Entity pipeline completed successfully');
          }
        }
      } catch (err) {
        // Network/runtime error during pipeline processing - rollback and return error
        console.error('[Public Form Submission] Entity pipeline error:', err);
        console.log('[Public Form Submission] Rolling back submission due to pipeline error:', submission.id);
        try {
          await supabase.from('form_submission').delete().eq('id', submission.id);
        } catch (deleteErr) {
          console.error('[Public Form Submission] Failed to rollback submission:', deleteErr);
        }
        return res.status(502).json({
          error: 'Failed to process application. Please try again.',
          code: 'PIPELINE_NETWORK_ERROR'
        });
      }
    }

    // Identity must be resolved before subscriber type is chosen. In
    // particular, a member created by the pipeline above must never first be
    // persisted as an external subscriber.
    if (!surveyIsAnonymous) {
      try {
        await finalizeFormCommunicationSnapshot({
          database: supabase,
          tenantId: tenantData.id,
          submissionId: submission.id,
          formId: form.id,
          snapshot: communicationSnapshot,
        });
      } catch (subscriptionError) {
        console.error('[Public Form Submission] Communication finalization incomplete:', {
          submission_id: submission.id,
          diagnostic: safeSubscriptionDiagnostic(subscriptionError),
          state_diagnostic: subscriptionError.finalizationStateError || null,
        });
        return res.status(503).json({
          error: 'Your form was saved, but communication preferences could not be completed. Please retry.',
          code: 'COMMUNICATION_FINALIZATION_PENDING',
          submission_id: submission.id,
          retryable: true,
        });
      }
    }

    // Generate PDF for contract signatures and add history log
    // Anonymous surveys are incompatible with contract signing (a signature
    // IS identity) — never run the contract branch for them.
    if (contract_instance_id && !surveyIsAnonymous) {
      const hasSignatureData = Object.values(submission_data || {}).some(v => 
        v && typeof v === 'object' && (v.type === 'signature' || (v.data && v.signed_at))
      );
      
      if (hasSignatureData) {
        try {
          console.log('[Public Form Submission] Generating PDF for contract signature:', submission.id);
          const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
          if (!INTERNAL_API_SECRET) {
            console.error('[Public Form Submission] INTERNAL_API_SECRET not configured, skipping PDF generation');
          } else {
            const pdfResponse = await fetch(`${baseUrl}/api/contracts/generate-pdf`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                submissionId: submission.id,
                internalToken: INTERNAL_API_SECRET
              })
            });
          
            if (pdfResponse.ok) {
              const pdfResult = await pdfResponse.json();
              console.log('[Public Form Submission] PDF generated:', pdfResult);
            } else {
              const pdfError = await pdfResponse.json().catch(() => ({}));
              console.error('[Public Form Submission] PDF generation failed:', pdfError);
            }
          }
          
          // Update contract_instance signer status and overall status
          try {
            // Try multiple sources for signer email
            let signerEmail = (submission_data?.signer_email || submission_data?.email || '').toLowerCase();
            
            // If no direct email field, try to extract from signature field metadata
            if (!signerEmail) {
              for (const [key, value] of Object.entries(submission_data || {})) {
                if (value && typeof value === 'object' && (value.type === 'signature' || value.signed_at)) {
                  if (value.signer_email) {
                    signerEmail = value.signer_email.toLowerCase();
                    break;
                  }
                }
              }
            }
            
            // SECURITY: Fetch contract instance with tenant_id filter to prevent cross-tenant access
            const { data: contractInstance, error: ciError } = await supabase
              .from('contract_instance')
              .select('id, form_submission_id, form_id, signers, status, tenant_id')
              .eq('id', contract_instance_id)
              .eq('tenant_id', tenantData.id)
              .single();
            
            if (ciError) {
              console.error('[Public Form Submission] Failed to fetch contract instance:', ciError);
            } else if (contractInstance) {
              const signers = contractInstance.signers || [];
              let signerFound = false;
              
              // Mark the signer who just signed as signed=true
              const updatedSigners = signers.map(signer => {
                if ((signer.email || '').toLowerCase() === signerEmail && !signer.signed) {
                  signerFound = true;
                  return {
                    ...signer,
                    signed: true,
                    signed_at: new Date().toISOString(),
                    signature_submission_id: submission.id
                  };
                }
                return signer;
              });
              
              // If we couldn't match by email but there's only one unsigned signer, mark them
              if (!signerFound && signers.length === 1 && !signers[0].signed) {
                signerFound = true;
                updatedSigners[0] = {
                  ...updatedSigners[0],
                  signed: true,
                  signed_at: new Date().toISOString(),
                  signature_submission_id: submission.id
                };
                console.log(`[Public Form Submission] Single signer contract - marking as signed`);
              }
              
              if (signerFound) {
                // Check if all signers have now signed
                const allSigned = updatedSigners.length > 0 && updatedSigners.every(s => s.signed === true);
                const signedCount = updatedSigners.filter(s => s.signed === true).length;
                
                // Determine new status: 'signed' when all complete, 'received' for partial progress
                let newStatus = contractInstance.status;
                if (allSigned) {
                  newStatus = 'signed';
                } else if (signedCount > 0) {
                  newStatus = 'received';
                }
                
                // SECURITY: Update with tenant_id filter to prevent cross-tenant mutation
                const { error: updateError } = await supabase
                  .from('contract_instance')
                  .update({
                    signers: updatedSigners,
                    status: newStatus,
                    updated_at: new Date().toISOString(),
                    ...(allSigned && { completed_at: new Date().toISOString() })
                  })
                  .eq('id', contract_instance_id)
                  .eq('tenant_id', tenantData.id);
                
                if (updateError) {
                  console.error('[Public Form Submission] Failed to update contract instance:', updateError);
                } else {
                  console.log(`[Public Form Submission] Updated contract instance ${contract_instance_id}: signer marked as signed (${signedCount}/${updatedSigners.length}), status: ${newStatus}`);
                }
              } else {
                console.log(`[Public Form Submission] Signer ${signerEmail || 'unknown'} not found in contract instance signers list or already signed`);
              }
            }
          } catch (contractUpdateError) {
            console.error('[Public Form Submission] Error updating contract instance:', contractUpdateError);
          }
          
          // Add history log entry to related DD submission for contract signature
          try {
            const { data: contractInstance } = await supabase
              .from('contract_instance')
              .select('id, form_submission_id, form_id')
              .eq('id', contract_instance_id)
              .single();
            
            if (contractInstance?.form_submission_id) {
              const { data: ddSubmission } = await supabase
                .from('form_submission_due_diligence')
                .select('id, history_log')
                .eq('form_submission_id', contractInstance.form_submission_id)
                .eq('tenant_id', tenantData.id)
                .single();
              
              if (ddSubmission) {
                const { data: contractForm } = await supabase
                  .from('form')
                  .select('name')
                  .eq('id', contractInstance.form_id)
                  .single();
                
                const signerEmail = submission_data?.signer_email || submission_data?.email || 'Unknown';
                
                const historyLog = ddSubmission.history_log || [];
                historyLog.push({
                  timestamp: new Date().toISOString(),
                  event_type: 'contract_signed',
                  user_email: signerEmail,
                  details: {
                    contract_name: contractForm?.name || 'Contract',
                    signer: signerEmail
                  }
                });
                
                await supabase
                  .from('form_submission_due_diligence')
                  .update({ history_log: historyLog })
                  .eq('id', ddSubmission.id);
                
                console.log('[Public Form Submission] Added contract_signed history log to DD submission');
              }
            }
          } catch (historyError) {
            console.error('[Public Form Submission] Failed to add history log:', historyError);
          }
        } catch (pdfErr) {
          console.error('[Public Form Submission] PDF generation error:', pdfErr);
        }
      }
    }

    // Auto-create due diligence record if form has due diligence enabled
    console.log('[Public Form Submission] Checking DD enabled:', form.due_diligence_required, 'form_id:', form.id);
    // Anonymous surveys never create due-diligence records (they carry the
    // respondent's raw answers/identity into admin review surfaces).
    if (form.due_diligence_required && !surveyIsAnonymous) {
      try {
        console.log('[Public Form Submission] Creating due diligence record for submission:', submission.id);
        
        // Get the form's DD config for initial workflow status
        console.log('[Public Form Submission] Looking up DD config for form_id:', form_id, 'tenant_id:', tenantData.id);
        const { data: ddConfig, error: ddConfigError } = await supabase
          .from('form_due_diligence_config')
          .select('workflow_stages')
          .eq('form_id', form_id)
          .eq('tenant_id', tenantData.id)
          .single();
        
        if (ddConfigError) {
          console.log('[Public Form Submission] DD config lookup error:', ddConfigError.code, ddConfigError.message);
        }
        console.log('[Public Form Submission] DD config found:', !!ddConfig, 'workflow_stages count:', ddConfig?.workflow_stages?.length || 0);
        
        // Find initial stage
        const workflowStages = ddConfig?.workflow_stages || [];
        const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
        const initialStatus = initialStage?.id || 'new';
        console.log('[Public Form Submission] Initial stage:', initialStatus, 'is_initial flag:', initialStage?.is_initial, 'label:', initialStage?.label);
        
        // Create the DD submission record
        const ddRecord = {
          form_submission_id: submission.id,
          tenant_id: tenantData.id,
          application_uid: `DD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          original_form_values: submission_data || {},
          reviewed_form_values: submission_data || {},
          field_review_status: {},
          workflow_status: initialStatus,
          history_log: [{
            timestamp: new Date().toISOString(),
            event_type: 'submission_received',
            user_email: 'System',
            details: {
              form_submission_id: submission.id,
              initial_status: initialStatus
            }
          }]
        };

        const { data: newDDRecord, error: ddInsertError } = await supabase
          .from('form_submission_due_diligence')
          .insert(ddRecord)
          .select()
          .single();

        if (ddInsertError) {
          console.error('[Public Form Submission] Failed to create DD record:', ddInsertError);
          // Don't fail the submission, just log the error
        } else {
          console.log('[Public Form Submission] Due diligence record created:', newDDRecord.id);
          
          // Execute stage actions for the initial stage (e.g., send contracts, meeting requests, emails)
          // Always attempt to execute when there's an initial stage - the function handles its own config lookup
          // and checks for both inline actions (send_contracts) and database-stored actions (stage_email_action, etc.)
          if (initialStage) {
            const hasInlineActions = initialStage.actions || initialStage.stage_actions;
            const sendContractsFields = initialStage.stage_actions?.send_contracts || initialStage.actions?.send_contracts || [];
            console.log('[Public Form Submission] === STAGE ACTIONS DEBUG ===');
            console.log('[Public Form Submission] Form ID:', form.id);
            console.log('[Public Form Submission] Form Name:', form.name);
            console.log('[Public Form Submission] Initial stage ID:', initialStage.id);
            console.log('[Public Form Submission] Has inline actions:', !!hasInlineActions);
            console.log('[Public Form Submission] send_contracts fields:', JSON.stringify(sendContractsFields));
            console.log('[Public Form Submission] Full stage config:', JSON.stringify(initialStage));
            
            try {
              const ddSubmissionData = {
                ...newDDRecord,
                form_submission_id: submission.id,
                form_id: form.id
              };
              console.log('[Public Form Submission] Executing stage actions for initial stage:', initialStatus);
              const actionResults = await executeStageActions(
                initialStatus,
                ddSubmissionData,
                tenantData.id,
                'system_init'
              );
              
              if (actionResults?.stage_actions_results?.length > 0) {
                console.log('[Public Form Submission] Initial stage actions executed:', JSON.stringify(actionResults.stage_actions_results));
              } else {
                console.log('[Public Form Submission] No stage action results returned');
              }
            } catch (actionError) {
              console.error('[Public Form Submission] Error executing initial stage actions:', actionError);
              // Don't fail the submission for action errors
            }
          } else {
            console.log('[Public Form Submission] No initial stage found, skipping stage actions');
          }
        }
      } catch (ddError) {
        console.error('[Public Form Submission] Error creating DD record:', ddError);
        // Don't fail the submission for DD errors
      }
    }

    // Task #3190: send configured submission emails SERVER-SIDE so they fire
    // reliably on every submission path (redirects, embeds, ad-blockers, JS
    // errors can no longer lose them). The shared sender atomically claims
    // form_submission.submission_email_state, so the retained legacy client
    // call to /api/forms/send-submission-email becomes a no-op afterwards
    // (exactly-once). Failures are recorded durably on the row and NEVER
    // block the submission success response.
    // Anonymous surveys send NO configured submission emails at all: the
    // email sender resolves recipients/content from live form config and
    // raw values (field mappings), which could disclose respondent-provided
    // identity. Skipping entirely is the only safe behaviour.
    if (surveyIsAnonymous) {
      console.log('[Public Form Submission] Anonymous survey — submission emails skipped');
    } else try {
      const emailSendResult = await sendSubmissionEmailsGuarded({
        supabase,
        form,
        formValues: submission_data || {},
        fields: form.fields || [],
        submissionId: submission.id,
        createdMemberId: pipelineCreatedMemberId || null,
        createdOrganizationId: pipelineCreatedOrgId || null,
        baseUrl,
        trigger: 'server',
        allowUnguarded: false,
      });
      console.log('[Public Form Submission] Submission emails processed:', JSON.stringify({
        success: emailSendResult.success,
        skipped: emailSendResult.skipped || false,
        reason: emailSendResult.reason || null,
        emails: (emailSendResult.emails || []).length,
      }));
    } catch (submissionEmailErr) {
      console.error('[Public Form Submission] Submission email send threw (non-fatal):', submissionEmailErr);
    }

    // Task #944: If the form allows it AND the submitter ticked the box on
    // the public form, email them a Word (DOCX) copy of their submission.
    // Wrapped in try/catch so any failure here NEVER blocks the submission
    // success response (the user has already submitted successfully).
    if (
      form.allow_submitter_email_copy &&
      !surveyIsAnonymous &&
      submitterCopyRequested === true &&
      typeof submitterCopyEmail === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitterCopyEmail.trim())
    ) {
      try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || '';
        const origin = hostHeader ? `${protocol}://${hostHeader}` : (process.env.VITE_APP_URL || '');
        console.log('[Public Form Submission] Sending submitter Word copy to:', submitterCopyEmail.trim());
        const copyResult = await sendSubmitterCopyEmail({
          form,
          submission,
          recipientEmail: submitterCopyEmail.trim(),
          origin,
        });
        if (copyResult?.success) {
          console.log('[Public Form Submission] Submitter copy email sent:', copyResult.messageId || '(no messageId)');
        } else {
          console.warn('[Public Form Submission] Submitter copy email failed (non-fatal):', copyResult?.error);
        }
      } catch (copyErr) {
        console.error('[Public Form Submission] Submitter copy email threw (non-fatal):', copyErr);
      }
    }

    return res.status(201).json({
      success: true,
      id: submission.id,
      message: 'Form submitted successfully',
      created_member_id: pipelineCreatedMemberId || null,
      created_organization_id: pipelineCreatedOrgId || null
    });
  } catch (error) {
    console.error('[Public Form Submission] Error:', error);
    return res.status(500).json({ error: 'Failed to process submission' });
  }
}

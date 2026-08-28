// Task #3312 — Group admins download vacancy application PDFs.
//
// Given an application source ('submission' = form-linked form_submission,
// 'application' = legacy "express interest" vacancy_application), this
// endpoint:
//   - authorises the caller as a group admin of the vacancy's group (or a
//     tenant admin), mirroring the vacancy-decision authorisation;
//   - builds a PDF via the shared form-submission PDF builder (same rendering
//     as Due Diligence contract PDFs);
//   - uploads it to private storage and returns a short-lived signed URL.
//
// Legacy message-only applications get a simple synthetic field layout
// (applicant name/email, application date, message, status).

import { createClient } from '@supabase/supabase-js';
import {
  getCallerGroupManageAccess,
  canManageGroup,
} from '../_lib/memberGroupAdminAccess.js';
import {
  buildFormSubmissionPdf,
  loadFormSubmissionOrganisationLabels,
  loadFormSubmissionRelationshipLabels,
  loadFormSubmissionOrganisationGroupLabels,
} from '../_lib/formSubmissionPdf.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const SIGNED_URL_TTL_SECONDS = 300; // short-lived

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function sanitizeFilePart(text, fallback) {
  const cleaned = String(text || '')
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return cleaned || fallback;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { source_type: sourceType, source_id: sourceId } = req.query;
    if (sourceType !== 'submission' && sourceType !== 'application') {
      return res.status(400).json({ error: "source_type must be 'submission' or 'application'" });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'source_id is required' });
    }

    // Authorisation: tenant admins (any group) or active group admins.
    const access = await getCallerGroupManageAccess(req);
    if (access.error) {
      return res.status(access.status || 403).json({ error: access.error });
    }
    const tenantId = access.tenantContext?.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let vacancy = null;
    let title = '';
    let dateLabel = '';
    let fields = [];
    let submissionData = {};
    let relationshipLabelsByRecordId = {};
    let organisationNamesById = {};
    let organisationGroupNamesById = {};
    let applicantPart = 'applicant';

    if (sourceType === 'submission') {
      const { data: submission, error: subError } = await supabase
        .from('form_submission')
        .select('id, tenant_id, vacancy_id, created_date, submitted_by_name, submitted_by_email, submission_data, form:form_id(id, name, fields, tenant_id)')
        .eq('id', sourceId)
        .maybeSingle();
      if (subError) {
        console.error('[vacancy-application-pdf] submission fetch error:', subError);
        return res.status(500).json({ error: 'Failed to load submission' });
      }
      if (!submission) return res.status(404).json({ error: 'Submission not found' });
      if (submission.tenant_id && submission.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!submission.vacancy_id) {
        return res.status(400).json({ error: 'This submission is not linked to a vacancy' });
      }

      const { data: vac, error: vacErr } = await supabase
        .from('vacancy')
        .select('id, tenant_id, member_group_id, role_title')
        .eq('id', submission.vacancy_id)
        .maybeSingle();
      if (vacErr) {
        console.error('[vacancy-application-pdf] vacancy fetch error:', vacErr);
        return res.status(500).json({ error: 'Failed to load vacancy' });
      }
      if (!vac) return res.status(404).json({ error: 'Vacancy not found' });
      if (vac.tenant_id && vac.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!canManageGroup(access, vac.member_group_id)) {
        return res.status(403).json({ error: 'You do not have permission to manage this group.' });
      }
      vacancy = vac;

      const who = submission.submitted_by_name || submission.submitted_by_email || 'Applicant';
      title = vacancy.role_title || submission.form?.name || 'Application';
      const submittedDate = formatDate(submission.created_date);
      dateLabel = [
        `Applicant: ${who}${submission.submitted_by_email && submission.submitted_by_name ? ` <${submission.submitted_by_email}>` : ''}`,
        submittedDate ? `Submitted: ${submittedDate}` : null,
      ].filter(Boolean).join('  |  ');
      fields = Array.isArray(submission.form?.fields) ? submission.form.fields : [];
      submissionData = submission.submission_data || {};
      relationshipLabelsByRecordId = await loadFormSubmissionRelationshipLabels({
        db: supabase,
        tenantId,
        fields,
        submissionData,
      });
      organisationNamesById = await loadFormSubmissionOrganisationLabels({
        db: supabase,
        tenantId,
        fields,
        submissionData,
      });
      organisationGroupNamesById = await loadFormSubmissionOrganisationGroupLabels({
        db: supabase,
        tenantId,
        fields,
        submissionData,
      });
      applicantPart = sanitizeFilePart(who, 'applicant');
    } else {
      // Legacy "express interest" application.
      const { data: application, error: appErr } = await supabase
        .from('vacancy_application')
        .select('id, tenant_id, vacancy_id, member_id, message, status, created_at')
        .eq('id', sourceId)
        .maybeSingle();
      if (appErr) {
        console.error('[vacancy-application-pdf] application fetch error:', appErr);
        return res.status(500).json({ error: 'Failed to load application' });
      }
      if (!application) return res.status(404).json({ error: 'Application not found' });
      if (application.tenant_id && application.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }

      const { data: vac, error: vacErr } = await supabase
        .from('vacancy')
        .select('id, tenant_id, member_group_id, role_title')
        .eq('id', application.vacancy_id)
        .maybeSingle();
      if (vacErr) {
        console.error('[vacancy-application-pdf] vacancy fetch error:', vacErr);
        return res.status(500).json({ error: 'Failed to load vacancy' });
      }
      if (!vac) return res.status(404).json({ error: 'Vacancy not found' });
      if (vac.tenant_id && vac.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!canManageGroup(access, vac.member_group_id)) {
        return res.status(403).json({ error: 'You do not have permission to manage this group.' });
      }
      vacancy = vac;

      let member = null;
      if (application.member_id) {
        const { data: m } = await supabase
          .from('member')
          .select('id, first_name, last_name, email, tenant_id')
          .eq('id', application.member_id)
          .maybeSingle();
        if (m && (!m.tenant_id || m.tenant_id === tenantId)) member = m;
      }
      const applicantName = [member?.first_name, member?.last_name].filter(Boolean).join(' ') || 'Unknown member';

      title = vacancy.role_title || 'Vacancy application';
      const appliedDate = formatDate(application.created_at);
      dateLabel = appliedDate ? `Applied: ${appliedDate}` : '';

      // Simple synthetic field layout for the legacy record.
      fields = [
        { id: 'applicant_name', label: 'Applicant', type: 'text' },
        { id: 'applicant_email', label: 'Email', type: 'text' },
        { id: 'application_date', label: 'Application date', type: 'text' },
        { id: 'message', label: 'Message', type: 'text' },
        { id: 'status', label: 'Status', type: 'text' },
      ];
      submissionData = {
        applicant_name: applicantName,
        applicant_email: member?.email || '-',
        application_date: appliedDate || '-',
        message: application.message || '-',
        status: application.status || 'pending',
      };
      applicantPart = sanitizeFilePart(applicantName, 'applicant');
    }

    const pdfBuffer = buildFormSubmissionPdf({
      title,
      dateLabel,
      fields,
      submissionData,
      relationshipLabelsByRecordId,
      organisationNamesById,
      organisationGroupNamesById,
      logPrefix: '[vacancy-application-pdf]',
    });

    const vacancyPart = sanitizeFilePart(vacancy.role_title, 'vacancy');
    const fileName = `${vacancyPart}_${applicantPart}.pdf`;
    // Deterministic per-source path: repeated downloads overwrite the same
    // object instead of accumulating timestamped copies, so storage stays
    // bounded at one PDF per application.
    const storageDir = `${tenantId}/vacancy-applications`;
    const storageName = `${sourceType}_${sourceId}.pdf`;
    const storagePath = `${storageDir}/${storageName}`;

    // Size of any existing object, so the tenant storage counter tracks the
    // delta rather than double-counting regenerations.
    let previousSize = 0;
    try {
      const { data: listed } = await supabase.storage
        .from('private-uploads')
        .list(storageDir, { search: storageName, limit: 1 });
      const entry = Array.isArray(listed) ? listed.find((e) => e.name === storageName) : null;
      const n = Number(entry?.metadata?.size);
      if (Number.isFinite(n) && n > 0) previousSize = n;
    } catch {}

    const { error: uploadError } = await supabase.storage
      .from('private-uploads')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadError) {
      console.error('[vacancy-application-pdf] upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to store PDF' });
    }
    addTenantStorageBytes(tenantId, pdfBuffer.length - previousSize).catch(() => {});

    const { data: signed, error: signError } = await supabase.storage
      .from('private-uploads')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: fileName });
    if (signError || !signed?.signedUrl) {
      console.error('[vacancy-application-pdf] sign error:', signError);
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    return res.status(200).json({
      success: true,
      downloadUrl: signed.signedUrl,
      fileName,
    });
  } catch (error) {
    console.error('[vacancy-application-pdf] Error:', error);
    return res.status(500).json({ error: 'Failed to generate application PDF', details: error.message });
  }
}
/*
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { source_type: sourceType, source_id: sourceId } = req.query;
    if (sourceType !== 'submission' && sourceType !== 'application') {
      return res.status(400).json({ error: "source_type must be 'submission' or 'application'" });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'source_id is required' });
    }

    // Authorisation: tenant admins (any group) or active group admins.
    const access = await getCallerGroupManageAccess(req);
    if (access.error) {
      return res.status(access.status || 403).json({ error: access.error });
    }
    const tenantId = access.tenantContext?.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let vacancy = null;
    let title = '';
    let dateLabel = '';
    let fields = [];
    let submissionData = {};
    let relationshipLabelsByRecordId = {};
    let organisationNamesById = {};
    let applicantPart = 'applicant';

    if (sourceType === 'submission') {
      const { data: submission, error: subError } = await supabase
        .from('form_submission')
        .select('id, tenant_id, vacancy_id, created_date, submitted_by_name, submitted_by_email, submission_data, form:form_id(id, name, fields, tenant_id)')
        .eq('id', sourceId)
        .maybeSingle();
      if (subError) {
        console.error('[vacancy-application-pdf] submission fetch error:', subError);
        return res.status(500).json({ error: 'Failed to load submission' });
      }
      if (!submission) return res.status(404).json({ error: 'Submission not found' });
      if (submission.tenant_id && submission.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!submission.vacancy_id) {
        return res.status(400).json({ error: 'This submission is not linked to a vacancy' });
      }

      const { data: vac, error: vacErr } = await supabase
        .from('vacancy')
        .select('id, tenant_id, member_group_id, role_title')
        .eq('id', submission.vacancy_id)
        .maybeSingle();
      if (vacErr) {
        console.error('[vacancy-application-pdf] vacancy fetch error:', vacErr);
        return res.status(500).json({ error: 'Failed to load vacancy' });
      }
      if (!vac) return res.status(404).json({ error: 'Vacancy not found' });
      if (vac.tenant_id && vac.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!canManageGroup(access, vac.member_group_id)) {
        return res.status(403).json({ error: 'You do not have permission to manage this group.' });
      }
      vacancy = vac;

      const who = submission.submitted_by_name || submission.submitted_by_email || 'Applicant';
      title = vacancy.role_title || submission.form?.name || 'Application';
      const submittedDate = formatDate(submission.created_date);
      dateLabel = [
        `Applicant: ${who}${submission.submitted_by_email && submission.submitted_by_name ? ` <${submission.submitted_by_email}>` : ''}`,
        submittedDate ? `Submitted: ${submittedDate}` : null,
      ].filter(Boolean).join('  |  ');
      fields = Array.isArray(submission.form?.fields) ? submission.form.fields : [];
      submissionData = submission.submission_data || {};
      relationshipLabelsByRecordId = await loadFormSubmissionRelationshipLabels({
        db: supabase,
        tenantId,
        fields,
        submissionData,
      });
      organisationNamesById = await loadFormSubmissionOrganisationLabels({
        db: supabase, tenantId, fields, submissionData,
      });
      applicantPart = sanitizeFilePart(who, 'applicant');
    } else {
      // Legacy "express interest" application.
      const { data: application, error: appErr } = await supabase
        .from('vacancy_application')
        .select('id, tenant_id, vacancy_id, member_id, message, status, created_at')
        .eq('id', sourceId)
        .maybeSingle();
      if (appErr) {
        console.error('[vacancy-application-pdf] application fetch error:', appErr);
        return res.status(500).json({ error: 'Failed to load application' });
      }
      if (!application) return res.status(404).json({ error: 'Application not found' });
      if (application.tenant_id && application.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }

      const { data: vac, error: vacErr } = await supabase
        .from('vacancy')
        .select('id, tenant_id, member_group_id, role_title')
        .eq('id', application.vacancy_id)
        .maybeSingle();
      if (vacErr) {
        console.error('[vacancy-application-pdf] vacancy fetch error:', vacErr);
        return res.status(500).json({ error: 'Failed to load vacancy' });
      }
      if (!vac) return res.status(404).json({ error: 'Vacancy not found' });
      if (vac.tenant_id && vac.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
      if (!canManageGroup(access, vac.member_group_id)) {
        return res.status(403).json({ error: 'You do not have permission to manage this group.' });
      }
      vacancy = vac;

      let member = null;
      if (application.member_id) {
        const { data: m } = await supabase
          .from('member')
          .select('id, first_name, last_name, email, tenant_id')
          .eq('id', application.member_id)
          .maybeSingle();
        if (m && (!m.tenant_id || m.tenant_id === tenantId)) member = m;
      }
      const applicantName = [member?.first_name, member?.last_name].filter(Boolean).join(' ') || 'Unknown member';

      title = vacancy.role_title || 'Vacancy application';
      const appliedDate = formatDate(application.created_at);
      dateLabel = appliedDate ? `Applied: ${appliedDate}` : '';

      // Simple synthetic field layout for the legacy record.
      fields = [
        { id: 'applicant_name', label: 'Applicant', type: 'text' },
        { id: 'applicant_email', label: 'Email', type: 'text' },
        { id: 'application_date', label: 'Application date', type: 'text' },
        { id: 'message', label: 'Message', type: 'text' },
        { id: 'status', label: 'Status', type: 'text' },
      ];
      submissionData = {
        applicant_name: applicantName,
        applicant_email: member?.email || '-',
        application_date: appliedDate || '-',
        message: application.message || '-',
        status: application.status || 'pending',
      };
      applicantPart = sanitizeFilePart(applicantName, 'applicant');
    }

    const pdfBuffer = buildFormSubmissionPdf({
      title,
      dateLabel,
      fields,
      submissionData,
      relationshipLabelsByRecordId,
      organisationNamesById,
      logPrefix: '[vacancy-application-pdf]',
    });

    const vacancyPart = sanitizeFilePart(vacancy.role_title, 'vacancy');
    const fileName = `${vacancyPart}_${applicantPart}.pdf`;
    // Deterministic per-source path: repeated downloads overwrite the same
    // object instead of accumulating timestamped copies, so storage stays
    // bounded at one PDF per application.
    const storageDir = `${tenantId}/vacancy-applications`;
    const storageName = `${sourceType}_${sourceId}.pdf`;
    const storagePath = `${storageDir}/${storageName}`;

    // Size of any existing object, so the tenant storage counter tracks the
    // delta rather than double-counting regenerations.
    let previousSize = 0;
    try {
      const { data: listed } = await supabase.storage
        .from('private-uploads')
        .list(storageDir, { search: storageName, limit: 1 });
      const entry = Array.isArray(listed) ? listed.find((e) => e.name === storageName) : null;
      const n = Number(entry?.metadata?.size);
      if (Number.isFinite(n) && n > 0) previousSize = n;
    } catch {}

    const { error: uploadError } = await supabase.storage
      .from('private-uploads')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadError) {
      console.error('[vacancy-application-pdf] upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to store PDF' });
    }
    addTenantStorageBytes(tenantId, pdfBuffer.length - previousSize).catch(() => {});

    const { data: signed, error: signError } = await supabase.storage
      .from('private-uploads')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: fileName });
    if (signError || !signed?.signedUrl) {
      console.error('[vacancy-application-pdf] sign error:', signError);
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    return res.status(200).json({
      success: true,
      downloadUrl: signed.signedUrl,
      fileName,
    });
  } catch (error) {
    console.error('[vacancy-application-pdf] Error:', error);
    return res.status(500).json({ error: 'Failed to generate application PDF', details: error.message });
  }
}
*/

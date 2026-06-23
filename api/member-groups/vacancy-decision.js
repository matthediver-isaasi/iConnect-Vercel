// Task #1700 — Vacancy approve/decline decision emails.
//
// Given an application/submission + a decision type ('approval' | 'decline'),
// this endpoint:
//   - authorises the caller as a group admin of the vacancy's group (or a
//     tenant admin) — the same authorisation the award flow runs under;
//   - resolves the applicant's first name + email;
//   - loads the group's chosen approval/decline email template and renders the
//     subject through the existing placeholder pipeline;
//   - sends the admin's edited body (which already carries the auto-injected
//     "Dear {first name}," greeting) + optional CC via the tenant send path
//     (sendEmail never throws — its return value is inspected);
//   - records the sent email in vacancy_decision_email (success OR failure);
//   - for an approval, performs the existing award logic (vacancy_award +
//     member_group_assignment with the role term snapshot);
//   - for a decline, records the declined decision in vacancy_decline.
//
// This is a tenant->recipient email, so it does NOT set systemEmail.

import { getSessionMember } from '../_lib/session.js';
import { sendEmail, replacePlaceholders } from '../_lib/emailService.js';
import {
  getCallerGroupManageAccess,
  canManageGroup,
} from '../_lib/memberGroupAdminAccess.js';
import { buildTermSnapshot } from '../_lib/memberGroupTermSnapshot.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  // Authorisation: tenant admins (any group) or active group admins (their
  // groups only). Mirrors the award flow's group-admin guardrails.
  const access = await getCallerGroupManageAccess(req);
  if (access.error) {
    return res.status(access.status || 403).json({ error: access.error });
  }
  const tenantId = access.tenantContext?.tenantId;
  if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

  const {
    group_id,
    vacancy_id,
    decision_type,
    source_type,
    source_id,
    member_id,
    email,
    body_html,
    cc,
  } = req.body || {};

  if (!group_id) return res.status(400).json({ error: 'group_id is required' });
  if (!vacancy_id) return res.status(400).json({ error: 'vacancy_id is required' });
  if (decision_type !== 'approval' && decision_type !== 'decline') {
    return res.status(400).json({ error: "decision_type must be 'approval' or 'decline'" });
  }
  if (!body_html || typeof body_html !== 'string' || !body_html.replace(/<[^>]*>/g, '').trim()) {
    return res.status(400).json({ error: 'Email body is required' });
  }
  if (!canManageGroup(access, group_id)) {
    return res.status(403).json({ error: 'You do not have permission to manage this group.' });
  }

  // Load the group (tenant-scoped) for its template ids + term definitions.
  const { data: group, error: groupErr } = await supabase
    .from('member_group')
    .select('id, tenant_id, role_term_definitions, approval_email_template_id, decline_email_template_id')
    .eq('id', group_id)
    .maybeSingle();
  if (groupErr) {
    console.error('[vacancy-decision] group lookup failed:', groupErr);
    return res.status(500).json({ error: 'Failed to load group' });
  }
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.tenant_id && group.tenant_id !== tenantId) {
    return res.status(403).json({ error: 'Cross-tenant access denied' });
  }

  // Load the vacancy and verify it belongs to this tenant + group.
  const { data: vacancy, error: vacErr } = await supabase
    .from('vacancy')
    .select('id, tenant_id, member_group_id, role_title, positions_available')
    .eq('id', vacancy_id)
    .maybeSingle();
  if (vacErr) {
    console.error('[vacancy-decision] vacancy lookup failed:', vacErr);
    return res.status(500).json({ error: 'Failed to load vacancy' });
  }
  if (!vacancy) return res.status(404).json({ error: 'Vacancy not found' });
  if (vacancy.tenant_id && vacancy.tenant_id !== tenantId) {
    return res.status(403).json({ error: 'Cross-tenant access denied' });
  }
  if (vacancy.member_group_id && vacancy.member_group_id !== group_id) {
    return res.status(400).json({ error: 'Vacancy does not belong to this group' });
  }

  // The decision template must be configured on the group.
  const templateId = decision_type === 'approval'
    ? group.approval_email_template_id
    : group.decline_email_template_id;
  if (!templateId) {
    return res.status(400).json({
      error: decision_type === 'approval'
        ? 'No approval email template is configured for this group. Set one in the group settings.'
        : 'No decline email template is configured for this group. Set one in the group settings.',
    });
  }

  const { data: template, error: tmplErr } = await supabase
    .from('email_template')
    .select('id, tenant_id, subject, body')
    .eq('id', templateId)
    .maybeSingle();
  if (tmplErr) {
    console.error('[vacancy-decision] template lookup failed:', tmplErr);
    return res.status(500).json({ error: 'Failed to load email template' });
  }
  if (!template || (template.tenant_id && template.tenant_id !== tenantId)) {
    return res.status(400).json({ error: 'The configured email template could not be found.' });
  }

  // Resolve the applicant: by member id (applications) or by email (form
  // submissions, which carry no member id). Approval requires a member record.
  let resolvedMember = null;
  if (member_id) {
    const { data: m } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, tenant_id')
      .eq('id', member_id)
      .maybeSingle();
    if (m && (!m.tenant_id || m.tenant_id === tenantId)) resolvedMember = m;
  }
  if (!resolvedMember && email && EMAIL_RE.test(String(email).trim())) {
    const { data: matches } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, tenant_id')
      .eq('tenant_id', tenantId)
      .eq('email', String(email).trim().toLowerCase())
      .limit(1);
    if (matches && matches[0]) resolvedMember = matches[0];
  }

  const toEmail = (resolvedMember?.email || email || '').toString().trim();
  if (!toEmail || !EMAIL_RE.test(toEmail)) {
    return res.status(400).json({ error: 'A valid recipient email could not be resolved for this applicant.' });
  }
  const ccEmail = cc && typeof cc === 'string' && cc.trim() ? cc.trim() : null;
  if (ccEmail && !EMAIL_RE.test(ccEmail)) {
    return res.status(400).json({ error: 'The CC address is not a valid email.' });
  }

  const role = (vacancy.role_title || '').trim();

  // Placeholder data for subject/body rendering (member-scoped).
  const placeholderData = {
    first_name: resolvedMember?.first_name || '',
    last_name: resolvedMember?.last_name || '',
    email: toEmail,
    role_title: role,
  };
  const subject = replacePlaceholders(template.subject || '', 'member', placeholderData, { tenantId }).trim()
    || (decision_type === 'approval' ? 'Your application' : 'Your application');
  // The body already carries the admin's edits + injected greeting; still run it
  // through the placeholder pipeline so any remaining tokens resolve.
  const html = replacePlaceholders(body_html, 'member', placeholderData, { tenantId });

  // For an approval, perform the award logic BEFORE sending so we never email an
  // approval we couldn't record.
  if (decision_type === 'approval') {
    if (!resolvedMember?.id) {
      return res.status(400).json({
        error: "This applicant isn't linked to a member record, so the position can't be awarded.",
      });
    }
    const resolvedMemberId = resolvedMember.id;

    // Capacity check: positions_available minus existing awards.
    const positionsAvailable = Number.isFinite(Number(vacancy.positions_available))
      ? Math.max(1, Number(vacancy.positions_available))
      : 1;
    const { data: existingAwards } = await supabase
      .from('vacancy_award')
      .select('id, awarded_member_id')
      .eq('vacancy_id', vacancy_id);
    const awards = existingAwards || [];
    const alreadyAwarded = awards.some((a) => a.awarded_member_id === resolvedMemberId);
    if (!alreadyAwarded) {
      if (awards.length >= positionsAvailable) {
        return res.status(409).json({ error: 'All positions for this vacancy are already filled.' });
      }
      const { error: awardErr } = await supabase
        .from('vacancy_award')
        .insert({
          tenant_id: tenantId,
          member_group_id: group_id,
          vacancy_id,
          awarded_member_id: resolvedMemberId,
          source_type: source_type || null,
          source_id: source_id || null,
          awarded_by_member_id: access.memberId || null,
        });
      if (awardErr) {
        console.error('[vacancy-decision] award insert failed:', awardErr);
        return res.status(500).json({ error: 'Failed to record the award.' });
      }

      // Upsert the member's group assignment with the role term snapshot.
      const { data: existingAssignment } = await supabase
        .from('member_group_assignment')
        .select('id, group_role, term_number')
        .eq('member_id', resolvedMemberId)
        .eq('group_id', group_id)
        .maybeSingle();
      const termSnapshot = buildTermSnapshot(
        (group.role_term_definitions || {})[role],
        { existingAssignment: existingAssignment || null, role }
      );
      if (existingAssignment) {
        await supabase
          .from('member_group_assignment')
          .update({ group_role: role || existingAssignment.group_role, ...termSnapshot })
          .eq('id', existingAssignment.id);
      } else {
        await supabase
          .from('member_group_assignment')
          .insert({
            tenant_id: tenantId,
            group_id,
            member_id: resolvedMemberId,
            group_role: role || 'Member',
            ...termSnapshot,
          });
      }
    }
  } else {
    // Decline: record the declined decision (idempotent on vacancy + source).
    if (source_id) {
      const { data: existingDecline } = await supabase
        .from('vacancy_decline')
        .select('id')
        .eq('vacancy_id', vacancy_id)
        .eq('source_id', source_id)
        .maybeSingle();
      if (!existingDecline) {
        const { error: declineErr } = await supabase
          .from('vacancy_decline')
          .insert({
            tenant_id: tenantId,
            member_group_id: group_id,
            vacancy_id,
            declined_member_id: resolvedMember?.id || null,
            source_type: source_type || null,
            source_id: source_id || null,
            declined_by_member_id: access.memberId || null,
          });
        if (declineErr) {
          console.error('[vacancy-decision] decline insert failed:', declineErr);
          return res.status(500).json({ error: 'Failed to record the decline.' });
        }
      }
    } else {
      const { error: declineErr } = await supabase
        .from('vacancy_decline')
        .insert({
          tenant_id: tenantId,
          member_group_id: group_id,
          vacancy_id,
          declined_member_id: resolvedMember?.id || null,
          source_type: source_type || null,
          source_id: null,
          declined_by_member_id: access.memberId || null,
        });
      if (declineErr) {
        console.error('[vacancy-decision] decline insert failed:', declineErr);
        return res.status(500).json({ error: 'Failed to record the decline.' });
      }
    }
  }

  // Send via the tenant path so the tenant footer/branding is applied.
  const emailResult = await sendEmail({
    to: toEmail,
    subject,
    html,
    cc: ccEmail || undefined,
    tenantId,
  });

  const deliveryStatus = emailResult?.success ? 'sent' : 'failed';
  const deliveryError = emailResult?.success ? null : (emailResult?.error || 'Unknown error sending email');

  let sentByEmail = null;
  try {
    const sm = await getSessionMember(req);
    sentByEmail = sm?.email || null;
  } catch {
    sentByEmail = null;
  }

  const { data: record, error: insertErr } = await supabase
    .from('vacancy_decision_email')
    .insert({
      tenant_id: tenantId,
      member_group_id: group_id,
      vacancy_id,
      decision_type,
      source_type: source_type || null,
      source_id: source_id || null,
      to_email: toEmail,
      cc_email: ccEmail,
      subject,
      body_html: html,
      sent_by_email: sentByEmail,
      sent_by_member_id: access.memberId || null,
      delivery_status: deliveryStatus,
      delivery_error: deliveryError,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[vacancy-decision] failed to record decision email:', insertErr);
    return res.status(500).json({
      error: 'Email processed but could not be recorded',
      delivery_status: deliveryStatus,
      delivery_error: deliveryError,
    });
  }

  if (deliveryStatus === 'failed') {
    return res.status(502).json({
      error: deliveryError,
      delivery_status: deliveryStatus,
      record,
    });
  }

  return res.status(200).json({ success: true, record });
}

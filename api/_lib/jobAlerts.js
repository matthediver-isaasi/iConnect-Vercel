import { isResourceExcluded } from './roleVisibility.js';

export async function jobAlertSettings(db, tenantId) {
  const { data, error } = await db.from('job_alert_settings').select('enabled,category_id')
    .eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data || { enabled: false, category_id: null };
}

export async function jobBoardEligible(db, member) {
  if (!member?.role_id || member.login_enabled === false || member.membership_paused === true) return false;
  const { data: role, error } = await db.from('role').select('excluded_features')
    .eq('id', member.role_id).eq('tenant_id', member.tenant_id).maybeSingle();
  if (error) throw error;
  return jobBoardAllowed(member, role);
}

function jobBoardAllowed(member, role) {
  if (!role || !member?.role_id || member.login_enabled === false || member.membership_paused === true) return false;
  return !isResourceExcluded([
    ...(Array.isArray(role.excluded_features) ? role.excluded_features : []),
    ...(Array.isArray(member.excluded_features) ? member.excluded_features : []),
  ], 'jobs.job-board');
}

export async function jobAlertState(db, member, now = Date.now()) {
  const settings = await jobAlertSettings(db, member.tenant_id);
  const base = { enabled: settings.enabled, categoryId: settings.category_id, eligible: false,
    subscribed: false, optedOutAll: member.communications_opted_out_all === true, promptDue: false };
  if (!settings.enabled) return base;
  base.eligible = await jobBoardEligible(db, member);
  const [{ data: preference, error: prefError }, { data: prompt, error: promptError }] = await Promise.all([
    db.from('member_communication_preference').select('is_subscribed')
      .eq('tenant_id', member.tenant_id).eq('member_id', member.id).eq('category_id', settings.category_id).maybeSingle(),
    db.from('job_alert_prompt').select('never_ask,ask_after').eq('tenant_id', member.tenant_id).eq('member_id', member.id).maybeSingle(),
  ]);
  if (prefError || promptError) throw prefError || promptError;
  base.subscribed = preference?.is_subscribed === true;
  base.promptDue = base.eligible && !base.subscribed && !base.optedOutAll && !prompt?.never_ask
    && (!prompt?.ask_after || new Date(prompt.ask_after).getTime() <= now);
  return base;
}

export function jobStillOpen(job, now = new Date()) {
  if (!job || job.status !== 'active') return false;
  const today = now.toISOString().slice(0, 10);
  return [job.closing_date, job.expiry_date].every(value => !value ||
    (/^\d{4}-\d{2}-\d{2}/.test(value) && value.slice(0, 10) >= today));
}

export function escapeJobHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function jobAlertContent(job, url) {
  return {
    subject: `New job: ${String(job.title || 'Job opportunity').replace(/[\r\n]/g, ' ')}`,
    html: `<p>A new job has been posted:</p><h2>${escapeJobHtml(job.title)}</h2><p>${escapeJobHtml(job.company_name)}${job.location ? ` · ${escapeJobHtml(job.location)}` : ''}</p><p><a href="${escapeJobHtml(url)}">View job posting</a></p><p>You receive these alerts because you subscribed to Job postings. You can change this in the Job Board or your communication preferences.</p>`,
  };
}

// Category campaigns use the same Job Board authority as automatic alerts.
// Ordinary categories retain their existing behavior.
export async function jobCategoryCampaignMembers(db, tenantId, categoryId, memberIds) {
  if (!categoryId) return null;
  const { data: categories, error } = await db.from('communication_category')
    .select('system_key').eq('tenant_id', tenantId).eq('id', categoryId).limit(1);
  if (error) throw error;
  const category = categories?.[0];
  if (category?.system_key !== 'job_postings') return null;
  const settings = await jobAlertSettings(db, tenantId);
  if (!settings.enabled || !memberIds.length) return new Set();
  const { data: members, error: memberError } = await db.from('member').select('*')
    .eq('tenant_id', tenantId).in('id', [...new Set(memberIds)]).limit(101);
  if (memberError || members?.length > 100) throw memberError || new Error('Unbounded job campaign audience');
  const roleIds = [...new Set((members || []).map(member => member.role_id).filter(Boolean))];
  if (!roleIds.length) return new Set();
  const [{ data: roles, error: roleError }, { data: preferences, error: prefError }] = await Promise.all([
    db.from('role').select('id,excluded_features').eq('tenant_id', tenantId).in('id', roleIds).limit(101),
    db.from('member_communication_preference').select('member_id').eq('tenant_id', tenantId)
      .eq('category_id', categoryId).eq('is_subscribed', true).in('member_id', memberIds).limit(101),
  ]);
  if (roleError || prefError || roles?.length > 100 || preferences?.length > 100)
    throw roleError || prefError || new Error('Incomplete job campaign authority');
  const roleMap = new Map((roles || []).map(role => [role.id, role]));
  const subscribed = new Set((preferences || []).map(preference => preference.member_id));
  const allowed = new Set();
  for (const member of members || []) {
    if (subscribed.has(member.id) && member.communications_opted_out_all !== true &&
        jobBoardAllowed(member, roleMap.get(member.role_id))) allowed.add(member.id);
  }
  return allowed;
}

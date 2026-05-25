import { supabase } from './database.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from './membershipSimulation.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { replacePlaceholders } from './emailService.js';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function toMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function offsetInDays(reminder) {
  const value = Number(reminder.offset_value) || 0;
  const unit = reminder.offset_unit === 'weeks' ? 7 : 1;
  return value * unit;
}

function computeSendDate(renewalDate, reminder) {
  const days = offsetInDays(reminder);
  const signed = reminder.direction === 'after' ? days : -days;
  return addDays(renewalDate, signed);
}

function formatLabel(reminder) {
  const value = Number(reminder.offset_value) || 0;
  const unit = reminder.offset_unit === 'weeks' ? 'week' : 'day';
  const suffix = value === 1 ? '' : 's';
  if (value === 0) return reminder.direction === 'after' ? 'On renewal day' : 'On renewal day';
  return `${value} ${unit}${suffix} ${reminder.direction}`;
}

async function loadActiveReminders(tenantId, configId) {
  const { data, error } = await supabase
    .from('membership_tier_reminder')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('config_id', configId)
    .eq('is_active', true);

  if (error) {
    if (error.code === '42P01') return [];
    console.error('[membershipReminders] Error loading reminders:', error.message);
    return [];
  }
  return data || [];
}

async function loadTemplate(tenantId, templateId) {
  if (!templateId) return null;
  const { data } = await supabase
    .from('email_template')
    .select('id, subject, body, is_active')
    .eq('id', templateId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!data || data.is_active === false) return null;
  return data;
}

async function resolveOrgRecipients(tenantId, organizationId, roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return [];
  const { data: members } = await supabase
    .from('member')
    .select('id, email, first_name, last_name, name, role_id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .in('role_id', roleIds);
  return (members || []).filter(m => m.email);
}

function buildOrgContext({ org, member, membershipYear, simResult, renewalDate, reminder }) {
  return {
    organization_id: org.id,
    organization_name: org.name,
    organizationName: org.name,
    member_name: member?.name || [member?.first_name, member?.last_name].filter(Boolean).join(' ') || '',
    memberName: member?.name || [member?.first_name, member?.last_name].filter(Boolean).join(' ') || '',
    membership_year: membershipYear.label,
    membershipYear: membershipYear.label,
    renewal_date: renewalDate.toISOString().split('T')[0],
    renewalDate: renewalDate.toISOString().split('T')[0],
    tier_label: simResult.tierLabel || '',
    tierLabel: simResult.tierLabel || '',
    final_cost: simResult.finalCost != null ? Number(simResult.finalCost).toFixed(2) : '',
    finalCost: simResult.finalCost != null ? Number(simResult.finalCost).toFixed(2) : '',
    currency: simResult.currency || 'GBP',
    reminder_label: reminder.label || formatLabel(reminder),
  };
}

function renderTemplate(template, entityType, data) {
  const subject = replacePlaceholders(template.subject || '', entityType, data, {}) || '';
  const html = replacePlaceholders(template.body || '', entityType, data, {}) || '';
  return { subject, html };
}

async function alreadySent({ reminderId, membershipYear, organizationId = null, memberId = null }) {
  let query = supabase
    .from('membership_tier_reminder_send')
    .select('id')
    .eq('reminder_id', reminderId)
    .eq('membership_year', membershipYear)
    .limit(1);
  if (organizationId) query = query.eq('organization_id', organizationId);
  if (memberId) query = query.eq('member_id', memberId);
  const { data, error } = await query;
  if (error) {
    if (error.code === '42P01') return false;
    return false;
  }
  return (data || []).length > 0;
}

async function logSend({ tenantId, reminderId, membershipYear, scopeType, organizationId = null, memberId = null, recipientEmail, status, error = null }) {
  try {
    await supabase
      .from('membership_tier_reminder_send')
      .insert({
        tenant_id: tenantId,
        reminder_id: reminderId,
        membership_year: membershipYear,
        scope_type: scopeType,
        organization_id: organizationId,
        member_id: memberId,
        recipient_email: recipientEmail,
        status,
        error,
      });
  } catch (err) {
    console.error('[membershipReminders] Failed to log send:', err.message);
  }
}

/**
 * Process reminders for all active configs in a tenant.
 * Iterates each config's reminders, computes the next renewal date per
 * target (org or member) via simulation, and sends any reminders whose
 * computed send date is today (or earlier and not yet sent), once per
 * membership year.
 */
export async function processTenantReminders(tenantId, results) {
  const today = toMidnight(new Date());

  const { data: configs, error: cfgErr } = await supabase
    .from('membership_tier_config')
    .select('id, structure_scope_type, name')
    .eq('tenant_id', tenantId)
    .is('effective_to', null);

  if (cfgErr || !configs || configs.length === 0) return;

  for (const config of configs) {
    let reminders;
    try {
      reminders = await loadActiveReminders(tenantId, config.id);
    } catch (err) {
      console.error(`[membershipReminders] Load reminders failed for config ${config.id}:`, err.message);
      continue;
    }
    if (!reminders || reminders.length === 0) continue;

    const scopeType = config.structure_scope_type || 'organization';

    if (scopeType === 'member') {
      await processMemberConfigReminders(tenantId, config, reminders, today, results);
    } else {
      await processOrgConfigReminders(tenantId, config, reminders, today, results);
    }
  }
}

async function processOrgConfigReminders(tenantId, config, reminders, today, results) {
  const { data: orgs } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);

  if (!orgs || orgs.length === 0) return;

  for (const org of orgs) {
    let simResult;
    try {
      simResult = await simulateMembershipForOrg(tenantId, org.id, {
        source: 'reminder',
        mode: 'automatic',
        configId: config.id,
      });
    } catch (err) {
      continue;
    }
    if (!simResult?.success || !simResult.membershipYear) continue;
    if (simResult.config?.id !== config.id) continue;

    const membershipYear = simResult.membershipYear;
    const renewalDate = toMidnight(membershipYear.start);

    for (const reminder of reminders) {
      const sendDate = computeSendDate(renewalDate, reminder);
      if (sendDate > today) continue;

      const yearLabel = membershipYear.label;
      const already = await alreadySent({
        reminderId: reminder.id,
        membershipYear: yearLabel,
        organizationId: org.id,
      });
      if (already) continue;

      if (reminder.direction === 'after' && simResult.existingRecord) {
        // Renewal completed — skip post-renewal reminders for this cycle.
      }

      const template = await loadTemplate(tenantId, reminder.email_template_id);
      if (!template) {
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'organization',
          organizationId: org.id,
          recipientEmail: null,
          status: 'skipped',
          error: 'Email template missing or inactive',
        });
        continue;
      }

      const recipients = await resolveOrgRecipients(tenantId, org.id, reminder.recipient_role_ids);
      if (recipients.length === 0) {
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'organization',
          organizationId: org.id,
          recipientEmail: null,
          status: 'skipped',
          error: 'No members with selected roles',
        });
        continue;
      }

      const data = buildOrgContext({ org, member: recipients[0], membershipYear, simResult, renewalDate, reminder });
      const { subject, html } = renderTemplate(template, 'organization', data);

      const toAddresses = recipients.map(m => m.email);

      try {
        await sendTenantEmail({ tenantId, to: toAddresses, subject, html });
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'organization',
          organizationId: org.id,
          recipientEmail: toAddresses.join(', '),
          status: 'sent',
        });
        if (results) {
          results.processed = (results.processed || 0) + 1;
          (results.details || []).push({
            tenantId,
            type: 'reminder',
            scope: 'organization',
            orgId: org.id,
            orgName: org.name,
            reminderId: reminder.id,
            membershipYear: yearLabel,
            recipients: toAddresses.length,
            status: 'sent',
          });
        }
        console.log(`[membershipReminders] Sent reminder ${reminder.id} to ${toAddresses.length} recipients for org ${org.name} (${yearLabel})`);
      } catch (err) {
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'organization',
          organizationId: org.id,
          recipientEmail: toAddresses.join(', '),
          status: 'error',
          error: err.message,
        });
        if (results) {
          results.errors = (results.errors || 0) + 1;
          (results.details || []).push({
            tenantId,
            type: 'reminder',
            scope: 'organization',
            orgId: org.id,
            reminderId: reminder.id,
            status: 'error',
            reason: err.message,
          });
        }
      }
    }
  }
}

async function processMemberConfigReminders(tenantId, config, reminders, today, results) {
  const { data: members } = await supabase
    .from('member')
    .select('id, email, first_name, last_name, name, role_id')
    .eq('tenant_id', tenantId)
    .is('organization_id', null);

  if (!members || members.length === 0) return;

  for (const member of members) {
    if (!member.email) continue;

    let simResult;
    try {
      simResult = await simulateMembershipForMember(tenantId, member.id, {
        source: 'reminder',
        mode: 'automatic',
        configId: config.id,
      });
    } catch (err) {
      continue;
    }
    if (!simResult?.success || !simResult.membershipYear) continue;
    if (simResult.config?.id !== config.id) continue;

    const membershipYear = simResult.membershipYear;
    const renewalDate = toMidnight(membershipYear.start);

    for (const reminder of reminders) {
      const roleIds = reminder.recipient_role_ids || [];
      if (roleIds.length > 0 && !roleIds.includes(member.role_id)) continue;

      const sendDate = computeSendDate(renewalDate, reminder);
      if (sendDate > today) continue;

      const yearLabel = membershipYear.label;
      const already = await alreadySent({
        reminderId: reminder.id,
        membershipYear: yearLabel,
        memberId: member.id,
      });
      if (already) continue;

      const template = await loadTemplate(tenantId, reminder.email_template_id);
      if (!template) {
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'member',
          memberId: member.id,
          recipientEmail: member.email,
          status: 'skipped',
          error: 'Email template missing or inactive',
        });
        continue;
      }

      const memberName = member.name || [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email;
      const data = {
        member_id: member.id,
        member_name: memberName,
        memberName,
        member_email: member.email,
        membership_year: yearLabel,
        membershipYear: yearLabel,
        renewal_date: renewalDate.toISOString().split('T')[0],
        renewalDate: renewalDate.toISOString().split('T')[0],
        tier_label: simResult.tierLabel || '',
        tierLabel: simResult.tierLabel || '',
        final_cost: simResult.finalCost != null ? Number(simResult.finalCost).toFixed(2) : '',
        finalCost: simResult.finalCost != null ? Number(simResult.finalCost).toFixed(2) : '',
        currency: simResult.currency || 'GBP',
        reminder_label: reminder.label || formatLabel(reminder),
      };
      const { subject, html } = renderTemplate(template, 'member', data);

      try {
        await sendTenantEmail({ tenantId, to: member.email, subject, html });
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'member',
          memberId: member.id,
          recipientEmail: member.email,
          status: 'sent',
        });
        if (results) {
          results.processed = (results.processed || 0) + 1;
          (results.details || []).push({
            tenantId,
            type: 'reminder',
            scope: 'member',
            memberId: member.id,
            memberName,
            reminderId: reminder.id,
            membershipYear: yearLabel,
            status: 'sent',
          });
        }
        console.log(`[membershipReminders] Sent reminder ${reminder.id} to member ${memberName} (${yearLabel})`);
      } catch (err) {
        await logSend({
          tenantId,
          reminderId: reminder.id,
          membershipYear: yearLabel,
          scopeType: 'member',
          memberId: member.id,
          recipientEmail: member.email,
          status: 'error',
          error: err.message,
        });
        if (results) {
          results.errors = (results.errors || 0) + 1;
        }
      }
    }
  }
}

export async function getRemindersForConfig(configId, tenantId) {
  const { data, error } = await supabase
    .from('membership_tier_reminder')
    .select('*')
    .eq('config_id', configId)
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true });
  if (error) {
    if (error.code === '42P01') return [];
    console.error('[membershipReminders] getRemindersForConfig:', error.message);
    return [];
  }
  return data || [];
}

export async function saveRemindersForConfig(configId, tenantId, reminders) {
  try {
    await supabase
      .from('membership_tier_reminder')
      .delete()
      .eq('config_id', configId)
      .eq('tenant_id', tenantId);

    if (!Array.isArray(reminders) || reminders.length === 0) return;

    const rows = reminders.map((r, index) => ({
      config_id: configId,
      tenant_id: tenantId,
      label: r.label || null,
      offset_value: Math.max(0, parseInt(r.offset_value, 10) || 0),
      offset_unit: r.offset_unit === 'weeks' ? 'weeks' : 'days',
      direction: r.direction === 'after' ? 'after' : 'before',
      email_template_id: r.email_template_id || null,
      recipient_role_ids: Array.isArray(r.recipient_role_ids) ? r.recipient_role_ids : [],
      is_active: r.is_active !== false,
      sort_order: index,
    }));

    const { error } = await supabase
      .from('membership_tier_reminder')
      .insert(rows);
    if (error) {
      console.error('[membershipReminders] Error saving reminders:', error.message);
    }
  } catch (err) {
    console.error('[membershipReminders] saveRemindersForConfig:', err.message);
  }
}

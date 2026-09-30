import { supabase } from '../_lib/database.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import {
  computePendingPoInvoices,
  prepareReminderForInvoice,
  evaluateReminderSchedule,
  toPositiveIntSetting,
  PO_REMINDER_DEFAULTS,
} from '../_lib/pendingPoInvoice.js';

const DEFAULT_SEND_AFTER_DAYS = PO_REMINDER_DEFAULTS.sendAfterDays;
const DEFAULT_REPEAT_EVERY_DAYS = PO_REMINDER_DEFAULTS.repeatEveryDays;
const DEFAULT_MAX_SENDS = PO_REMINDER_DEFAULTS.maxSends;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/send-po-reminders] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startedAt = Date.now();
  const now = new Date();
  const todayWeekday = now.getUTCDay(); // 0 = Sunday .. 6 = Saturday

  try {
    // Pull every tenant's reminder settings and keep only those scheduled to
    // chase on today's weekday.
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenant')
      .select('id, settings');

    if (tenantsError) {
      console.error('[cron/send-po-reminders] Failed to fetch tenants:', tenantsError);
      return res.status(500).json({ error: 'Failed to fetch tenants' });
    }

    const scheduledTenants = (tenants || []).filter((t) => {
      const reminderDays = t?.settings?.poReminderSettings?.reminderDays;
      return Array.isArray(reminderDays) && reminderDays.includes(todayWeekday);
    });

    if (scheduledTenants.length === 0) {
      console.log(`[cron/send-po-reminders] No tenants scheduled for weekday ${todayWeekday}`);
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'po_reminders',
        task_display_name: 'Pending PO Reminders',
        status: 'no_action',
        summary: 'No tenants scheduled to send reminders today',
        details: { weekday: todayWeekday },
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0,
        duration_ms: Date.now() - startedAt,
      });
      return res.status(200).json({ message: 'No tenants scheduled today', sent: 0 });
    }

    let totalSent = 0;

    for (const tenant of scheduledTenants) {
      const tenantId = tenant.id;
      const settings = tenant?.settings?.poReminderSettings || {};
      const sendAfterDays = toPositiveIntSetting(settings.sendAfterDays, DEFAULT_SEND_AFTER_DAYS);
      const repeatEveryDays = toPositiveIntSetting(settings.repeatEveryDays, DEFAULT_REPEAT_EVERY_DAYS);
      const maxSends = toPositiveIntSetting(settings.maxSends, DEFAULT_MAX_SENDS);

      let invoicesConsidered = 0;
      let sentForTenant = 0;
      let failedForTenant = 0;

      try {
        const computed = await computePendingPoInvoices({ client: supabase, tenantId });
        const records = computed?.records || [];
        invoicesConsidered = records.length;

        for (const record of records) {
          const invoiceKey = record.id;
          if (!invoiceKey) continue;

          // Prior-send history for this invoice (most recent first).
          const { data: priorSends, error: priorError } = await supabase
            .from('po_reminder_log')
            .select('sent_at')
            .eq('tenant_id', tenantId)
            .eq('invoice_key', invoiceKey)
            .order('sent_at', { ascending: false });

          if (priorError) {
            console.error(`[cron/send-po-reminders] Failed to read log for ${tenantId}/${invoiceKey}:`, priorError);
            continue;
          }

          const priorCount = priorSends?.length || 0;
          const lastSentAt = priorCount > 0 ? priorSends[0].sent_at : null;

          // Single source of truth for all timing/cap/weekday gates, shared with
          // the report's "next reminder date" so the two can never disagree.
          const schedule = evaluateReminderSchedule({
            reminderDays: settings.reminderDays,
            sendAfterDays,
            repeatEveryDays,
            maxSends,
            createdDate: record.created_date,
            now,
            priorCount,
            lastSentAt,
          });
          if (!schedule.dueToday) continue;

          // All timing checks pass — now mint the token and build the email.
          const prepared = await prepareReminderForInvoice({ client: supabase, tenantId, invoiceKey });
          if (!prepared.ok) {
            console.log(`[cron/send-po-reminders] Skipping ${tenantId}/${invoiceKey}: ${prepared.error}`);
            continue;
          }

          const inboxDelivery = await buildInboxDelivery({
            tenantId,
            email: prepared.recipientEmail,
            labelKey: 'billing',
          });

          const result = await sendTenantEmail({
            tenantId,
            to: prepared.recipientEmail,
            subject: prepared.subject,
            html: prepared.html,
            inboxDelivery,
          });

          if (!result?.success) {
            failedForTenant++;
            console.error(`[cron/send-po-reminders] Email failed for ${tenantId}/${invoiceKey}: ${result?.error}`);
            continue;
          }

          await supabase.from('po_reminder_log').insert({
            tenant_id: tenantId,
            invoice_key: invoiceKey,
            recipient_email: prepared.recipientEmail,
            sent_at: now.toISOString(),
          });

          sentForTenant++;
          totalSent++;
          console.log(`[cron/send-po-reminders] Sent reminder to ${prepared.recipientEmail} for ${tenantId}/${invoiceKey}`);
        }

        await supabase.from('scheduled_task_log').insert({
          tenant_id: tenantId,
          task_name: 'po_reminders',
          task_display_name: 'Pending PO Reminders',
          status: sentForTenant > 0 ? 'success' : (failedForTenant > 0 ? 'failed' : 'no_action'),
          summary: sentForTenant > 0
            ? `Sent ${sentForTenant} reminder${sentForTenant !== 1 ? 's' : ''}`
            : (failedForTenant > 0 ? `${failedForTenant} reminder${failedForTenant !== 1 ? 's' : ''} failed to send` : 'No reminders needed today'),
          details: {
            invoices_considered: invoicesConsidered,
            reminders_sent: sentForTenant,
            reminders_failed: failedForTenant,
            send_after_days: sendAfterDays,
            repeat_every_days: repeatEveryDays,
            max_sends: maxSends,
          },
          items_processed: invoicesConsidered,
          items_succeeded: sentForTenant,
          items_failed: failedForTenant,
          duration_ms: Date.now() - startedAt,
        });
      } catch (tenantError) {
        console.error(`[cron/send-po-reminders] Error processing tenant ${tenantId}:`, tenantError);
        await supabase.from('scheduled_task_log').insert({
          tenant_id: tenantId,
          task_name: 'po_reminders',
          task_display_name: 'Pending PO Reminders',
          status: 'failed',
          summary: 'Task failed with error',
          error_message: tenantError.message || 'Unknown error',
          items_processed: invoicesConsidered,
          items_succeeded: sentForTenant,
          items_failed: failedForTenant,
          duration_ms: Date.now() - startedAt,
        });
      }
    }

    console.log(`[cron/send-po-reminders] Completed. Sent ${totalSent} reminders across ${scheduledTenants.length} tenant(s)`);
    return res.status(200).json({
      message: 'Pending PO reminders processed',
      sent: totalSent,
      tenants: scheduledTenants.length,
    });
  } catch (error) {
    console.error('[cron/send-po-reminders] Error:', error);
    try {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'po_reminders',
        task_display_name: 'Pending PO Reminders',
        status: 'failed',
        summary: 'Task failed with error',
        error_message: error.message || 'Unknown error',
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0,
        duration_ms: Date.now() - startedAt,
      });
    } catch (logError) {
      console.error('[cron/send-po-reminders] Failed to log error:', logError);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

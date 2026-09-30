// Nightly auto-close of stale resolved support tickets (CRON_SECRET-guarded).
//
// Per tenant with auto-close enabled (system_settings key 'support_auto_close'):
// - Warn: resolved tickets untouched for >= warnDays get a one-time
//   "we'll close this soon" email to the submitter (auto_close_warning_sent_at).
// - Close: warned tickets resolved for >= closeDays flip to status 'closed'
//   with closed_reason 'auto' (distinguishable from a manual close).
// A member reply auto-reopens the ticket to 'open' (existing behaviour), which
// removes it from the resolved pool — so activity always cancels the countdown.

import { supabase } from '../_lib/database.js';
import { sendSupportNotification } from '../support/notify.js';
import { SUPPORT_AUTO_CLOSE_KEY, parseAutoCloseSettings, decideAutoCloseAction } from '../_lib/supportCsat.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/support-auto-close] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startedAt = Date.now();
  const now = Date.now();

  try {
    // Tenants that have configured auto-close (only enabled ones proceed).
    const { data: settingRows, error: settingsErr } = await supabase
      .from('system_settings')
      .select('tenant_id, setting_value')
      .eq('setting_key', SUPPORT_AUTO_CLOSE_KEY);

    if (settingsErr) {
      console.error('[cron/support-auto-close] Failed to fetch settings:', settingsErr);
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }

    const enabledTenants = (settingRows || [])
      .map((row) => ({ tenantId: row.tenant_id, settings: parseAutoCloseSettings(row.setting_value) }))
      .filter((t) => t.tenantId && t.settings.enabled);

    if (enabledTenants.length === 0) {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'support_auto_close',
        task_display_name: 'Support Ticket Auto-Close',
        status: 'no_action',
        summary: 'No tenants have auto-close enabled',
        items_processed: 0,
        items_succeeded: 0,
        items_failed: 0,
        duration_ms: Date.now() - startedAt,
      });
      return res.status(200).json({ message: 'No tenants with auto-close enabled', warned: 0, closed: 0 });
    }

    let totalWarned = 0;
    let totalClosed = 0;
    let totalFailed = 0;

    for (const { tenantId, settings } of enabledTenants) {
      const { data: tickets, error: ticketsErr } = await supabase
        .from('support_ticket')
        .select('id, subject, status, resolved_at, auto_close_warning_sent_at, submitter_email')
        .eq('tenant_id', tenantId)
        .eq('status', 'resolved')
        .not('resolved_at', 'is', null);

      if (ticketsErr) {
        console.error(`[cron/support-auto-close] Failed to fetch tickets for tenant ${tenantId}:`, ticketsErr);
        totalFailed++;
        continue;
      }

      for (const ticket of tickets || []) {
        const action = decideAutoCloseAction(ticket, settings, now);
        if (!action) continue;

        if (action === 'warn') {
          // Mark the warning BEFORE sending so a send failure can't spam the
          // member on every nightly run; email failures are logged by notify.
          const { error: warnErr } = await supabase
            .from('support_ticket')
            .update({ auto_close_warning_sent_at: new Date(now).toISOString() })
            .eq('id', ticket.id)
            .eq('status', 'resolved')
            .is('auto_close_warning_sent_at', null);

          if (warnErr) {
            console.error(`[cron/support-auto-close] Failed to mark warning for ticket ${ticket.id}:`, warnErr.message);
            totalFailed++;
            continue;
          }

          const resolvedAtMs = Date.parse(ticket.resolved_at);
          const daysUntilClose = Math.max(
            1,
            Math.ceil(settings.closeDays - (now - resolvedAtMs) / (24 * 60 * 60 * 1000))
          );
          await sendSupportNotification({
            tenantId,
            ticketId: ticket.id,
            eventType: 'auto_close_warning',
            metadata: { days_until_close: daysUntilClose },
          });
          totalWarned++;
        } else if (action === 'close') {
          const { error: closeErr } = await supabase
            .from('support_ticket')
            .update({ status: 'closed', closed_reason: 'auto' })
            .eq('id', ticket.id)
            .eq('status', 'resolved');

          if (closeErr) {
            console.error(`[cron/support-auto-close] Failed to auto-close ticket ${ticket.id}:`, closeErr.message);
            totalFailed++;
            continue;
          }
          console.log(`[cron/support-auto-close] Auto-closed ticket ${ticket.id} (tenant ${tenantId})`);
          totalClosed++;
        }
      }
    }

    const { error: logErr } = await supabase.from('scheduled_task_log').insert({
      tenant_id: null,
      task_name: 'support_auto_close',
      task_display_name: 'Support Ticket Auto-Close',
      status: totalFailed > 0 ? 'partial' : (totalWarned + totalClosed > 0 ? 'success' : 'no_action'),
      summary: `Warned ${totalWarned}, closed ${totalClosed}, failed ${totalFailed} across ${enabledTenants.length} tenant(s)`,
      items_processed: totalWarned + totalClosed + totalFailed,
      items_succeeded: totalWarned + totalClosed,
      items_failed: totalFailed,
      duration_ms: Date.now() - startedAt,
    });
    if (logErr) {
      console.error('[cron/support-auto-close] Failed to write scheduled_task_log:', logErr.message);
    }

    return res.status(200).json({ warned: totalWarned, closed: totalClosed, failed: totalFailed });
  } catch (err) {
    console.error('[cron/support-auto-close] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

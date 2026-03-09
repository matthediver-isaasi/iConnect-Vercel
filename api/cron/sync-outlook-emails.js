import { supabase } from '../_lib/database.js';
import { syncEmailsForConnection } from '../_lib/outlookSync.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/sync-outlook-emails] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    const { data: connections, error: connError } = await supabase
      .from('outlook_connection')
      .select('*')
      .eq('status', 'active');

    if (connError) {
      console.error('[cron/sync-outlook-emails] Error fetching connections:', connError);
      return res.status(500).json({ error: 'Failed to fetch connections' });
    }

    if (!connections || connections.length === 0) {
      console.log('[cron/sync-outlook-emails] No active Outlook connections found');
      return res.status(200).json({ message: 'No active connections', ...results, duration: Date.now() - startTime });
    }

    const tenantIds = [...new Set(connections.map(c => c.tenant_id))];

    const { data: frequencySettings } = await supabase
      .from('system_settings')
      .select('tenant_id, setting_value')
      .eq('setting_key', 'outlook_sync_frequency_minutes')
      .in('tenant_id', tenantIds);

    const tenantFrequencies = {};
    for (const row of (frequencySettings || [])) {
      const minutes = parseInt(row.setting_value, 10);
      tenantFrequencies[row.tenant_id] = isNaN(minutes) ? 15 : minutes;
    }

    const now = Date.now();

    for (const connection of connections) {
      const frequencyMinutes = tenantFrequencies[connection.tenant_id] ?? 15;
      const lastSync = connection.last_sync_at ? new Date(connection.last_sync_at).getTime() : 0;
      const elapsedMinutes = (now - lastSync) / (1000 * 60);

      if (elapsedMinutes < frequencyMinutes) {
        results.skipped++;
        continue;
      }

      console.log(`[cron/sync-outlook-emails] Syncing connection ${connection.id} for tenant ${connection.tenant_id} (frequency: ${frequencyMinutes}min, elapsed: ${Math.round(elapsedMinutes)}min)`);

      try {
        const syncResult = await syncEmailsForConnection(connection, connection.tenant_id);

        results.processed++;
        results.details.push({
          tenantId: connection.tenant_id,
          connectionId: connection.id,
          synced: syncResult.synced,
          agentOnlySkipped: syncResult.agentOnlySkipped,
          errors: syncResult.errors.length
        });

        console.log(`[cron/sync-outlook-emails] Connection ${connection.id}: synced ${syncResult.synced} emails, skipped ${syncResult.agentOnlySkipped} agent-only`);
      } catch (err) {
        console.error(`[cron/sync-outlook-emails] Error syncing connection ${connection.id}:`, err.message);
        results.errors++;
        results.details.push({
          tenantId: connection.tenant_id,
          connectionId: connection.id,
          error: err.message
        });
      }
    }

    const duration = Date.now() - startTime;

    try {
      await supabase.from('scheduled_task_log').insert({
        task_name: 'outlook_email_sync',
        status: results.errors > 0 ? (results.processed > 0 ? 'partial' : 'error') : (results.processed > 0 ? 'success' : 'no_action'),
        details: results,
        duration_ms: duration
      });
    } catch (logErr) {
      console.error('[cron/sync-outlook-emails] Failed to log task:', logErr);
    }

    console.log(`[cron/sync-outlook-emails] Complete: processed=${results.processed}, skipped=${results.skipped}, errors=${results.errors}, duration=${duration}ms`);

    return res.status(200).json({
      ...results,
      duration
    });
  } catch (error) {
    console.error('[cron/sync-outlook-emails] Fatal error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

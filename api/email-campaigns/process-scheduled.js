import { processScheduledCampaigns } from '../_lib/campaignService.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[Process Scheduled Campaigns] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.scheduledCampaigns,
  });

  try {
    const result = await processScheduledCampaigns();

    if (!result.success) {
      await reportHeartbeat(false);
      return res.status(500).json({ error: result.error });
    }

    await reportHeartbeat(true);
    return res.json(result);
  } catch (error) {
    console.error('[Process Scheduled Campaigns] Error:', error);
    await reportHeartbeat(false);
    return res.status(500).json({ error: error.message });
  }
}

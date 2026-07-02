import { processScheduledCampaigns } from '../_lib/campaignService.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[Process Scheduled Campaigns] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await processScheduledCampaigns();

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.json(result);
  } catch (error) {
    console.error('[Process Scheduled Campaigns] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

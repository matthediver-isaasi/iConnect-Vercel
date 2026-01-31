import { processScheduledCampaigns } from '../_lib/campaignService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify internal API secret for cron jobs
  const authHeader = req.headers.authorization;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  
  if (!internalSecret) {
    return res.status(500).json({ error: 'Internal API secret not configured' });
  }

  if (authHeader !== `Bearer ${internalSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await processScheduledCampaigns();
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    return res.json(result);
  } catch (error) {
    console.error('[Process Scheduled] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

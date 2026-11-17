import { runZoomSpeakerSync } from '../_lib/zoomSpeakerSyncService.js';
export default async function handler(req,res) {
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({error:'Unauthorized'});
  }
  try {
    const processed = await runZoomSpeakerSync();
    return res.json({processed: processed ? 1 : 0});
  } catch { return res.status(503).json({error:'Speaker synchronisation could not continue'}); }
}

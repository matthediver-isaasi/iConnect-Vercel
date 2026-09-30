import { clearPlatformOwnerSession } from '../../_lib/platformSession.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  await clearPlatformOwnerSession(req, res);
  
  return res.status(200).json({ success: true });
}

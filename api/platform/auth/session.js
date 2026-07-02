import { getSessionPlatformOwner } from '../../_lib/platformSession.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const owner = await getSessionPlatformOwner(req);
  
  if (!owner) {
    return res.status(401).json({ authenticated: false });
  }

  return res.status(200).json({
    authenticated: true,
    owner: {
      id: owner.id,
      email: owner.email,
      name: owner.name
    }
  });
}

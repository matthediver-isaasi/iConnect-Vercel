import { getTenantContext } from '../_lib/authContext.js';
import { getEmailFooterForPreview } from '../_lib/emailService.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const footer = await getEmailFooterForPreview(ctx.tenantId);
    
    return res.status(200).json({ 
      footer: footer || null,
      hasFooter: !!footer 
    });
  } catch (error) {
    console.error('[Preview Footer] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

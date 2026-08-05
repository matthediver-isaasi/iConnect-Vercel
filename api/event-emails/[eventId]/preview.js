// Admin-only preview of an event confirmation/reminder email.
// Accepts the CURRENT draft subject/body from the editor (unsaved is fine)
// and returns the fully rendered subject + HTML using the exact same
// placeholder-substitution pipeline the real send uses — including the
// day-grouped session schedule for complex events — with clearly-labelled
// sample attendee/booking values. Render-only: no send, no token generation.

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { renderEventEmailPreview } from '../../_lib/eventConfirmationEmail.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'Event ID is required' });

  const { subject, body } = req.body || {};
  if (typeof subject !== 'string' && typeof body !== 'string') {
    return res.status(400).json({ error: 'subject or body is required' });
  }

  try {
    const result = await renderEventEmailPreview({
      eventId,
      tenantId: ctx.tenantId,
      subject: typeof subject === 'string' ? subject : '',
      body: typeof body === 'string' ? body : '',
    });
    if (!result.found) return res.status(404).json({ error: 'Event not found' });
    return res.status(200).json({
      subject: result.subject,
      html: result.html,
      is_complex: result.isComplex,
    });
  } catch (err) {
    console.error('[event-emails preview] Error:', err);
    return res.status(500).json({ error: 'Failed to render preview' });
  }
}

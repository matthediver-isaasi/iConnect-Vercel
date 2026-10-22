import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import * as parser from '../_lib/publicationWorkbook.js';
import { createPublicationImportService } from '../_lib/publicationImportService.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const context = await getTenantContext(req);
    if (context.tenantMismatch) return res.status(403).json({ error: 'Session tenant does not match this site' });
    if (!context.isAuthenticated || !context.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const service = createPublicationImportService({ db: supabase, parser,
      secret: process.env.PUBLICATION_IMPORT_SIGNING_KEY || process.env.SUPABASE_SERVICE_KEY });
    if (req.method === 'GET' && req.query.action === 'template') {
      const buffer = await service.template(context);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="publication-import-template.xlsx"');
      return res.send(buffer);
    }
    if (req.method === 'POST' && req.body?.action === 'preview') return res.json(await service.preview(context, req.body));
    if (req.method === 'POST' && req.body?.action === 'apply') return res.json(await service.apply(context, req.body.planId));
    return res.status(400).json({ error: 'Unknown publication import action' });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.status || error.name === 'PublicationWorkbookError' ? error.message : 'Unable to process publication workbook',
      ...(error.rows ? { rows: error.rows } : {}) });
  }
}

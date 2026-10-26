import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { exhibitionError } from '../_lib/salesExhibition.js';
import { getQuote } from '../_lib/salesQuote.js';

export function createSalesExhibitionHandler(deps = {}) {
  const db = deps.db || supabase;
  return async (req, res) => {
    try {
      const actor = await requireSalesContext(await (deps.getTenantContext || getTenantContext)(req),
        req.method === 'GET' ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES, deps);
      res.setHeader('Cache-Control', 'private, no-store');
      const tenant = actor.tenantId;
      if (req.method === 'GET') {
        const query = req.query || {};
        if (query.resource === 'requirements') {
          const r = await db.from('sales_space_requirement').select('id,name').eq('tenant_id', tenant).order('name');
          exhibitionError(r.error); return res.status(200).json({ items: r.data });
        }
        let rows = db.from('sales_exhibition_overview').select('*', { count: 'exact' }).eq('tenant_id', tenant);
        if (query.resource === 'spaces') {
          const quote = await getQuote(db, tenant, query.quoteId);
          const line = quote.currentVersion.sales_quote_line.find(l => l.id === query.lineId);
          const slot = line?.catalogue_snapshot?.exhibition?.slots?.find(s => s.key === query.slotKey);
          if (!slot || !quote.currentVersion.event_snapshot?.id) throw new SalesHttpError(400, 'Save the proposal with an Event and exhibition requirements first');
          rows = rows.eq('requirement_id', slot.requirementId).eq('event_id', quote.currentVersion.event_snapshot.id)
            .eq('event_kind', quote.currentVersion.event_snapshot.kind).eq('currency', quote.currentVersion.currency)
            .eq('archived', false).or(`status.eq.available,quote_id.eq.${quote.id}`);
        } else {
          for (const [key, field] of [['eventId','event_id'],['eventKind','event_kind'],['groupId','group_id'],['status','status']]) {
            if (query[key]) rows = rows.eq(field, query[key]);
          }
        }
        const page = Math.max(1, Number.parseInt(query.page,10) || 1);
        const pageSize = query.resource === 'spaces' ? 1000 : 100;
        const result = await rows.order('reference').order('id').range((page-1)*pageSize, page*pageSize-1);
        exhibitionError(result.error);
        if (query.resource === 'spaces') return res.status(200).json({ items: result.data, total: result.count });
        const [requirements, groups] = await Promise.all([
          db.from('sales_space_requirement').select('id,name').eq('tenant_id',tenant).order('name'),
          db.from('sales_space_group').select('*').eq('tenant_id',tenant).order('name'),
        ]);
        exhibitionError(requirements.error); exhibitionError(groups.error);
        return res.status(200).json({ items: result.data, requirements: requirements.data, groups: groups.data, total: result.count, page, pageSize });
      }
      if (['POST','PATCH'].includes(req.method)) {
        const command = req.method === 'PATCH' ? { ...req.body, action: 'edit' } : req.body;
        if (!command || !['edit','generate','requirement'].includes(command.action)) throw new SalesHttpError(400,'Invalid exhibition command');
        if (command.priceMinor !== undefined && (!Number.isSafeInteger(command.priceMinor) || command.priceMinor < 0)) throw new SalesHttpError(400,'Invalid space price');
        if (command.action === 'generate' && (!Number.isInteger(command.quantity) || command.quantity < 1 || command.quantity > 1000)) throw new SalesHttpError(400,'Quantity must be 1–1000');
        for (const key of ['blocked','archived']) if (key in command && typeof command[key] !== 'boolean') throw new SalesHttpError(400,`Invalid ${key}`);
        const r = await db.rpc('manage_sales_exhibition', { p_tenant: tenant, p_command: command });
        exhibitionError(r.error); return res.status(200).json(r.data);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) { return res.status(e instanceof SalesHttpError ? e.status : 500).json({ error: e instanceof SalesHttpError ? e.message : 'Exhibition request failed' }); }
  };
}
export default createSalesExhibitionHandler();

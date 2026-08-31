import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  SALES_CAPABILITIES, validateCatalogueBundle, validateCatalogueCategory,
  validateCatalogueProduct, validateCatalogueReorder,
} from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  createCatalogueRecord, listCatalogue, listCatalogueEventOptions, reorderCatalogue, setCatalogueActive,
  updateCatalogueRecord,
} from '../../_lib/salesCatalogue.js';

const validators = {
  categories: validateCatalogueCategory,
  products: validateCatalogueProduct,
  bundles: validateCatalogueBundle,
};

export function createSalesCatalogueHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const path = Array.isArray(req.query?.path) ? req.query.path : String(req.query?.path || '').split('/').filter(Boolean);
      const [type, id, action] = path;
      if (!validators[type] && type !== 'event-options') throw new SalesHttpError(404, 'Catalogue endpoint not found');
      const isEventOptions = type === 'event-options' && !id;
      const isRead = req.method === 'GET' && (!id || isEventOptions);
      const actor = await requireSalesContext(
        await getContext(req),
        isRead ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES,
        dependencies,
      );
      if (isEventOptions) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return res.status(405).json({ error: 'Method not allowed' });
        }
        const search = typeof req.query?.q === 'string' ? req.query.q
          : typeof req.query?.search === 'string' ? req.query.search : '';
        return res.status(200).json({ items: await listCatalogueEventOptions(db, actor.tenantId, search) });
      }
      if (isRead) {
        return res.status(200).json({
          items: await listCatalogue(db, actor.tenantId, type, {
            includeInactive: req.query?.includeInactive === 'true',
            q: typeof req.query?.q === 'string' ? req.query.q.trim()
              : typeof req.query?.search === 'string' ? req.query.search.trim() : '',
          }),
        });
      }
      if (req.method === 'POST' && id === 'reorder' && !action) {
        const validation = validateCatalogueReorder(req.body);
        if (!validation.ok) return res.status(400).json({ error: 'Invalid catalogue reorder', details: validation.errors });
        return res.status(200).json(await reorderCatalogue(db, actor.tenantId, actor, type, req.body.ids));
      }
      if (req.method === 'POST' && id && action === 'restore') {
        return res.status(200).json(await setCatalogueActive(db, actor.tenantId, actor, type, id, true));
      }
      if (req.method === 'POST' && id && action === 'archive') {
        return res.status(200).json(await setCatalogueActive(db, actor.tenantId, actor, type, id, false));
      }
      if (req.method === 'POST' && !id) {
        const validation = validators[type](req.body);
        if (!validation.ok) return res.status(400).json({ error: `Invalid catalogue ${type.slice(0, -1)}`, details: validation.errors });
        return res.status(201).json(await createCatalogueRecord(db, actor.tenantId, actor, type, req.body));
      }
      if (req.method === 'PATCH' && id && !action) {
        const validation = validators[type](req.body, { patch: true });
        if (!validation.ok) return res.status(400).json({ error: `Invalid catalogue ${type.slice(0, -1)}`, details: validation.errors });
        return res.status(200).json(await updateCatalogueRecord(db, actor.tenantId, actor, type, id, req.body));
      }
      if (req.method === 'DELETE' && id && !action) {
        return res.status(200).json(await setCatalogueActive(db, actor.tenantId, actor, type, id, false));
      }
      res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales catalogue' : error.message });
    }
  };
}

export default createSalesCatalogueHandler();
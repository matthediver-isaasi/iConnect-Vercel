import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  SALES_CAPABILITIES, normaliseQuoteInput, validateQuoteDraft, validateQuoteTransition,
} from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  amendQuote, compareQuoteVersions, getQuote, getQuoteHistory, issueQuote, listQuotes, prepareQuoteDraft,
  saveQuoteDraft, transitionQuote,
} from '../../_lib/salesQuote.js';

function pathParts(req) {
  const path = req.query?.path;
  if (path) return Array.isArray(path) ? path : String(path).split('/').filter(Boolean);
  return req.query?.id ? [req.query.id, req.query.action].filter(Boolean) : [];
}

export function createSalesQuotesHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      let [id, action] = pathParts(req);
      action = action || req.query?.action || req.query?.resource;
      const read = req.method === 'GET';
      const context = await getContext(req);
      const actor = await requireSalesContext(context,
        read ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_QUOTES, dependencies);
      const can = async (capability) => {
        try {
          await requireSalesContext(context, capability, dependencies);
          return true;
        } catch (error) {
          if (error instanceof SalesHttpError && error.status === 403) return false;
          throw error;
        }
      };

      if (read && !id) return res.status(200).json(await listQuotes(db, actor.tenantId, req.query || {}));
      if (read && id && !action) {
        const quote = await getQuote(db, actor.tenantId, id);
        const [canManage, canOverridePrices] = await Promise.all([
          can(SALES_CAPABILITIES.MANAGE_QUOTES),
          can(SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES),
        ]);
        const draft = quote.currentVersion?.status === 'draft';
        return res.status(200).json({
          ...quote,
          permissions: {
            canView: true,
            canEdit: canManage && draft,
            canIssue: canManage && draft,
            canAmend: canManage && !draft && quote.currentVersion?.status !== 'superseded',
            canTransition: canManage,
            canOverridePrices,
          },
        });
      }
      if (read && action === 'history') return res.status(200).json({ items: await getQuoteHistory(db, actor.tenantId, id) });
      if (read && action === 'compare') {
        const from = Number(req.query.from); const to = Number(req.query.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) throw new SalesHttpError(400, 'from and to versions are required');
        return res.status(200).json(await compareQuoteVersions(db, actor.tenantId, id, from, to));
      }
      if (req.method === 'POST' && action === 'preview') {
        const body = normaliseQuoteInput(req.body || {});
        const validation = validateQuoteDraft(body, { existing: Boolean(id) });
        if (!validation.ok) return res.status(400).json({ error: 'Invalid quote preview', details: validation.errors });
        try { return res.status(200).json({ quote: await prepareQuoteDraft(db, actor.tenantId, actor, body, false), permissions: { canOverridePrices: false } }); }
        catch (error) {
          if (!(error instanceof SalesHttpError) || error.status !== 403) throw error;
          await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES, dependencies);
          return res.status(200).json({ quote: await prepareQuoteDraft(db, actor.tenantId, actor, body, true), permissions: { canOverridePrices: true } });
        }
      }
      if ((req.method === 'POST' && !id) || (req.method === 'PATCH' && id && !action)) {
        const body = normaliseQuoteInput(req.body || {});
        const validation = validateQuoteDraft(body, { existing: Boolean(id) });
        if (!validation.ok) return res.status(400).json({ error: 'Invalid quote draft', details: validation.errors });
        let allowOverride = false;
        try { await prepareQuoteDraft(db, actor.tenantId, actor, body, false); } catch (error) {
          if (!(error instanceof SalesHttpError) || error.status !== 403) throw error;
          await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES, dependencies);
          allowOverride = true;
        }
        const result = await saveQuoteDraft(db, actor.tenantId, actor, id,
          body.expectedVersion, body, allowOverride);
        return res.status(id ? 200 : 201).json(result);
      }
      if (req.method === 'POST' && id && action === 'issue') {
        if (!Number.isInteger(req.body?.expectedVersion) || req.body.expectedVersion < 1) throw new SalesHttpError(400, 'expectedVersion is required');
        return res.status(200).json(await issueQuote(db, actor.tenantId, actor, id, req.body.expectedVersion));
      }
      if (req.method === 'POST' && id && action === 'amend') {
        if (!Number.isInteger(req.body?.expectedVersion) || req.body.expectedVersion < 1) throw new SalesHttpError(400, 'expectedVersion is required');
        return res.status(201).json(await amendQuote(db, actor.tenantId, actor, id, req.body.expectedVersion));
      }
      if (req.method === 'POST' && id && ['status', 'transition'].includes(action)) {
        const validation = validateQuoteTransition(req.body);
        if (!validation.ok) return res.status(400).json({ error: 'Invalid quote transition', details: validation.errors });
        return res.status(200).json(await transitionQuote(db, actor.tenantId, actor, id,
          req.body.expectedVersion, req.body.status, req.body.note));
      }
      res.setHeader('Allow', 'GET, POST, PATCH');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales quote' : error.message });
    }
  };
}

export default createSalesQuotesHandler();
import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  SALES_CAPABILITIES, normaliseQuoteInput, validateQuoteDraft, validateQuoteTransition,
} from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  amendQuote, compareQuoteVersions, confirmQuoteSale, getQuote, getQuoteHistory, issueQuote, listQuotes, prepareQuoteDraft,
  saveQuoteDraft, transitionQuote,
} from '../../_lib/salesQuote.js';
import { buildSalesQuotePdf } from '../../_lib/salesQuotePdf.js';
import { canonicalQuoteBaseUrl, sendQuote } from '../../_lib/salesQuoteDelivery.js';

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
        read
          ? SALES_CAPABILITIES.VIEW
          : action === 'confirm-sale'
            ? SALES_CAPABILITIES.MANAGE_ALLOCATIONS
            : SALES_CAPABILITIES.MANAGE_QUOTES,
        dependencies);
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
      if (read && ['pdf', 'preview-pdf', 'download'].includes(action)) {
        const quote = await getQuote(db, actor.tenantId, id);
        const requested = req.query.version ? Number(req.query.version) : quote.current_version;
        const version = quote.versions.find((item) => item.version_number === requested);
        if (!version || version.status === 'draft') throw new SalesHttpError(409, 'Only an issued quote version can be rendered');
        const { data: tenant, error } = await db.from('tenant')
          .select('name,slug,domain,logo_url,header_logo_url,primary_color,secondary_color,tagline,description,branding_config,settings').eq('id', actor.tenantId).maybeSingle();
        if (error) throw error;
        const pdf = buildSalesQuotePdf({ quote, version, tenant });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `${action === 'download' ? 'attachment' : 'inline'}; filename="quote-${quote.quote_number}.pdf"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(pdf);
      }
      if (read && action === 'delivery-history') {
        await getQuote(db, actor.tenantId, id);
        const { data: expiredTokens, error: expiredTokenError } = await db
          .from('sales_quote_delivery_token')
          .select('id,quote_version_id,recipient_email')
          .eq('tenant_id', actor.tenantId)
          .eq('quote_id', id)
          .not('activated_at', 'is', null)
          .is('revoked_at', null)
          .lte('expires_at', new Date().toISOString());
        if (expiredTokenError) throw expiredTokenError;
        for (const token of expiredTokens || []) {
          const { error: expiryAuditError } = await db.from('sales_quote_delivery_audit').insert({
            tenant_id: actor.tenantId,
            quote_id: id,
            quote_version_id: token.quote_version_id,
            token_id: token.id,
            event_type: 'expired',
            recipient_email: token.recipient_email,
          });
          if (expiryAuditError && expiryAuditError.code !== '23505') throw expiryAuditError;
        }
        const { data, error } = await db.from('sales_quote_delivery_audit').select('*')
          .eq('tenant_id', actor.tenantId).eq('quote_id', id).order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json({ items: (data || []).map((item) => ({
          eventType: item.event_type, recipientEmail: item.recipient_email, actorId: item.actor_id,
          senderDomain: item.sender_domain, providerMessageId: item.provider_message_id,
          errorMessage: item.error_message, createdAt: item.created_at,
        })) });
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
      if (req.method === 'POST' && id && action === 'confirm-sale') {
        if (!Number.isInteger(req.body?.expectedVersion) || req.body.expectedVersion < 1) {
          throw new SalesHttpError(400, 'expectedVersion is required');
        }
        if (typeof req.body?.idempotencyKey !== 'string' || !req.body.idempotencyKey.trim()) {
          throw new SalesHttpError(400, 'idempotencyKey is required');
        }
        return res.status(201).json(await confirmQuoteSale(db, actor.tenantId, actor, id, req.body));
      }
      if (req.method === 'POST' && id && action === 'send') {
        const recipient = String(req.body?.recipient || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new SalesHttpError(400, 'A valid recipient is required');
        const quote = await getQuote(db, actor.tenantId, id);
        const requested = req.body?.version ? Number(req.body.version) : quote.current_version;
        const version = quote.versions.find((item) => item.version_number === requested);
        if (!version) throw new SalesHttpError(404, 'Quote version not found');
        const { data: tenant, error } = await db.from('tenant')
          .select('name,slug,domain,logo_url,header_logo_url,primary_color,secondary_color,tagline,description,branding_config,settings').eq('id', actor.tenantId).maybeSingle();
        if (error) throw error;
        const pdf = req.body?.attachPdf === false ? null : buildSalesQuotePdf({ quote, version, tenant });
        const expiresInDays = Number(req.body?.expiresInDays);
        return res.status(200).json(await sendQuote(db, {
          quote, version, tenant, actor, recipient,
          attachPdf: req.body?.attachPdf !== false, pdf, expiresInDays,
          baseUrl: (dependencies.canonicalQuoteBaseUrl || canonicalQuoteBaseUrl)(tenant),
          sendEmail: dependencies.sendEmail,
        }));
      }
      if (req.method === 'POST' && id && action === 'revoke') {
        let query = db.from('sales_quote_delivery_token').update({
          revoked_at: new Date().toISOString(), revoked_by: actor.actorId,
        }).eq('tenant_id', actor.tenantId).eq('quote_id', id).is('revoked_at', null);
        if (req.body?.tokenId) query = query.eq('id', req.body.tokenId);
        const { data, error } = await query.select('*');
        if (error) throw error;
        if (!data?.length) throw new SalesHttpError(404, 'Active delivery token not found');
        const audits = data.map((token) => ({
          tenant_id: actor.tenantId, quote_id: id, quote_version_id: token.quote_version_id,
          token_id: token.id, event_type: 'revoked', actor_id: actor.actorId,
          recipient_email: token.recipient_email,
        }));
        const { error: auditError } = await db.from('sales_quote_delivery_audit').insert(audits);
        if (auditError) throw auditError;
        return res.status(200).json({ revoked: data.length });
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
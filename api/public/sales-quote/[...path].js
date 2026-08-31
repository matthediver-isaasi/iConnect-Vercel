import { supabase } from '../../_lib/database.js';
import { hashQuoteToken } from '../../_lib/salesQuoteDelivery.js';
import { buildSalesQuotePdf } from '../../_lib/salesQuotePdf.js';

const buckets = new Map();
function limited(key, maximum) {
  const now = Date.now();
  const fresh = (buckets.get(key) || []).filter((value) => now - value < 60_000);
  if (fresh.length >= maximum) { buckets.set(key, fresh); return true; }
  fresh.push(now); buckets.set(key, fresh); return false;
}
const metadata = (req) => ({
  ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 100),
  userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
});
function parts(req) {
  const value = req.query?.path;
  return (Array.isArray(value) ? value : String(value || '').split('/')).filter(Boolean);
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.toLowerCase() !== 'id' && !key.endsWith('_id') && !key.endsWith('Id'))
    .map(([key, item]) => [key, scrub(item)]));
}
export function clearPublicSalesQuoteRateLimits() { buckets.clear(); }
function publicQuoteDto(quote, version) {
  const address = version.address_snapshot || {};
  return {
    quoteNumber: quote.quote_number || null, version: version.version_number, status: version.status,
    currency: version.currency, organisation: { name: version.organisation_snapshot?.name || null },
    address: { addressee: address.addressee || null, line1: address.line1 || null, line2: address.line2 || null,
      city: address.city || null, region: address.region || null, postalCode: address.postalCode || address.postal_code || null, country: address.country || null },
    event: { name: version.event_snapshot?.name || version.event_snapshot?.title || null },
    terms: { text: version.terms_snapshot?.text || null }, issueDate: version.issue_date || null,
    validUntil: version.valid_until || null,
    purchaseOrderReference: version.purchase_order_reference || null,
    customerReference: version.customer_reference || null,
    notes: version.notes || null, netMinor: version.net_minor,
    taxMinor: version.tax_minor, grossMinor: version.gross_minor,
    lines: (version.sales_quote_line || []).map((line) => ({
      description: line.description, quantity: line.quantity, standardUnitPriceMinor: line.standard_unit_price_minor,
      quotedUnitPriceMinor: line.quoted_unit_price_minor, discountBps: line.discount_bps,
      taxRateBps: line.tax_rate_bps, netMinor: line.net_minor, taxMinor: line.tax_minor, grossMinor: line.gross_minor,
      bundleComponents: (line.sales_quote_bundle_component || []).map((component) => ({
        name: component.product_snapshot?.name || null, quantity: component.quantity,
      })),
    })),
  };
}
function publicBrandingDto(tenant) {
  return { name: tenant?.name || null, logoUrl: tenant?.header_logo_url || tenant?.logo_url || null,
    primaryColor: tenant?.primary_color || null, secondaryColor: tenant?.secondary_color || null,
    tagline: tenant?.tagline || null, description: tenant?.description || null };
}
async function resolveToken(db, token, lockAuditType, requestMetadata = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return { outcome: 'not_found' };
  const digest = `\\x${hashQuoteToken(token)}`;
  const { data: row, error } = await db.from('sales_quote_delivery_token').select('*')
    .eq('token_hash', digest).maybeSingle();
  if (error) throw error;
  if (!row) return { outcome: 'not_found' };
  if (!row.activated_at) return { outcome: 'not_found' };
  if (row.revoked_at) return { outcome: 'revoked' };
  if (new Date(row.expires_at) <= new Date()) {
    const { error: expiredAuditError } = await db.from('sales_quote_delivery_audit').insert({
      tenant_id: row.tenant_id, quote_id: row.quote_id, quote_version_id: row.quote_version_id,
      token_id: row.id, event_type: 'expired', recipient_email: row.recipient_email,
      request_metadata: requestMetadata,
    });
    if (expiredAuditError && expiredAuditError.code !== '23505') throw expiredAuditError;
    return { outcome: 'expired' };
  }
  const [quoteResult, versionResult, tenantResult] = await Promise.all([
    db.from('sales_quote').select('*').eq('tenant_id', row.tenant_id).eq('id', row.quote_id).maybeSingle(),
    db.from('sales_quote_version').select('*,sales_quote_line(*,sales_quote_bundle_component(*))')
      .eq('tenant_id', row.tenant_id).eq('id', row.quote_version_id).maybeSingle(),
    db.from('tenant').select('name,slug,domain,logo_url,header_logo_url,primary_color,secondary_color,tagline,description,branding_config,settings').eq('id', row.tenant_id).maybeSingle(),
  ]);
  if (quoteResult.error) throw quoteResult.error;
  if (versionResult.error) throw versionResult.error;
  if (tenantResult.error) throw tenantResult.error;
  const quote = quoteResult.data; const version = versionResult.data;
  if (!quote || !version) return { outcome: 'not_found' };
  if (quote.current_version !== version.version_number || version.status === 'superseded') return { outcome: 'superseded' };
  if (lockAuditType) {
    const { error: auditError } = await db.from('sales_quote_delivery_audit').insert({
      tenant_id: row.tenant_id, quote_id: row.quote_id, quote_version_id: row.quote_version_id,
      token_id: row.id, event_type: lockAuditType, recipient_email: row.recipient_email,
      request_metadata: requestMetadata,
    });
    if (auditError) throw auditError;
  }
  return { outcome: version.status, row, quote, version, tenant: tenantResult.data };
}

export function createPublicSalesQuoteHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  return async function handler(req, res) {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      const [token, action] = parts(req);
      const digest = hashQuoteToken(token || '');
      const ip = metadata(req).ip;
      if (limited(`${digest}:${ip}`, req.method === 'GET' ? 30 : 8)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ outcome: 'rate_limited', error: 'Too many requests' });
      }
      if (req.method === 'GET') {
        const found = await resolveToken(db, token, action === 'download' ? 'downloaded' : 'viewed', metadata(req));
        if (!found.version) return res.status(found.outcome === 'not_found' ? 404 : 410).json({ outcome: found.outcome });
        if (action === 'download') {
          const pdf = buildSalesQuotePdf(found);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="quote-${found.quote.quote_number}.pdf"`);
          res.setHeader('Cache-Control', 'private, no-store');
          return res.send(pdf);
        }
        return res.status(200).json({
          outcome: found.outcome,
          quote: publicQuoteDto(found.quote, found.version),
          branding: publicBrandingDto(found.tenant),
        });
      }
      if (req.method === 'POST' && ['accept', 'decline'].includes(action)) {
        const body = req.body || {};
        if (action === 'accept' && body.agreement !== true) {
          return res.status(400).json({ outcome: 'invalid', error: 'Agreement is required to accept this quote' });
        }
        if (action === 'accept' && (typeof body.role !== 'string' || !body.role.trim())) {
          return res.status(400).json({ outcome: 'invalid', error: 'Role is required to accept this quote' });
        }
        if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) {
          return res.status(400).json({ outcome: 'invalid', error: 'idempotencyKey is required' });
        }
        const { data, error } = await db.rpc('decide_sales_quote_public', {
          p_token_hash_hex: digest,
          p_decision: action === 'accept' ? 'accepted' : 'declined',
          p_customer_name: body.name,
          p_customer_role: body.role || null,
          p_purchase_order_reference: body.purchaseOrderReference || null,
          p_customer_reference: action === 'accept' ? body.customerReference || null : null,
          p_decline_reason: action === 'decline'
            ? body.reason || body.declineReason || body.customerReference || null : null,
          p_agreement: body.agreement === true,
          p_idempotency_key: body.idempotencyKey.trim(),
          p_request_metadata: metadata(req),
        });
        if (error) {
          if (error.code === '22023') return res.status(400).json({ outcome: 'invalid', error: error.message });
          if (['23514', '40001', '23505'].includes(error.code)) {
            const outcome = /capacity|availability/i.test(error.message || '') ? 'capacity_conflict' : 'conflict';
            return res.status(409).json({ outcome, error: error.message });
          }
          throw error;
        }
        const result = Array.isArray(data) ? data[0] : data;
        const status = result?.outcome === 'not_found' ? 404
          : ['expired', 'revoked', 'superseded'].includes(result?.outcome) ? 410 : 200;
        return res.status(status).json(result);
      }
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch {
      return res.status(500).json({ error: 'Failed to handle public quote' });
    }
  };
}
export default createPublicSalesQuoteHandler();
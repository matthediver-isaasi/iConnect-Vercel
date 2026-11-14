import { createHash, timingSafeEqual } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const digest = value => createHash('sha256').update(value).digest();
const fields = 'title,summary,content,feature_image_url,published_date,subcategories,tags';
const unavailable = { error: 'This preview is unavailable or the password is incorrect.' };

// The existing service-only atomic counter is namespace-separated from quotes.
// Fail closed if it is unavailable; a per-process Map is not a password guard.
export async function limitPreviewAttempts(db, tenantId, id, req) {
  const ip = String(req.headers?.['x-vercel-forwarded-for']
    || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100);
  for (const [scope, client, limit] of [
    [`${tenantId}:article:${id}`, ip, 10],
    [`${tenantId}:article:${id}`, 'all-clients', 100],
    [`${tenantId}:all-articles`, ip, 30],
  ]) {
    const { data, error } = await db.rpc('consume_sales_quote_public_rate_limit', {
      p_token_hash_hex: digest(`article-preview:${scope}`).toString('hex'),
      p_client_key: client,
      p_limit: limit,
      p_window_seconds: 3600,
    });
    if (error || typeof data !== 'boolean') throw new Error('Rate limit unavailable');
    if (data) return true;
  }
  return false;
}

export function createArticlePreviewHandler({ db = supabase, resolveTenant = resolveTenantFromRequest, limit = limitPreviewAttempts } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const { id, password } = req.body || {};
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)
      || typeof password !== 'string' || !password.length || password.length > 128) {
      return res.status(400).json({ error: 'Enter a valid preview password.' });
    }
    try {
      if (!db) throw new Error('Database unavailable');
      const tenant = await resolveTenant(req);
      if (!tenant) return res.status(404).json(unavailable);
      if (await limit(db, tenant.id, id, req)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
      }
      // No content or author lookup before verification.
      const { data: access, error: accessError } = await db.from('blog_post')
        .select('share_password').eq('tenant_id', tenant.id).eq('id', id).maybeSingle();
      if (accessError) throw accessError;
      if (!access?.share_password || !timingSafeEqual(digest(password), digest(String(access.share_password)))) {
        return res.status(403).json(unavailable);
      }
      // Read the current secret again with content to fence concurrent revocation.
      const { data: row, error } = await db.from('blog_post')
        .select(`${fields},share_password,author_id,guest_writer_id`)
        .eq('tenant_id', tenant.id).eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row?.share_password || !timingSafeEqual(digest(password), digest(String(row.share_password)))) {
        return res.status(403).json(unavailable);
      }
      let authorName = null;
      if (row.guest_writer_id || row.author_id) {
        const guest = !!row.guest_writer_id;
        const { data: author, error: authorError } = await db.from(guest ? 'guest_writer' : 'member')
          .select(guest ? 'full_name' : 'first_name,last_name')
          .eq('tenant_id', tenant.id).eq('id', row.guest_writer_id || row.author_id).maybeSingle();
        if (authorError) throw authorError;
        authorName = guest ? author?.full_name : [author?.first_name, author?.last_name].filter(Boolean).join(' ');
      }
      const article = Object.fromEntries(fields.split(',').map(key => [key, row[key]]));
      return res.status(200).json({ article, authorName: authorName || null });
    } catch {
      // Never log request bodies, supplied passwords, or database error details.
      return res.status(503).json({ error: 'Preview is temporarily unavailable. Please try again.' });
    }
  };
}

export default createArticlePreviewHandler();

// AI Design Studio V2 — signed preview page + Browserless screenshots
// (Task #2904, Phase 0).
//
// GET  /api/ai-compositions/preview?compositionId&versionId&width&exp&sig
//      Serves a CSP-locked, standalone HTML page rendering ONE stored V2
//      document (scoped CSS + sanitised HTML in the [data-ai-composition]
//      wrapper). Auth is a short-lived HMAC signature — Browserless has no
//      session cookie, and the URL expires (~10 min), so nothing durable is
//      exposed. No JS runs on the page.
//
// POST /api/ai-compositions/preview  { compositionId, versionId? }
//      Editor-only. Builds the signed URL and captures screenshots at the
//      package's responsive targets (1440/1024/390 by default) via
//      Browserless, stores them in the tenant media library, and records
//      them on the version's generation_metadata.screenshots.

import crypto from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { captureScreenshot, isBrowserlessConfigured } from '../_lib/browserlessScreenshot.js';
import { storeGeneratedAsset } from '../_lib/aiCompositionAssetStore.js';

const SIGNATURE_TTL_MS = 10 * 60 * 1000;

function signingSecret() {
  return process.env.AIC_PREVIEW_SECRET || process.env.CRON_SECRET || null;
}

function sign(compositionId, versionId, exp) {
  const secret = signingSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret)
    .update(`${compositionId}.${versionId}.${exp}`)
    .digest('hex');
}

function verifySignature(compositionId, versionId, exp, sig) {
  const expected = sign(compositionId, versionId, exp);
  if (!expected || !sig) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

function appOrigin(req) {
  if (process.env.VITE_APP_URL) return process.env.VITE_APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

async function loadVersionDocument(compositionId, versionId) {
  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, current_version_id')
    .eq('id', compositionId)
    .maybeSingle();
  if (!comp) return null;
  const vid = versionId || comp.current_version_id;
  if (!vid) return null;
  const { data: version } = await supabase
    .from('ai_composition_version')
    .select('id, document, generation_metadata')
    .eq('id', vid)
    .eq('composition_id', compositionId)
    .maybeSingle();
  if (!version?.document) return null;
  return { comp, version };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  // -------------------------------------------------------------- GET -----
  if (req.method === 'GET') {
    const { compositionId, versionId, exp, sig } = req.query;
    if (!compositionId || !versionId || !exp || !sig) {
      return res.status(400).send('Missing parameters');
    }
    if (!verifySignature(compositionId, versionId, exp, sig)) {
      return res.status(403).send('Invalid or expired preview link');
    }
    const loaded = await loadVersionDocument(compositionId, versionId);
    const doc = loaded?.version?.document;
    if (!doc || doc.schemaVersion !== '2.0') return res.status(404).send('Not found');

    const scopeId = doc.compositionId || compositionId;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(doc.title || 'AI Composition preview')}</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #ffffff; }
</style>
<style>${doc.css || ''}</style>
</head>
<body>
<div data-ai-composition="${escapeHtml(scopeId)}">${doc.html || ''}</div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // No scripts, no external styles, images restricted to https (already
    // policy-limited to the media library by the sanitiser), no frames.
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.status(200).send(html);
  }

  // ------------------------------------------------------------- POST -----
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(404).json({ error: 'Not found' });
  const canEdit = context.tenantUserId
    || (context.roleId && await hasFeatureAccess(context.roleId, 'site-builder.page-editor'));
  if (!canEdit) return res.status(404).json({ error: 'Not found' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { compositionId } = body;
  if (!compositionId) return res.status(400).json({ error: 'compositionId required' });

  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, current_version_id, renderer_version')
    .eq('id', compositionId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();
  if (!comp) return res.status(404).json({ error: 'Not found' });
  const versionId = body.versionId || comp.current_version_id;
  if (!versionId) return res.status(400).json({ error: 'Composition has no version yet' });

  const loaded = await loadVersionDocument(compositionId, versionId);
  const doc = loaded?.version?.document;
  if (!doc || doc.schemaVersion !== '2.0') {
    return res.status(400).json({ error: 'Not a V2 code composition version' });
  }
  if (!signingSecret()) {
    return res.status(503).json({ error: 'Preview signing is not configured (AIC_PREVIEW_SECRET or CRON_SECRET)' });
  }
  if (!isBrowserlessConfigured()) {
    return res.status(503).json({ error: 'Screenshot capture is not configured on this server' });
  }

  const exp = Date.now() + SIGNATURE_TTL_MS;
  const sig = sign(compositionId, versionId, exp);
  const previewUrl = `${appOrigin(req)}/api/ai-compositions/preview`
    + `?compositionId=${encodeURIComponent(compositionId)}`
    + `&versionId=${encodeURIComponent(versionId)}&exp=${exp}&sig=${sig}`;

  const targets = doc.responsiveTargets || { desktop: 1440, tablet: 1024, mobile: 390 };
  const viewports = [
    { name: 'desktop', width: targets.desktop || 1440, height: 900 },
    { name: 'tablet', width: targets.tablet || 1024, height: 768 },
    { name: 'mobile', width: targets.mobile || 390, height: 844 },
  ];

  const screenshots = [];
  const failures = [];
  for (const vp of viewports) {
    try {
      const { buffer } = await captureScreenshot(previewUrl, vp, { fullPage: true });
      const stored = await storeGeneratedAsset({
        tenantId: context.tenantId,
        memberId: context.memberId || null,
        compositionId,
        buffer,
        prompt: `V2 preview screenshot (${vp.name} ${vp.width}px)`,
        provider: 'browserless',
        model: 'screenshot',
        usageStatus: 'in_use',
      });
      screenshots.push({
        breakpoint: vp.name,
        width: vp.width,
        url: stored.url,
        fileRepositoryId: stored.fileRepositoryId,
        capturedAt: new Date().toISOString(),
      });
    } catch (err) {
      failures.push({ breakpoint: vp.name, error: err.message });
    }
  }
  if (!screenshots.length) {
    return res.status(502).json({ error: 'All screenshot captures failed', failures });
  }

  const meta = { ...(loaded.version.generation_metadata || {}), screenshots };
  const { error: upErr } = await supabase
    .from('ai_composition_version')
    .update({ generation_metadata: meta })
    .eq('id', versionId)
    .eq('tenant_id', context.tenantId);
  if (upErr) return res.status(500).json({ error: 'Failed to record screenshots' });

  return res.status(200).json({ screenshots, failures });
}

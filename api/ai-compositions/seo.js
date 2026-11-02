import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { canUseAiFeature, AI_FEATURE_GENERATE } from '../_lib/aiStudioAccess.js';
import { loadStudioSettings } from '../_lib/aiDesignStudioSettings.js';
import { checkAiUsageAllowance, recordAiUsageEvent } from '../_lib/aiUsage.js';
import { buildSeoContext, generateSeoSuggestions } from '../_lib/canvasSeoSuggestions.js';

export function createSeoHandler(deps) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const context = await deps.getTenantContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Sign in to suggest page metadata.' });
      if (!context.tenantId || !(await deps.canUseAiFeature(context, AI_FEATURE_GENERATE))) {
        return res.status(404).json({ error: 'Page not found' });
      }
      const body = req.body || {};
      if (!/^[0-9a-f-]{36}$/i.test(body.pageId || '')) return res.status(400).json({ error: 'A saved page is required.' });
      if (JSON.stringify(body).length > 1000000) return res.status(413).json({ error: 'The page is too large for suggestions.' });
      const { data: page, error } = await deps.db.from('i_edit_page')
        .select('id,title,slug,canvas_design')
        .eq('id', body.pageId).eq('tenant_id', context.tenantId).maybeSingle();
      if (error) throw new Error('Page lookup failed');
      if (!page) return res.status(404).json({ error: 'Page not found' });
      const settings = await deps.loadStudioSettings(deps.db, context.tenantId);
      if (settings.enabled === false || settings.allowAiCopy === false) {
        return res.status(403).json({ error: 'AI copy suggestions are disabled for this organisation.' });
      }
      const source = buildSeoContext({
        design: body.design ?? page.canvas_design,
        title: body.title ?? page.title,
        slug: body.slug ?? page.slug,
        values: body.values,
      });
      if (!source.copy) return res.status(400).json({ error: 'Add some page text before requesting suggestions.' });
      const client = deps.getClient();
      if (!client) return res.status(503).json({ error: 'AI suggestions are not configured on this server.' });
      // Use the existing generation bucket and its database operation contract.
      const usage = { tenantId: context.tenantId, memberId: context.memberId || null, operation: 'generation' };
      const allowance = await deps.checkAiUsageAllowance(deps.db, {
        ...usage, settings,
        // This is bounded document context, not a user-authored freeform prompt.
        prompt: `seo:${page.id}:${createHash('sha256').update(JSON.stringify(source)).digest('hex')}`,
      });
      if (!allowance.ok) return res.status(allowance.status).json(allowance.body);
      try {
        const suggestions = await deps.generate(client, source);
        await deps.recordAiUsageEvent(deps.db, {
          ...usage, model: 'gpt-4o-mini', units: { textCalls: 1 }, dedupeHash: allowance.dedupeHash,
        });
        return res.status(200).json({ suggestions });
      } catch {
        await deps.recordAiUsageEvent(deps.db, { ...usage, status: 'failed', units: { textCalls: 1 } });
        return res.status(502).json({ error: 'AI suggestions could not be generated. Please retry. No page settings were changed.' });
      }
    } catch {
      return res.status(500).json({ error: 'Unable to load page suggestions. Please retry.' });
    }
  };
}

export default createSeoHandler({
  db: supabase, getTenantContext, canUseAiFeature, loadStudioSettings,
  checkAiUsageAllowance, recordAiUsageEvent, generate: generateSeoSuggestions,
  getClient: () => {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    return apiKey ? new OpenAI({ apiKey, ...(baseURL && { baseURL }), timeout: 25000, maxRetries: 0 }) : null;
  },
});

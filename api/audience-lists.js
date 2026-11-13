import { getTenantContext, hasAdminAccess } from './_lib/tenantContext.js';
import { validateAudienceCustomObjects } from './_lib/audienceCustomObjects.js';
import { supabase as defaultDatabase } from './_lib/database.js';
import { validateSurveyAudienceSegments } from './_lib/eventSurveyAudience.js';
import { validateSpeakerAudienceSegments } from './_lib/eventSpeakerAudience.js';
import { readAudienceListPage } from './_lib/audienceListPages.js';

export default async function handler(req, res, dependencies = {}) {
  const supabase = dependencies.supabase || defaultDatabase;
  const tenantContext = await (dependencies.getTenantContext || getTenantContext)(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId || tenantContext.tenantMismatch) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!(await (dependencies.hasAdminAccess || hasAdminAccess)(tenantContext))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantContext;

  if (req.method === 'GET') {
    try {
      if (req.query?.page !== undefined) {
        return res.json(await readAudienceListPage(supabase, tenantId, req.query));
      }
      // Preserve the array contract used by campaign and nested-list selectors.
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from('audience_list').select('*')
          .eq('tenant_id', tenantId).order('name').order('id').range(offset, offset + 499);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < 500) break;
      }
      return res.json(rows);
    } catch (err) {
      console.error('[AudienceLists] GET error:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      if (req.body?.action === 'duplicate') {
        const { sourceId, name } = req.body;
        if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sourceId) ||
            typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
          return res.status(400).json({ error: 'Choose a source list and a name of up to 200 characters.' });
        }
        const { data, error } = await supabase.rpc('duplicate_audience_list', {
          p_tenant_id: tenantId, p_source_id: sourceId, p_name: name.trim(),
        });
        if (error) {
          if (error.code === 'P0002') return res.status(404).json({ error: 'Audience list not found.' });
          if (error.code === 'PGRST202' || error.code === '42883') {
            return res.status(503).json({ error: 'List duplication setup is not yet available. Please contact your administrator.' });
          }
          throw error;
        }
        return res.status(201).json({ id: data });
      }
      const { name, target_audiences, ignore_opt_outs } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (!Array.isArray(target_audiences)) {
        return res.status(400).json({ error: 'Audience segments must be an array' });
      }

      const insertPayload = {
        tenant_id: tenantId,
        name: name.trim(),
        target_audiences,
        ignore_opt_outs: ignore_opt_outs === true
      };

      await validateAudienceCustomObjects(supabase, tenantId, target_audiences, { context: tenantContext, isAdmin: true });
      await validateSurveyAudienceSegments(supabase, tenantId, target_audiences);
      await validateSpeakerAudienceSegments(supabase, tenantId, target_audiences);

      const { data, error } = await supabase
        .from('audience_list')
        .insert(insertPayload)
        .select('*')
        .single();

      if (error) {
        console.error('[AudienceLists] POST error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(201).json(data);
    } catch (err) {
      console.error('[AudienceLists] POST error:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const { id, name, target_audiences, ignore_opt_outs } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'ID is required' });
      }

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (!Array.isArray(target_audiences)) {
        return res.status(400).json({ error: 'Audience segments must be an array' });
      }

      const updatePayload = {
        name: name.trim(),
        target_audiences,
        ignore_opt_outs: ignore_opt_outs === true,
        updated_at: new Date().toISOString()
      };

      await validateAudienceCustomObjects(supabase, tenantId, target_audiences, { context: tenantContext, isAdmin: true });
      await validateSurveyAudienceSegments(supabase, tenantId, target_audiences);
      await validateSpeakerAudienceSegments(supabase, tenantId, target_audiences);

      const { data, error } = await supabase
        .from('audience_list')
        .update(updatePayload)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select('*')
        .single();

      if (error) {
        console.error('[AudienceLists] PATCH error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data);
    } catch (err) {
      console.error('[AudienceLists] PATCH error:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ error: 'ID is required' });
      }

      const { error } = await supabase
        .from('audience_list')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[AudienceLists] DELETE error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[AudienceLists] DELETE error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
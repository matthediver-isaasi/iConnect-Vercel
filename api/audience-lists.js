import { getTenantContext } from './_lib/tenantContext.js';
import { supabase } from './_lib/database.js';

export default async function handler(req, res) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('audience_list')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('name');

      if (error) {
        console.error('[AudienceLists] GET error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data || []);
    } catch (err) {
      console.error('[AudienceLists] GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { name, target_audiences, ignore_opt_outs } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (!Array.isArray(target_audiences) || target_audiences.length === 0) {
        return res.status(400).json({ error: 'At least one audience segment is required' });
      }

      const insertPayload = {
        tenant_id: tenantId,
        name: name.trim(),
        target_audiences,
        ignore_opt_outs: ignore_opt_outs === true
      };

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
      return res.status(500).json({ error: err.message });
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

      if (!Array.isArray(target_audiences) || target_audiences.length === 0) {
        return res.status(400).json({ error: 'At least one audience segment is required' });
      }

      const updatePayload = {
        name: name.trim(),
        target_audiences,
        ignore_opt_outs: ignore_opt_outs === true,
        updated_at: new Date().toISOString()
      };

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
      return res.status(500).json({ error: err.message });
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

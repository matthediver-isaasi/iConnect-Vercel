import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

const VALID_ENTITY_TYPES = ['member', 'organization'];
const ALLOWED_MODULES_BY_ENTITY = {
  member: ['Contacts', 'Leads'],
  organization: ['Accounts']
};

export default async function handler(req, res) {
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;

    if (req.method === 'GET') {
      const { entity_type } = req.query;
      let q = supabase.from('zoho_crm_sync_mapping').select('*').eq('tenant_id', tenantId);
      if (entity_type) q = q.eq('entity_type', entity_type);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ mappings: data || [] });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const {
        entity_type, zoho_module, unique_key_field, is_enabled, field_mappings,
        sync_direction, conflict_policy, unmatched_policy
      } = req.body || {};
      const VALID_DIRECTIONS = ['outbound', 'inbound', 'bidirectional'];
      const VALID_POLICIES = ['last_write_wins', 'zoho_wins', 'iconnect_wins'];
      const VALID_UNMATCHED = ['ignore', 'create', 'queue'];
      const resolvedDirection = VALID_DIRECTIONS.includes(sync_direction) ? sync_direction : 'outbound';
      const resolvedPolicy = VALID_POLICIES.includes(conflict_policy) ? conflict_policy : 'last_write_wins';
      const resolvedUnmatched = VALID_UNMATCHED.includes(unmatched_policy) ? unmatched_policy : 'ignore';
      if (!VALID_ENTITY_TYPES.includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type must be member or organization' });
      }
      if (!zoho_module) return res.status(400).json({ error: 'zoho_module is required' });
      const allowedModules = ALLOWED_MODULES_BY_ENTITY[entity_type];
      if (!allowedModules.includes(zoho_module)) {
        return res.status(400).json({
          error: `${entity_type} can only sync to: ${allowedModules.join(', ')}`
        });
      }
      if (!unique_key_field) return res.status(400).json({ error: 'unique_key_field is required' });
      const sanitizedMappings = Array.isArray(field_mappings)
        ? field_mappings
            .filter(m => m && m.iconnect_field && m.zoho_field)
            .map(m => {
              const row = {
                iconnect_field: m.iconnect_field,
                zoho_field: m.zoho_field,
                ...(m.iconnect_field_type ? { iconnect_field_type: m.iconnect_field_type } : {}),
                ...(m.zoho_field_label ? { zoho_field_label: m.zoho_field_label } : {})
              };
              // Persist per-row value translation map. Shape:
              //   value_map: {
              //     iconnect_to_zoho: { <iconnect value>: <zoho value>, ... },
              //     zoho_to_iconnect: { <zoho value>: <iconnect value>, ... }
              //   }
              // Either side may be empty/missing. Keys/values are coerced to
              // strings to keep the JSONB shape predictable.
              if (m.value_map && typeof m.value_map === 'object') {
                const cleanDir = (dir) => {
                  if (!dir || typeof dir !== 'object') return null;
                  const out = {};
                  for (const [k, v] of Object.entries(dir)) {
                    if (k === '' || k == null) continue;
                    if (v === '' || v == null) continue;
                    out[String(k)] = String(v);
                  }
                  return Object.keys(out).length > 0 ? out : null;
                };
                const i2z = cleanDir(m.value_map.iconnect_to_zoho);
                const z2i = cleanDir(m.value_map.zoho_to_iconnect);
                if (i2z || z2i) {
                  row.value_map = {
                    ...(i2z ? { iconnect_to_zoho: i2z } : {}),
                    ...(z2i ? { zoho_to_iconnect: z2i } : {})
                  };
                }
              }
              return row;
            })
        : [];
      // Require the unique_key_field to be one of the mapped Zoho fields so the
      // duplicate-check upsert always has a value to compare on.
      const mappedZohoFields = new Set(sanitizedMappings.map(m => m.zoho_field));
      if (!mappedZohoFields.has(unique_key_field)) {
        return res.status(400).json({
          error: `unique_key_field "${unique_key_field}" must be included in the field mappings so it has a value to match on`
        });
      }

      const payload = {
        tenant_id: tenantId,
        entity_type,
        zoho_module,
        unique_key_field,
        is_enabled: !!is_enabled,
        field_mappings: sanitizedMappings,
        sync_direction: resolvedDirection,
        conflict_policy: resolvedPolicy,
        unmatched_policy: resolvedUnmatched,
        updated_at: new Date().toISOString()
      };

      const { data: existing } = await supabase
        .from('zoho_crm_sync_mapping')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('entity_type', entity_type)
        .maybeSingle();

      let result;
      if (existing) {
        result = await supabase
          .from('zoho_crm_sync_mapping')
          .update(payload)
          .eq('id', existing.id)
          .select()
          .single();
      } else {
        result = await supabase
          .from('zoho_crm_sync_mapping')
          .insert(payload)
          .select()
          .single();
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json({ mapping: result.data });
    }

    if (req.method === 'DELETE') {
      const { entity_type } = req.query;
      if (!VALID_ENTITY_TYPES.includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type must be member or organization' });
      }
      const { error } = await supabase
        .from('zoho_crm_sync_mapping')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('entity_type', entity_type);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[ZohoCrmSync mappings] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

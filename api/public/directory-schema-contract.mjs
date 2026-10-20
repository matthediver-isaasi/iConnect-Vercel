// Queryable columns independently read from DEST information_schema.columns on
// 2026-10-20 (lvmzliemqnieeoruhkik). This is the directory dependency subset,
// not columns inferred from fixture rows or the implementation's SELECT strings.
export const directorySchema = {
  organization: 'id tenant_id name logo_url description website_url phone',
  member: 'id tenant_id email first_name last_name handle job_title profile_photo_url organization_id role_id login_enabled show_in_directory linkedin_url membership_paused',
  dynamic_directory: 'id tenant_id name slug entity_type filter_field_id filter_value filter_expression is_active allowed_role_ids back_field_order show_members_on_card_back core_field_visibility custom_fields_label',
  preference_field: 'id tenant_id name label entity_scope is_active field_type display_order',
  organization_preference_value: 'id organization_id field_id value',
  member_preference_value: 'id member_id field_id value',
  system_settings: 'id tenant_id setting_key setting_value',
  role: 'id tenant_id name badge_background_colour badge_text_colour',
};

// Validate when a query is built, before evaluating any rows. In particular an
// empty table must not hide an invalid WHERE, OR, NOT or ORDER BY reference.
export function schemaCheckedDatabase(db) {
  return {
    ...db,
    from(table) {
      const columns = directorySchema[table]?.split(' ');
      if (!columns) throw new Error(`Unverified directory table ${table}`);
      const check = key => {
        if (!columns.includes(key)) throw new Error(`column ${table}.${key} does not exist`);
      };
      const target = db.from(table);
      const proxy = new Proxy(target, {
        get(query, method) {
          if (typeof query[method] !== 'function') return query[method];
          const implementation = query[method];
          return (...args) => {
            if (method === 'select' && args[0] !== '*') args[0].split(',').map(x => x.trim()).forEach(check);
            if (['eq', 'neq', 'in', 'is', 'not', 'like', 'ilike', 'order', 'gt', 'gte', 'lt', 'lte'].includes(method)) check(args[0]);
            if (method === 'or') {
              for (const match of args[0].matchAll(/(?:^|[,()])\s*([a-z_]+)\.(?:not\.)?(?:eq|neq|is|ilike|like|in|gt|gte|lt|lte)\./g)) check(match[1]);
            }
            const result = implementation.apply(query, args);
            return result === query ? proxy : result;
          };
        },
      });
      return proxy;
    },
  };
}

import { createHash } from 'node:crypto';

export const ORGANIZATION_CAROUSEL_SNAPSHOT_RPC = 'organization_carousel_snapshot';
const TABLES = {
  dynamic_directory: ['id', 'tenant_id', 'slug', 'entity_type', 'is_active', 'allowed_role_ids', 'public_carousel_enabled', 'filter_expression', 'filter_field_id', 'filter_value'],
  system_settings: ['id', 'tenant_id', 'setting_key', 'setting_value'],
  preference_field: ['id', 'tenant_id', 'entity_scope', 'is_active', 'name', 'field_type'],
  organization: ['id', 'tenant_id', 'name', 'logo_url'],
  organization_preference_value: ['id', 'organization_id', 'field_id', 'value'],
};
const ROW_LIMITS = { dynamic_directory: 2, system_settings: 100, preference_field: 10000, organization: 100000, organization_preference_value: 100000 };
const MAX_BYTES = 32 * 1024 * 1024;

// Deliberately not a general Supabase emulator. Unsupported columns/operators
// throw, rather than silently dropping a future helper's security constraint.
export function createOrganizationSnapshotAdapter(snapshot, tenantId) {
  if (!snapshot || snapshot.version !== 1 || snapshot.tenant_id !== tenantId) throw new Error('Invalid carousel snapshot scope');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) throw new Error('Carousel snapshot exceeds payload limit');
  for (const [table, columns] of Object.entries(TABLES)) {
    const rows = snapshot[table];
    if (!Array.isArray(rows) || rows.length > ROW_LIMITS[table]) throw new Error(`Invalid carousel snapshot ${table} inventory`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Object.keys(row).some(key => !columns.includes(key))
        || (table !== 'organization_preference_value' && row.tenant_id !== tenantId)) {
        throw new Error('Invalid carousel snapshot row scope');
      }
    }
  }
  const orgIds = new Set(snapshot.organization.map(row => row.id));
  const fieldIds = new Set(snapshot.preference_field.filter(row => row.entity_scope === 'organization').map(row => row.id));
  if (snapshot.organization_preference_value.some(row => !orgIds.has(row.organization_id) || !fieldIds.has(row.field_id))) {
    throw new Error('Invalid carousel snapshot value scope');
  }
  // Own the data: callers cannot mutate a snapshot between helper reads.
  const tables = structuredClone(snapshot);
  return {
    from(table) {
      if (!Object.hasOwn(TABLES, table)) throw new Error(`Unsupported carousel snapshot table: ${table}`);
      const columns = TABLES[table];
      const predicates = [];
      const sorts = [];
      let selected = columns, start = 0, end = Infinity, max = Infinity;
      const column = key => {
        if (!columns.includes(key)) throw new Error(`Unsupported carousel snapshot column: ${key}`);
      };
      const integer = value => {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid carousel snapshot pagination');
      };
      const query = {
        select(selection) {
          selected = selection === '*' ? columns : selection.split(',').map(key => key.trim());
          selected.forEach(column);
          return query;
        },
        eq(key, value) {
          column(key);
          // SQL equality does not match NULL (including eq(null)).
          predicates.push(row => row[key] != null && value != null && row[key] === value);
          return query;
        },
        in(key, values) {
          column(key);
          if (!Array.isArray(values)) throw new Error('Invalid carousel snapshot IN values');
          predicates.push(row => row[key] != null && values.includes(row[key]));
          return query;
        },
        order(key, options = {}) {
          column(key);
          if (Object.keys(options).some(key => !['ascending', 'nullsFirst'].includes(key))) throw new Error('Unsupported carousel snapshot ordering');
          sorts.push({ key, ascending: options.ascending !== false, nullsFirst: options.nullsFirst === true });
          return query;
        },
        limit(value) { integer(value); max = value; return query; },
        range(first, last) {
          integer(first); integer(last);
          if (last < first) throw new Error('Invalid carousel snapshot range');
          start = first; end = last; return query;
        },
        then(resolve, reject) {
          const rows = tables[table].filter(row => predicates.every(predicate => predicate(row)));
          rows.sort((a, b) => {
            for (const { key, ascending, nullsFirst } of sorts) {
              if (a[key] == null || b[key] == null) {
                if (a[key] == null && b[key] == null) continue;
                return (a[key] == null ? -1 : 1) * (nullsFirst ? 1 : -1);
              }
              const result = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
              if (result) return result * (ascending ? 1 : -1);
            }
            return 0;
          });
          const data = rows.slice(start, Math.min(end + 1, start + max))
            .map(row => Object.fromEntries(selected.map(key => [key, row[key]])));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

export async function loadOrganizationCarouselSnapshot(db, { tenantId, source, directoryId, slug }) {
  const { data, error } = await db.rpc(ORGANIZATION_CAROUSEL_SNAPSHOT_RPC, {
    p_tenant_id: tenantId, p_source: source, p_directory_id: directoryId || null, p_slug: slug || null,
  });
  if (error) {
    // Only this exact absent function may use the deploy-compatible old path.
    if ((error.code === 'PGRST202' || error.code === '42883')
      && `${error.message || ''} ${error.details || ''}`.includes(ORGANIZATION_CAROUSEL_SNAPSHOT_RPC)) return null;
    throw new Error('Unable to read organisation carousel snapshot', { cause: error });
  }
  // Non-organisation dynamic sources deliberately retain the original readers.
  if (data?.unsupported_entity === true && data?.tenant_id === tenantId && data?.version === 1) return null;
  return {
    db: createOrganizationSnapshotAdapter(data, tenantId),
    revision: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  };
}

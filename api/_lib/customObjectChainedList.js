import { createHash } from 'node:crypto';

const MAX_HOPS = 6;
const MAX_PATHS = 250;
const MAX_COLUMNS = 2000;
const MAX_SELECTED = 100;
const BATCH_SIZE = 200;
const PAGE_SIZE = 500;
const MAX_SCHEMA_ROWS = 5000;
const MAX_EXPANSION = 100_000;
const MAX_CELL_EXPANSION = 10_000;
const MAX_QUERIES = 1000;
const MAX_DISCOVERY_QUERIES = 500;
const endpointKey = (endpoint) => `${endpoint.kind}:${endpoint.custom_object_id || ''}`;
const endpointFor = (definition, side) => ({
  kind: definition[`${side}_kind`],
  custom_object_id: definition[`${side}_custom_object_id`] || null,
});
const opposite = (side) => side === 'source' ? 'target' : 'source';
const batches = function* (values) {
  for (let i = 0; i < values.length; i += BATCH_SIZE) yield values.slice(i, i + BATCH_SIZE);
};
const coreFields = {
  member: [
    ['full_name', 'Full name'], ['first_name', 'First name'],
    ['last_name', 'Last name'], ['email', 'Email'],
  ],
  organization: [['name', 'Name'], ['email', 'Email']],
  organization_group: [['name', 'Name']],
};
const coreLabels = {
  member: 'Member', organization: 'Organisation', organization_group: 'Organisation group',
};
const valueLabel = (value) => {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(valueLabel).filter(Boolean).join('; ');
  if (typeof value === 'object') return value.name || value.label || JSON.stringify(value);
  return String(value);
};
const identityFor = (column) => ({
  version: 1, path: column.path, endpoint: column.endpoint,
  terminal: {
    kind: column.terminal.kind,
    ...(column.terminal.field_id ? { field_id: column.terminal.field_id } : {}),
  },
});
const idFor = (column) =>
  `chained:v1:${createHash('sha256').update(JSON.stringify(identityFor(column))).digest('base64url')}`;

// No caller-supplied SQL keys or paths reach projection. The server rebuilds
// this catalogue from the current authorized schema and accepts opaque IDs only.
export function createChainedListService({
  db, tenantId, isAdmin, activeObject, hasCapability, fieldAccess,
  getFieldMetadata, ErrorClass,
}) {
  const fail = (status, message) => { throw new ErrorClass(status, message); };
  const checkDb = (error) => {
    if (error) fail(500, error.message || 'Could not load chained relationship data');
  };
  const limitError = (message) => {
    const error = new ErrorClass(422, message);
    error.chainedLimit = true;
    throw error;
  };
  async function schemaRows(build, charge) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      charge();
      const result = await build().range(offset, offset + PAGE_SIZE - 1);
      checkDb(result.error);
      rows.push(...(result.data || []));
      if (rows.length > MAX_SCHEMA_ROWS) limitError('Chained column schema exceeds the supported discovery limit.');
      if ((result.data || []).length < PAGE_SIZE) return rows;
    }
  }

  async function discover(objectId) {
    try {
      let queries = 0;
      const charge = () => {
        if (++queries > MAX_DISCOVERY_QUERIES) {
          limitError('Chained column discovery query limit exceeded. Existing columns remain available.');
        }
      };
      const definitions = await schemaRows(() => db.from('custom_object_relationship_definition')
        .select('*').eq('tenant_id', tenantId).eq('status', 'active').order('id', { ascending: true }), charge);
      const endpoints = new Map();
      const inspect = async (endpoint) => {
        const key = endpointKey(endpoint);
        if (endpoints.has(key)) return endpoints.get(key);
        let info = null;
        if (endpoint.kind === 'custom_object') {
          try {
            charge();
            const object = await activeObject(endpoint.custom_object_id);
            charge();
            if (await hasCapability(object.id, 'view_records')) {
              const fields = await schemaRows(() => db.from('preference_field').select('*')
                .eq('tenant_id', tenantId).eq('custom_object_id', object.id)
                .eq('entity_scope', 'custom_object').eq('is_active', true)
                .order('id', { ascending: true }), charge);
              const access = new Map();
              // Permission results are subject to the same PostgREST row cap
              // as data. Never treat an omitted denied-field grant as readable.
              for (const batch of batches(fields)) {
                charge();
                for (const [id, level] of await fieldAccess(object.id, batch)) access.set(id, level);
              }
              const readable = fields.filter((field) => access.get(String(field.id)) !== 'none');
              const primary = readable.find((field) => String(field.id) === String(object.primary_display_field_id));
              info = {
                label: object.singular_label || object.plural_label || 'Custom object',
                terminals: [
                  ...(primary && getFieldMetadata(primary).type !== 'file'
                    ? [{ kind: 'label', field_id: String(primary.id), field_key: getFieldMetadata(primary).key, label: 'Record label' }]
                    : []),
                  ...readable.map((field) => ({
                    kind: 'field', field_id: String(field.id),
                    field_key: getFieldMetadata(field).key,
                    field_type: getFieldMetadata(field).type, label: getFieldMetadata(field).label,
                  })),
                ],
              };
            }
          } catch (error) {
            if (![403, 404, 409].includes(error.status)) throw error;
          }
        } else if (isAdmin && coreFields[endpoint.kind]) {
          info = {
            label: coreLabels[endpoint.kind],
            terminals: [
              { kind: 'label', label: 'Record label' },
              ...coreFields[endpoint.kind].map(([id, label]) => ({
                kind: 'field', field_id: id, field_key: id, label,
              })),
            ],
          };
        }
        endpoints.set(key, info);
        return info;
      };
      const root = { kind: 'custom_object', custom_object_id: String(objectId) };
      charge();
      const rootObject = await activeObject(objectId);
      const queue = [{
        endpoint: root, path: [], seen: new Set([endpointKey(root)]),
        labels: [rootObject.singular_label || rootObject.plural_label || 'Records'],
      }];
      const columns = [];
      let paths = 0;
      while (queue.length) {
        const current = queue.shift();
        if (current.path.length >= MAX_HOPS) continue;
        for (const definition of definitions) {
          if (definition.tenant_id !== tenantId || definition.status !== 'active') continue;
          for (const side of ['source', 'target']) {
            const from = endpointFor(definition, side);
            const to = endpointFor(definition, opposite(side));
            const key = endpointKey(to);
            if (endpointKey(from) !== endpointKey(current.endpoint)
              || definition[`show_on_${side}`] === false || current.seen.has(key)) continue;
            const info = await inspect(to);
            if (!info) continue;
            if (++paths > MAX_PATHS) limitError('Chained column paths exceed the supported discovery limit.');
            const path = [...current.path, {
              relationship_definition_id: String(definition.id), from_side: side,
              from_endpoint: from, to_endpoint: to,
            }];
            const relationshipLabel = definition[`${side}_label`];
            const label = relationshipLabel && relationshipLabel !== info.label
              ? `${relationshipLabel} (${info.label})` : info.label;
            const labels = [...current.labels, label];
            for (const terminal of info.terminals) {
              const column = {
                kind: 'chained', version: 1, path, endpoint: to, terminal,
                label: `${labels.join(' → ')}${terminal.kind === 'label' ? '' : ` · ${terminal.label}`}`,
                sortable: false, filterable: false,
              };
              columns.push({ ...column, id: idFor(column) });
              if (columns.length > MAX_COLUMNS) limitError('Chained columns exceed the supported discovery limit.');
            }
            queue.push({ endpoint: to, path, seen: new Set([...current.seen, key]), labels });
          }
        }
      }
      // Parallel relationships can have identical human labels. Disambiguate
      // those options without changing the persisted definition-based identity.
      const labels = new Map();
      for (const column of columns) labels.set(column.label, (labels.get(column.label) || 0) + 1);
      for (const column of columns) {
        if (labels.get(column.label) > 1) {
          column.label += ` [${column.path.map((hop) =>
            definitions.find((definition) => String(definition.id) === hop.relationship_definition_id)?.relationship_key
              || hop.relationship_definition_id).join(' → ')}]`;
        }
      }
      return { columns };
    } catch (error) {
      if (error.chainedLimit) return { columns: [], error: error.message };
      // Archived owner lists existed before chained discovery.
      if ([404, 409].includes(error.status)) return { columns: [] };
      throw error;
    }
  }

  function select(raw, metadata) {
    if (raw == null || raw === '') return [];
    let ids = raw;
    if (typeof raw === 'string') {
      try { ids = JSON.parse(raw); } catch { fail(400, 'chainedColumns must be valid JSON'); }
    }
    if (!Array.isArray(ids) || ids.length > MAX_SELECTED || ids.some((id) => typeof id !== 'string')) {
      fail(400, `chainedColumns must be an array of at most ${MAX_SELECTED} column IDs`);
    }
    if (ids.length && metadata.chained_columns_error) fail(422, metadata.chained_columns_error);
    const available = new Map(metadata.chained_columns.map((column) => [column.id, column]));
    return [...new Set(ids)].map((id) => {
      const column = available.get(id);
      if (!column) fail(409, 'A chained column is stale, inaccessible, or unavailable. Remove it from Columns.');
      return column;
    });
  }

  async function project(records, columns) {
    if (!records.length || !columns.length) return records;
    let queries = 0;
    let scanned = 0;
    let expanded = 0;
    const queryBudget = () => {
      if (++queries > MAX_QUERIES) limitError('Chained column query limit exceeded. Select fewer columns or a smaller page.');
    };
    const prefixCache = new Map([['[]', records.map((record) => ({
      rootId: String(record.id), record, occurrence: String(record.id),
    }))]]);
    const endpointCache = new Map();
    async function loadEndpoints(endpoint, ids) {
      const key = endpointKey(endpoint);
      if (!endpointCache.has(key)) endpointCache.set(key, new Map());
      const cached = endpointCache.get(key);
      const missing = [...new Set(ids)].filter((id) => !cached.has(id));
      const table = {
        custom_object: 'custom_object_record', member: 'member',
        organization: 'organization', organization_group: 'organization_group',
      }[endpoint.kind];
      if (!table) fail(403, 'Unsupported chained endpoint');
      for (const batch of batches(missing)) {
        queryBudget();
        let q = db.from(table).select('*').eq('tenant_id', tenantId).in('id', batch);
        if (endpoint.kind === 'custom_object') q = q.eq('custom_object_id', endpoint.custom_object_id).is('archived_at', null);
        const { data, error } = await q;
        checkDb(error);
        for (const id of batch) cached.set(id, null);
        for (const row of data || []) {
          if (row.tenant_id === tenantId && row.archived_at == null
            && (endpoint.kind !== 'custom_object' || String(row.custom_object_id) === String(endpoint.custom_object_id))) {
            cached.set(String(row.id), row);
          }
        }
      }
      return cached;
    }
    async function follow(rows, hop) {
      if (!rows.length) return [];
      const routed = hop.from_side === 'source' ? 'source_record_id' : 'target_record_id';
      const other = hop.from_side === 'source' ? 'target_record_id' : 'source_record_id';
      const ids = [...new Set(rows.map((row) => String(row.record.id)))];
      const edges = [];
      for (const batch of batches(ids)) {
        let after = null;
        for (;;) {
          queryBudget();
          let q = db.from('custom_object_relationship').select('*')
            .eq('tenant_id', tenantId).eq('relationship_definition_id', hop.relationship_definition_id)
            .is('archived_at', null).in(routed, batch).order('id', { ascending: true });
          if (after) q = q.gt('id', after);
          const { data, error } = await q.range(0, PAGE_SIZE - 1);
          checkDb(error);
          const page = data || [];
          scanned += page.length;
          if (scanned > MAX_EXPANSION) limitError('Chained relationship scan limit exceeded. Use a smaller page.');
          edges.push(...page);
          if (page.length < PAGE_SIZE) break;
          const next = page.at(-1)?.id;
          if (!next || next === after) fail(500, 'Chained relationship traversal did not advance');
          after = next;
        }
      }
      const endpoints = await loadEndpoints(hop.to_endpoint, edges.map((edge) => String(edge[other])));
      const byParent = new Map();
      for (const edge of edges) {
        const record = endpoints.get(String(edge[other]));
        if (!record) continue;
        const key = String(edge[routed]);
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push({ record, edgeId: String(edge.id) });
      }
      const output = [];
      const perRoot = new Map();
      for (const row of rows) {
        for (const next of byParent.get(String(row.record.id)) || []) {
          const count = (perRoot.get(row.rootId) || 0) + 1;
          perRoot.set(row.rootId, count);
          if (count > MAX_CELL_EXPANSION || ++expanded > MAX_EXPANSION) {
            limitError('Chained relationship expansion limit exceeded. Use a smaller page or fewer columns.');
          }
          output.push({ rootId: row.rootId, record: next.record, occurrence: `${row.occurrence}/${next.edgeId}` });
        }
      }
      return output;
    }
    const values = new Map(records.map((record) => [String(record.id), {}]));
    for (const column of columns) {
      let rows = prefixCache.get('[]');
      for (let depth = 1; depth <= column.path.length; depth += 1) {
        const path = column.path.slice(0, depth);
        const key = JSON.stringify(path);
        if (!prefixCache.has(key)) prefixCache.set(key, await follow(rows, path.at(-1)));
        rows = prefixCache.get(key);
      }
      const grouped = new Map();
      for (const row of rows) {
        let value;
        if (column.endpoint.kind === 'custom_object') {
          value = row.record.data?.[column.terminal.field_key];
          // Chained cells are plain-text summaries, not download grants.
          // Return filenames only, never private URLs or storage descriptors.
          if (column.terminal.field_type === 'file') {
            value = (Array.isArray(value) ? value : value ? [value] : [])
              .map((file) => file && typeof file === 'object' ? file.file_name || file.name || 'File' : 'File')
              .join('; ');
          }
        }
        else if (column.terminal.kind === 'label') {
          value = column.endpoint.kind === 'member'
            ? [row.record.first_name, row.record.last_name].filter(Boolean).join(' ').trim() || row.record.email
            : row.record.name;
        } else if (column.terminal.field_id === 'full_name') {
          value = [row.record.first_name, row.record.last_name].filter(Boolean).join(' ').trim();
        } else value = row.record[column.terminal.field_key];
        if (!grouped.has(row.rootId)) grouped.set(row.rootId, []);
        grouped.get(row.rootId).push({ label: valueLabel(value) || '—', occurrence: row.occurrence });
      }
      for (const record of records) {
        const summaries = grouped.get(String(record.id)) || [];
        summaries.sort((a, b) => a.label.localeCompare(b.label) || a.occurrence.localeCompare(b.occurrence));
        values.get(String(record.id))[column.id] = {
          records: summaries.slice(0, 3).map(({ label }) => ({ label })), count: summaries.length,
        };
      }
    }
    return records.map((record) => ({ ...record, chained_values: values.get(String(record.id)) }));
  }
  return { discover, select, project };
}
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

export const reconcileOrder = (saved, available) => {
  const valid = new Set(available);
  const seen = new Set();
  const kept = (Array.isArray(saved) ? saved : [])
    .filter((id) => valid.has(id) && !seen.has(id) && seen.add(id));
  return [...kept, ...available.filter((id) => !seen.has(id))];
};

export const reconcileColumns = (saved, available, defaultVisible = []) => {
  const availableById = new Map(available.map((column) => [column.id, column]));
  const savedRows = Array.isArray(saved) ? saved : [];
  const savedById = new Map(savedRows.map((column) => [
    typeof column === 'string' ? column : column?.id,
    column,
  ]));
  const order = reconcileOrder(
    savedRows.map((column) => typeof column === 'string' ? column : column?.id),
    available.map((column) => column.id),
  );
  const defaults = new Set(defaultVisible);
  return order.map((id) => {
    const source = savedById.get(id);
    const definition = availableById.get(id);
    return {
      ...definition,
      visible: definition.locked === true
        ? true
        : source && typeof source === 'object' && typeof source.visible === 'boolean'
        ? source.visible
        : source
          ? true
          : defaults.has(id),
    };
  });
};

const relationshipId = (item) =>
  item?.id || item?.key || item?.relationship_definition_id || item?.relationshipDefinitionId;

const normalizeRelationship = (item) => {
  const rawId = relationshipId(item);
  if (!rawId) return null;
  const id = String(rawId).startsWith('relationship:')
    ? String(rawId)
    : `relationship:${rawId}${item?.routed_side ? `:${item.routed_side}` : ''}`;
  return {
    ...item,
    id,
    relationshipId: item.relationship_definition_id || item.relationshipDefinitionId || rawId,
    label: item.label || item.column_label || item.relationship_label || item.name || 'Related records',
    field_type: 'relationship',
    options: Array.isArray(item.options)
      ? item.options
      : Array.isArray(item.values)
        ? item.values
        : [],
    sortable: item.sortable !== false,
  };
};

export const normalizeListMetadata = (payload, fields = []) => {
  const metadata = payload?.list_metadata || payload?.listMetadata || payload?.metadata || {};
  const fieldById = new Map(fields.map((field) => [String(field.id), field]));
  const metadataFields = metadata.fields || metadata.columns?.filter((item) => !item.relationship_definition_id) || [];
  const listFields = metadataFields.length
    ? metadataFields.map((item) => ({
        ...(fieldById.get(String(item.field_id || item.id)) || item),
        ...item,
        id: item.field_id || item.id,
      })).filter((item) => item.id)
    : fields;
  const relationshipSources = [
    ...(metadata.relationships || []),
    ...(metadata.relationship_columns || metadata.relationshipColumns || []),
    ...(metadata.relationship_filters || metadata.relationshipFilters || []),
  ];
  const relationships = [];
  const seen = new Set();
  relationshipSources.forEach((source) => {
    const normalized = normalizeRelationship(source);
    if (normalized && !seen.has(normalized.id)) {
      seen.add(normalized.id);
      relationships.push(normalized);
    }
  });
  return { fields: listFields, relationships };
};

const labelOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.label || value.primary_label || value.display_value || value.displayValue || value.name || value.title || '';
};

export const boundedLabels = (values, limit = 3) => {
  const container = values && !Array.isArray(values) && typeof values === 'object'
    && (Array.isArray(values.values) || Array.isArray(values.records))
    ? values
    : null;
  const raw = container ? (container.values || container.records) : values;
  const list = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .map(labelOf)
    .filter(nonEmptyString);
  if (!list.length) return '—';
  const visible = list.slice(0, Math.max(1, limit));
  const declaredCount = Number(container?.count);
  const total = Number.isFinite(declaredCount) && declaredCount >= list.length
    ? declaredCount
    : list.length;
  const remainder = total - visible.length;
  return `${visible.join(', ')}${remainder > 0 ? ` +${remainder} more` : ''}`;
};

export const relationshipValuesFor = (record, column) => {
  const source = record?.relationship_values || record?.relationshipValues || record?.relationships || {};
  if (Array.isArray(source)) {
    const matching = source.filter((item) => {
      const id = relationshipId(item);
      return String(id) === String(column.relationshipId) || String(id) === String(column.id);
    });
    const values = matching.flatMap((item) => item.values || item.records || item.related_records || item);
    const count = matching.reduce((total, item) => {
      const declared = Number(item?.count);
      const itemValues = item?.values || item?.records || item?.related_records;
      return total + (Number.isFinite(declared) ? declared : Array.isArray(itemValues) ? itemValues.length : 1);
    }, 0);
    return { values, count };
  }
  const result = source[column.id]
    ?? source[column.relationshipId]
    ?? source[String(column.relationshipId)]
    ?? [];
  const values = result && !Array.isArray(result) && Array.isArray(result.records)
    ? result.records
    : Array.isArray(result) ? result : [result];
  const declared = Number(!Array.isArray(result) && result?.count);
  return {
    values,
    count: Number.isFinite(declared) ? declared : values.length,
  };
};

export const activeRecordFilters = (filters) => Object.fromEntries(
  Object.entries(filters || {}).filter(([, filter]) =>
    ['is_empty', 'is_not_empty'].includes(filter?.op)
    || filter?.value === false
    || (Array.isArray(filter?.value)
      ? filter.value.length > 0
      : String(filter?.value ?? '').trim() !== '')),
);

export const reconcileFilters = (saved, available) => {
  const definitions = new Map((available || []).map((item) => [String(item.id), item]));
  return Object.fromEntries(Object.entries(saved && typeof saved === 'object' ? saved : {})
    .filter(([id, filter]) => {
      const definition = definitions.get(String(id));
      if (!definition || !filter || typeof filter !== 'object') return false;
      const operators = Array.isArray(definition.operators)
        ? definition.operators.map((operator) =>
            typeof operator === 'string' ? operator : operator?.value).filter(Boolean)
        : [];
      return typeof filter.op === 'string'
        && (operators.length === 0 || operators.includes(filter.op));
    }));
};

export const initialRecordListState = {
  page: 1,
  pageSize: 25,
  search: '',
  searchInput: '',
  sortField: 'created_at',
  sortDir: 'desc',
  includeArchived: false,
  filters: {},
};

export const recordListReducer = (state, action) => {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.value, page: action.keepPage ? state.page : 1 };
    case 'page':
      return { ...state, page: action.value };
    case 'filter': {
      const filters = { ...state.filters };
      if (action.value == null) delete filters[action.id];
      else filters[action.id] = action.value;
      return { ...state, filters, page: 1 };
    }
    case 'reset':
      return { ...initialRecordListState, pageSize: state.pageSize };
    case 'replace':
      return {
        ...initialRecordListState,
        ...action.value,
        page: 1,
        searchInput: action.value?.search || '',
        filters: action.value?.filters && typeof action.value.filters === 'object'
          ? action.value.filters
          : {},
      };
    default:
      return state;
  }
};

export const buildRecordQueryString = (
  state,
  { page = state.page, pageSize = state.pageSize, relationshipColumns = [] } = {},
) =>
  new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    search: state.search,
    sortField: state.sortField,
    sortDir: state.sortDir,
    includeArchived: String(state.includeArchived),
    filters: JSON.stringify(activeRecordFilters(state.filters)),
    relationshipColumns: JSON.stringify(relationshipColumns),
  }).toString();
export const TIER_LIFECYCLE = {
  active: { label: 'Active', group: 'Current' },
  scheduled: { label: 'Scheduled', group: 'Scheduled' },
  historical: { label: 'Historical', group: 'History' },
};

export function getTierLifecycle(item) {
  const status = item?.status || (item?.effective_to ? 'historical' : 'active');
  return TIER_LIFECYCLE[status] ? status : 'historical';
}

export function getTierScopeLabel(item, fieldLabel) {
  const entity = item?.structure_scope_type === 'member' ? 'members' : 'organisations';
  if (!item?.structure_field_id) return `All ${entity}`;
  const field = fieldLabel || item?.structure_field_name || 'Selected field';
  const entityLabel = item?.structure_scope_type === 'member' ? 'Member' : 'Organisation';
  return `${entityLabel} · ${field} = ${item?.structure_match_value || '(not set)'}`;
}

export function getTierEffectivePeriod(item, formatDate) {
  const from = formatDate(item?.effective_from) || 'No start date';
  const lifecycle = getTierLifecycle(item);
  if (lifecycle === 'scheduled') return `Starts ${from}`;
  return `${from} – ${item?.effective_to ? formatDate(item.effective_to) : 'Present'}`;
}

export function groupTierStructures(items) {
  return items.reduce((groups, item) => {
    const lifecycle = getTierLifecycle(item);
    groups[lifecycle].push(item);
    return groups;
  }, { active: [], scheduled: [], historical: [] });
}

export function filterTierStructures(items, query, { formatDate, getFieldLabel } = {}) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  return items.filter(item => {
    const lifecycle = getTierLifecycle(item);
    const lifecycleDetails = TIER_LIFECYCLE[lifecycle];
    const fieldLabel = getFieldLabel?.(item);
    const searchableText = [
      item?.name || 'Untitled structure',
      lifecycleDetails.label,
      lifecycleDetails.group,
      getTierScopeLabel(item, fieldLabel),
      getTierEffectivePeriod(item, formatDate || (value => value || '')),
    ].join(' ').toLocaleLowerCase();

    return searchableText.includes(normalizedQuery);
  });
}

export function isHistoricalTierSelection(selectedId, items) {
  if (!selectedId) return false;
  const selected = items.find(item => item.id === selectedId);
  return !!selected && getTierLifecycle(selected) === 'historical';
}

export function isTierSelectionReadOnly(selectedId, items) {
  if (!selectedId) return false;
  const selected = items.find(item => item.id === selectedId);
  return !!selected && selected.effective_to != null;
}

export function shouldBootstrapTierSelection({ selectedId, viewingHistorical, isCreatingNew }) {
  return !selectedId && !viewingHistorical && !isCreatingNew;
}

export function isAnnualTierStructure(record = {}) {
  return String(record?.billing_period || '').toLowerCase() === 'annual';
}
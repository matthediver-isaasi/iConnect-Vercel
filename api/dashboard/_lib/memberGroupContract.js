// The same allow-list is enforced during save, preview and saved execution.
export const GROUP_METRICS = ['groups', 'current_members', 'current_organizations', 'joins', 'period_end_members'];
export const GROUP_CUSTOM_TYPES = new Set([
  'text', 'string', 'textarea', 'long_text', 'number', 'decimal', 'boolean',
  'date', 'picklist', 'dropdown', 'list', 'country', 'countries',
]);
export const GROUP_FIELDS = [
  { name: 'group_id', label: 'Group', type: 'reference' },
  { name: 'group_name', label: 'Group name', type: 'text' },
  { name: 'is_active', label: 'Group active', type: 'boolean' },
  { name: 'group_role', label: 'Membership role', type: 'text' },
  { name: 'role_id', label: 'Member role', type: 'text' },
  { name: 'organization_id', label: 'Member organisation', type: 'text' },
  { name: 'login_enabled', label: 'Member login enabled', type: 'boolean' },
  { name: 'membership_at', label: 'Membership history date', type: 'date' },
];
const groupOnly = new Set(['group_id', 'group_name', 'is_active']);
const operators = new Set(['eq', 'neq', 'in', 'contains', 'is_null', 'is_not_null', 'gt', 'gte', 'lt', 'lte']);

export function validateMemberGroupWidgetType(config, widgetType) {
  if (config?.source !== 'member_group') return;
  if (!['stat', 'bar', 'pie', 'donut', 'line', 'list'].includes(widgetType)) {
    throw new Error('Member Groups: a supported widget type is required');
  }
  if (['joins', 'period_end_members'].includes(config.measure?.field) && ['pie', 'donut'].includes(widgetType)) {
    throw new Error('Member Groups: temporal pie and donut widgets are unavailable');
  }
  if (widgetType === 'stat' && config.seriesBy) {
    throw new Error('Member Groups: stat widgets cannot split into group series');
  }
}

export function validateMemberGroupConfig(config, customFields) {
  if (config.source !== 'member_group') return;
  const fail = message => { throw new Error(`Member Groups: ${message}`); };
  const metric = config.measure?.field;
  if (config.measure?.aggregator !== 'count' || !GROUP_METRICS.includes(metric)
      || (config.measure.fieldKind && config.measure.fieldKind !== 'system')
      || config.measure.fieldId || config.measure.additionalFields?.length) fail('choose a supported count measure');
  if (config.clickThrough) fail('click-through is unavailable');
  if (config.transition || config.conversion || config.participation) fail('unsupported source mode');
  if (config.groupBy && config.timeBucket) fail('choose a breakdown or a time bucket, not both');
  const temporal = metric === 'joins' || metric === 'period_end_members';
  if (config.timeBucket && !temporal) fail('only joins and period-end members support time buckets');
  if (metric === 'period_end_members' && !config.timeBucket) fail('period-end members requires time buckets');
  if (config.cumulative && (metric !== 'joins' || !config.timeBucket)) fail('cumulative is only supported for time-bucketed joins');
  if (config.seriesBy && (!config.timeBucket || config.seriesBy.kind !== 'system' || config.seriesBy.field !== 'group_id')) fail('time series can only split by group');
  if (config.timeBucket && (config.timeBucket.field !== 'membership_at'
      || (config.timeBucket.fieldKind && config.timeBucket.fieldKind !== 'system')
      || config.timeBucket.fieldId)) fail('use the membership history date');
  function check(ref, kind) {
    if (kind === 'custom') {
      if (metric === 'groups') fail('group counts cannot use member custom fields');
      if (!ref.fieldId) fail('custom field ID is required');
      if (customFields && !customFields.some(f => f.id === ref.fieldId)) fail('custom field is unavailable for this tenant');
      return;
    }
    if (!GROUP_FIELDS.some(f => f.name === ref.field) || ref.field === 'membership_at') fail('unsupported field');
    if (metric === 'groups' && !groupOnly.has(ref.field)) fail('group counts only support group dimensions');
  }
  if (config.groupBy) check(config.groupBy, config.groupBy.kind);
  for (const f of config.filters || []) {
    check(f, f.fieldKind);
    if (!operators.has(f.operator) || f.orgField) fail('unsupported filter operator');
    if (f.operator === 'in' && !Array.isArray(f.value)) fail('in filters require an array');
    if (!['is_null', 'is_not_null'].includes(f.operator) && f.value == null) fail('filter value is required');
  }
}
import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Do not derive option values from labels: renewal mapping matches exact answers.
function sourceOptions(source) {
  if (!Array.isArray(source?.options)) return [];
  const seen = new Set();
  return source.options.flatMap(option => {
    const rawValue = option && typeof option === 'object' ? option.value : option;
    if (rawValue === undefined || rawValue === null) return [];
    const value = String(rawValue);
    if (seen.has(value)) return [];
    seen.add(value);
    return [{
      value,
      label: String(
        (option && typeof option === 'object' ? option.label : null)
        ?? (value || '(empty answer)'),
      ),
    }];
  });
}

export default function MembershipScheduleMappingSettings({
  field,
  allFields,
  tierConfigs,
  loading = false,
  error = null,
  onChange,
}) {
  const id = useId();
  const mapping = field.membership_schedule_mapping;
  const enabled = mapping != null;
  const fieldsAvailable = Array.isArray(allFields);
  const configsAvailable = Array.isArray(tierConfigs);
  const eligibleFields = (fieldsAvailable ? allFields : []).filter(candidate =>
    candidate
    && String(candidate.id) !== String(field.id)
    && candidate.id != null
    && ['radio', 'select', 'dropdown'].includes(candidate.type)
    && sourceOptions(candidate).length > 0,
  );
  const sourceId = String(mapping?.source_field_id ?? '');
  const source = eligibleFields.find(candidate => String(candidate.id) === sourceId);
  const options = sourceOptions(source);
  const entries = Array.isArray(mapping?.entries) ? mapping.entries : [];
  const schedules = (configsAvailable ? tierConfigs : []).filter(config =>
    config && config.id != null
    && config.structure_scope_type === 'member'
    && config.is_active !== false,
  );
  const scheduleIds = new Set(schedules.map(config => String(config.id)));
  const discoveryUnavailable = loading || Boolean(error) || !configsAvailable;
  const unmapped = options.filter(option =>
    !entries.some(entry => entry.value === option.value && entry.config_id),
  );
  const staleEntries = source
    ? entries.filter(entry => !options.some(option => option.value === entry.value))
    : [];

  const updateEntry = (value, selected) => {
    const nextEntries = entries.filter(entry => entry.value !== value);
    if (selected !== 'unmapped') {
      nextEntries.push({ value, config_id: selected.slice('config:'.length) });
    }
    onChange({
      membership_schedule_mapping: {
        source_field_id: sourceId,
        entries: nextEntries,
      },
    });
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
      data-testid={`membership-schedule-mapping-${field.id}`}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-enabled`}
          checked={enabled}
          onCheckedChange={checked => onChange({
            membership_schedule_mapping: checked === true
              ? { source_field_id: '', entries: [] }
              : null,
          })}
          aria-describedby={`${id}-description`}
        />
        <Label htmlFor={`${id}-enabled`} className="text-xs font-medium leading-4">
          Choose renewal schedule from a form answer
        </Label>
      </div>
      <p id={`${id}-description`} className="text-xs text-slate-500">
        Map each exact answer to a member schedule for the next renewal term.
        Prices come from the mapped schedules, not a base schedule. Existing
        membership dates are left untouched.
      </p>

      {enabled && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-source`} className="text-xs">
              Answer source
            </Label>
            <Select
              value={sourceId ? `field:${sourceId}` : ''}
              disabled={!fieldsAvailable}
              onValueChange={value => onChange({
                membership_schedule_mapping: {
                  source_field_id: value.slice('field:'.length),
                  entries: [],
                },
              })}
            >
              <SelectTrigger id={`${id}-source`}>
                <SelectValue placeholder="Select a single-choice field" />
              </SelectTrigger>
              <SelectContent>
                {sourceId && !source && (
                  <SelectItem value={`field:${sourceId}`} disabled>
                    Unavailable source field
                  </SelectItem>
                )}
                {eligibleFields.map(candidate => (
                  <SelectItem key={candidate.id} value={`field:${candidate.id}`}>
                    {candidate.label || 'Untitled Field'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">
              Radio, select and dropdown fields with options only. Changing the
              source clears its saved answer mappings.
            </p>
          </div>

          <div aria-live="polite" className="space-y-1 text-xs text-amber-700">
            {!fieldsAvailable ? (
              <p>Form fields are unavailable. Saved mappings have been kept.</p>
            ) : sourceId && !source ? (
              <p>
                The saved source is missing, deleted or no longer a single-choice
                field with options. Choose another source to replace its mappings.
              </p>
            ) : !sourceId ? (
              <p>Choose an answer source, then map every option to a schedule.</p>
            ) : null}
            {fieldsAvailable && eligibleFields.length === 0 && (
              <p>Add a radio, select or dropdown field with options to this form.</p>
            )}
            {loading && (
              <p role="status">Loading member schedules. Saved mappings have been kept.</p>
            )}
            {error && (
              <p role="alert">
                Member schedules could not be loaded. Retry loading them before
                editing schedule choices. Saved mappings have been kept.
              </p>
            )}
            {!loading && !error && !configsAvailable && (
              <p>Member schedules are unavailable. Saved mappings have been kept.</p>
            )}
            {!discoveryUnavailable && schedules.length === 0 && (
              <p>No active member schedules are available.</p>
            )}
            {unmapped.length > 0 && (
              <p>
                {unmapped.length} answer option{unmapped.length === 1 ? ' is' : 's are'} unmapped.
                Choose a schedule for every answer; there is no base-schedule fallback.
              </p>
            )}
            {staleEntries.length > 0 && (
              <p>
                Saved mappings for removed answer options have been kept:
                {' '}{staleEntries.map(entry => JSON.stringify(entry.value)).join(', ')}.
                These no longer match a current option.
              </p>
            )}
          </div>

          {source && (
            <div className="space-y-3">
              {options.map((option, index) => {
                const configId = String(
                  entries.find(entry => entry.value === option.value)?.config_id ?? '',
                );
                const unavailable = configId && !scheduleIds.has(configId);
                const warningId = `${id}-warning-${index}`;
                return (
                  <div key={option.value} className="space-y-1">
                    <Label htmlFor={`${id}-option-${index}`} className="text-xs">
                      {option.label}
                    </Label>
                    <Select
                      value={configId ? `config:${configId}` : 'unmapped'}
                      disabled={discoveryUnavailable}
                      onValueChange={value => updateEntry(option.value, value)}
                    >
                      <SelectTrigger
                        id={`${id}-option-${index}`}
                        aria-describedby={unavailable ? warningId : undefined}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unmapped">Not mapped</SelectItem>
                        {unavailable && (
                          <SelectItem value={`config:${configId}`} disabled>
                            {discoveryUnavailable ? 'Saved schedule (not verified)' : 'Unavailable schedule'}
                          </SelectItem>
                        )}
                        {schedules.map(config => (
                          <SelectItem key={config.id} value={`config:${config.id}`}>
                            {config.name || 'Unnamed schedule'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {unavailable && (
                      <p id={warningId} className="text-xs text-amber-700">
                        {discoveryUnavailable
                          ? 'This saved schedule cannot be verified until schedules load. Its mapping has been kept.'
                          : 'This saved schedule is deleted, inactive or not member-scoped. Choose an active member schedule.'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

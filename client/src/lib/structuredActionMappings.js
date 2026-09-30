export function applyStructuredMappingSourceSelection({
  mapping,
  sourceFieldId,
  addressComponent,
  resolvedRecordSource = null,
}) {
  const {
    source_component: _sourceComponent,
    record_sources: _recordSources,
    separator: _separator,
    static_value: _staticValue,
    ...base
  } = mapping;
  const isStatic = sourceFieldId === 'static';
  const isResolved = Boolean(resolvedRecordSource);
  return {
    ...base,
    source_type: isResolved ? 'resolved_record_labels' : isStatic ? 'static' : 'field',
    source_field_id: isResolved || isStatic ? '' : sourceFieldId,
    ...(isResolved
      ? { record_sources: [resolvedRecordSource], separator: ' - ' }
      : {}),
    ...(isStatic ? { static_value: '' } : {}),
    ...(addressComponent ? { source_component: addressComponent } : {}),
    target_field_id: '',
    target_type: 'core',
  };
}
// Display role names, but preserve IDs as the workflow engine's values.
export function workflowMemberFields(fields, roles) {
  const options = roles.filter(role => role.id && role.name)
    .map(role => ({ value: role.id, label: role.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return fields.map(field => field.id === 'role_id'
    ? { ...field, label: 'Role', type: 'dropdown', options }
    : field);
}

export function preserveWorkflowRoleValue(field, value) {
  if (field?.id !== 'role_id' || field.type !== 'dropdown' || !value
    || field.options.some(option => option.value === value)) return field;
  return { ...field, options: [...field.options, { value, label: 'Unavailable role (saved selection)' }] };
}

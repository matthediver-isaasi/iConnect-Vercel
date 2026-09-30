const INVALID_ROLE_CODE = 'INVALID_MEMBER_ROLE_ASSIGNMENT';

const errorBody = (error) => (
  error?.body
  || error?.response?.data
  || error?.data
  || null
);

const settingLabel = (setting) => {
  const value = String(setting || '').toLowerCase();
  if (value.includes('fallback')) return 'Fallback role';
  if (value.includes('value_to_role') || value.includes('answer')) return 'Answer mapping';
  if (value.includes('role')) return 'Fixed role';
  return setting || 'Role assignment';
};

export function unavailableRoleLabel(roleId) {
  return `Unavailable role (${roleId}) — select a replacement`;
}

export function formRoleValidationError(error, action = 'save') {
  const body = errorBody(error);
  const code = body?.code || error?.code;
  const invalidSettings = body?.details?.invalid_role_settings;
  if (code !== INVALID_ROLE_CODE || !Array.isArray(invalidSettings)) return null;

  const serverMessage = body?.message || body?.error;
  const title = serverMessage || `This form cannot be ${action === 'copy' ? 'copied' : 'saved'} until unavailable member roles are replaced.`;
  const items = invalidSettings.map((item) => {
    const pipeline = item?.pipeline_label
      ? `“${item.pipeline_label}”`
      : `Pipeline ${(Number.isInteger(item?.pipeline_index) ? item.pipeline_index : 0) + 1}`;
    const answer = item?.answer !== undefined && item?.answer !== null
      ? ` for answer “${String(item.answer)}”`
      : '';
    const role = item?.role_id ? ` (${item.role_id})` : '';
    return `${pipeline}: ${settingLabel(item?.setting)}${answer} uses an unavailable role${role}.`;
  });

  return {
    title,
    description: `${items.join('\n')} Select an available replacement in the member pipeline settings, then try again.`,
  };
}
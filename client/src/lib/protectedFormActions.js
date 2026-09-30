export function protectedFormUpdateHeaders(password, { deactivation = false } = {}) {
  return {
    'X-Form-Protection-Password': password,
    ...(deactivation ? { 'X-Form-Deactivation-Confirmed': 'true' } : {}),
  };
}

export async function verifyProtectedFormPassword({
  formId,
  password,
  tenantId,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl('/api/forms/verify-protection-password', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ form_id: formId, password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error || payload?.message || 'Incorrect protection password.',
    );
  }
  return payload;
}
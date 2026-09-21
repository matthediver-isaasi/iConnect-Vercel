export const ROLE_SETTINGS_CHANGED = 'role-settings-copied';

export async function refreshRoleSettingsQueries(queryClient) {
  await queryClient.cancelQueries();
  // Clear security/editor projections immediately, including inactive caches.
  await queryClient.resetQueries({
    predicate: query => /role|permission|resource-categor/i.test(String(query.queryKey[0])),
  });
  await queryClient.invalidateQueries();
}

export async function copyRoleSettings(sourceRoleId, targetRoleId, request = fetch) {
  if (!sourceRoleId || !targetRoleId || sourceRoleId === targetRoleId) {
    throw new Error('Select two different roles.');
  }
  const response = await request('/api/admin/roles/copy-settings', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceRoleId, targetRoleId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.role) {
    throw new Error(result.error || 'Failed to copy role settings. Reload the roles before retrying.');
  }
  return result.role;
}

// Never send role contents across tabs. Receivers refetch authoritative data.
export function publishRoleSettingsCopy(targetRoleId, target = window) {
  const detail = { targetRoleId, revision: `${Date.now()}-${Math.random()}` };
  target.dispatchEvent(new CustomEvent(ROLE_SETTINGS_CHANGED, { detail }));
  try {
    target.localStorage.setItem(ROLE_SETTINGS_CHANGED, JSON.stringify(detail));
  } catch {
    // Same-tab refresh still works when browser storage is disabled.
  }
}

export function subscribeRoleSettingsCopy(listener, target = window) {
  const local = event => listener(event.detail);
  const storage = event => {
    if (event.key !== ROLE_SETTINGS_CHANGED || !event.newValue) return;
    try {
      const detail = JSON.parse(event.newValue);
      if (detail.targetRoleId) listener(detail);
    } catch { /* Ignore malformed, non-authoritative browser messages. */ }
  };
  target.addEventListener(ROLE_SETTINGS_CHANGED, local);
  target.addEventListener('storage', storage);
  return () => {
    target.removeEventListener(ROLE_SETTINGS_CHANGED, local);
    target.removeEventListener('storage', storage);
  };
}
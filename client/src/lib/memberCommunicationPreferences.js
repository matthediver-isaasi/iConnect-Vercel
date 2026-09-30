export async function fetchAdminMemberCommunicationPreferences(memberId) {
  const response = await fetch(`/api/admin/members/${memberId}/communication-preferences`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load communication preferences');
  }
  return response.json();
}

export async function setAdminMemberCommunicationGlobalState(memberId, optOutAll) {
  const response = await fetch(`/api/admin/members/${memberId}/communication-preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle_all', optOutAll }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update communication preferences');
  }
  return response.json();
}
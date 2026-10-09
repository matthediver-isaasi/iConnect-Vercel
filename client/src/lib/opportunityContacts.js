export async function loadOpportunityContacts(organizationId, { signal, fetchImpl = fetch } = {}) {
  const members = new Map();
  let offset = 0;
  do {
    const query = new URLSearchParams({ organizationId, offset: String(offset) });
    const response = await fetchImpl(`/api/opportunities/contacts?${query}`, { credentials: 'include', signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not load organisation contacts');
    if (!Array.isArray(payload.items) || payload.items.some(item => !item.id || item.organization_id !== organizationId)) {
      throw new Error('Invalid organisation contact response');
    }
    for (const item of payload.items) members.set(item.id, item);
    if (payload.nextOffset === null) return [...members.values()];
    if (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset) {
      throw new Error('Invalid contact pagination');
    }
    offset = payload.nextOffset;
  } while (!signal?.aborted);
  throw new Error('Contact loading cancelled');
}

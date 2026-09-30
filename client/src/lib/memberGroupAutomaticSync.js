const MAX_SYNC_BATCHES = 10_000;
const MAX_CONFLICT_RETRIES = 3;

export function uniqueGroupPersonCount(assignments = []) {
  const people = new Set();
  for (const assignment of assignments) {
    if (assignment?.member_id) people.add(`member:${assignment.member_id}`);
    else if (assignment?.guest_id) people.add(`guest:${assignment.guest_id}`);
  }
  return people.size;
}

export async function reconcileAutomaticMembershipFully({
  groupId,
  fetchImpl = fetch,
  onProgress,
}) {
  if (!groupId) throw new Error('Group ID is required');

  let inserted = 0;
  let deleted = 0;
  let batches = 0;
  let conflictRetries = 0;

  while (batches < MAX_SYNC_BATCHES) {
    const response = await fetchImpl('/api/member-groups/automatic-membership', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile', groupId }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      const retryableConflict = response.status === 409
        && ['STALE_GENERATION', 'CURSOR_MISMATCH'].includes(result?.code);
      if (retryableConflict && conflictRetries < MAX_CONFLICT_RETRIES) {
        conflictRetries += 1;
        continue;
      }
      const error = new Error(result?.error || `Automatic membership sync failed (${response.status})`);
      error.code = result?.code;
      throw error;
    }

    conflictRetries = 0;
    batches += 1;
    inserted += Number(result.inserted) || 0;
    deleted += Number(result.deleted) || 0;
    onProgress?.({
      batches,
      inserted,
      deleted,
      matchCount: result.matchCount,
      hasMore: result.hasMore === true,
      syncStatus: result.syncStatus,
    });

    if (result.hasMore !== true) {
      return {
        ...result,
        batches,
        inserted,
        deleted,
      };
    }
  }

  throw new Error('Automatic membership sync exceeded the safe batch limit');
}
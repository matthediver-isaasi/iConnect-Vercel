export const profileQueryKey = (memberId) => ["fresh-member-data", memberId];

// A returned member row is not a session snapshot. Only reconcile fields that
// this write owns, preserving role enrichment and other session metadata.
export function confirmedProfilePatch(saved, submitted, memberId) {
  if (!saved || saved.id !== memberId) {
    throw new Error("Profile save did not return the member");
  }
  return Object.fromEntries(Object.keys(submitted).map(key => {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) {
      throw new Error(`Profile save did not confirm ${key}`);
    }
    return [key, saved[key]];
  }));
}

export async function synchronizeProfile({ queryClient, memberId, patch, sessionMember, setSessionMember, storage }) {
  // Cancel even reads started while the write was pending, before publishing.
  await queryClient.cancelQueries({ queryKey: profileQueryKey(memberId), exact: true });
  queryClient.setQueryData(profileQueryKey(memberId), old => ({ ...old, ...patch }));
  setSessionMember(old => old?.id === memberId ? { ...old, ...patch } : old);
  try {
    const stored = JSON.parse(storage.getItem("agcas_member") || "null");
    if (stored && stored.id !== memberId) return;
    storage.setItem("agcas_member", JSON.stringify({ ...(stored || sessionMember), ...patch }));
  } catch {
    // Storage is best-effort; it must never prevent the confirmed UI update.
    try {
      storage.setItem("agcas_member", JSON.stringify({ ...sessionMember, ...patch }));
    } catch { /* Browser storage may be unavailable. */ }
  }
}
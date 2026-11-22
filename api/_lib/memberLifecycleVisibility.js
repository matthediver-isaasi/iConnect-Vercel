const installed = new WeakSet();
export const isOperationalLifecycleMember = member => !['archived', 'minimised', 'deleted'].includes(member?.lifecycle_state);

export async function lifecycleVisibilityInstalled(db) {
  if (installed.has(db)) return true;
  const { data, error } = await db.rpc('member_lifecycle_operational_ready');
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) return false;
    throw error;
  }
  if (data !== true) throw new Error('Lifecycle visibility contract unavailable');
  installed.add(db);
  return true;
}

// Wrap the builder: returning it directly from an async helper would execute it
// before callers finish tenant scoping, filtering, sorting and pagination.
export async function operationalMemberQuery(db, query) {
  return { query: await lifecycleVisibilityInstalled(db)
    ? query.not('lifecycle_state', 'in', '(archived,minimised,deleted)') : query };
}

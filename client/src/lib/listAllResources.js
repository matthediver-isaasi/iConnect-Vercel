// Task #3220: fetch ALL resources for the tenant, not just the first 1000.
//
// The generic entity API (backed by Supabase/PostgREST) caps any single list
// query at 1000 rows, so `Resource.list('-release_date')` silently truncated
// large tenants. This helper pages through the entity API using its
// limit/offset params until every row is retrieved.
//
// Ordering is release_date desc with id asc as a unique tiebreaker so the
// order is deterministic across page boundaries (no skipped/duplicated rows
// when many resources share the same release_date).
import { base44 } from '@/api/base44Client';

export async function listAllResources() {
  return base44.entities.Resource.listAll({
    sort: { release_date: 'desc', id: 'asc' },
  });
}

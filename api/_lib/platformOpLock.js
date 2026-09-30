import crypto from 'crypto';

/**
 * Atomic platform operation lease backed by the platform_op_lock table and
 * the acquire/release RPC pair (supabase/migrations/20260813_platform_op_lock.sql).
 *
 * - Acquire is a single atomic INSERT ... ON CONFLICT DO UPDATE that only
 *   succeeds when there is no live holder (or the lease expired / the caller
 *   already holds it), so concurrent acquirers are serialized by Postgres.
 * - Release deletes only the row owned by this invocation's random token, so
 *   a slow invocation can never release a lease another invocation now holds.
 * - Fail-closed: any RPC error refuses the lease rather than running the
 *   operation unguarded.
 */
export async function acquirePlatformOpLock(supabase, key, info, ttlSeconds = 600) {
  const token = crypto.randomBytes(16).toString('hex');
  const { data, error } = await supabase.rpc('acquire_platform_op_lock', {
    p_key: key,
    p_token: token,
    p_info: info || {},
    p_ttl_seconds: ttlSeconds,
  });
  if (error) {
    return { ok: false, error: `Lock acquisition failed: ${error.message}` };
  }
  if (!data?.acquired) {
    return { ok: false, holder: data?.holder_info || null, expiresAt: data?.expires_at || null };
  }
  return {
    ok: true,
    token,
    release: async () => {
      const { error: relErr } = await supabase.rpc('release_platform_op_lock', {
        p_key: key,
        p_token: token,
      });
      if (relErr) {
        // The TTL guarantees the lease self-expires; just surface it.
        console.warn(`[platformOpLock] release failed for ${key}: ${relErr.message}`);
        return false;
      }
      return true;
    },
  };
}

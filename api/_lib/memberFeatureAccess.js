// Task #2257: Help Center AI Q&A — server-side member feature-access resolver.
//
// This is the server-side equivalent of the client's useMemberAccess hook
// (client/src/hooks/useMemberAccess.js). It combines a member's role
// `excluded_features` with their per-member `member_excluded_features`, then
// reuses the hierarchical exclusion check in roleVisibility.js.
//
// SECURITY: for the AI Q&A this resolution IS the retrieval security boundary,
// so it fails CLOSED — if a role's exclusions can't be loaded we throw rather
// than silently granting access to gated content.

import { isResourceExcluded } from './roleVisibility.js';
import { supabase as defaultSupabase } from './database.js';

/**
 * Resolve the combined exclusion list for a member.
 *
 * @param {object} args
 * @param {string|null} args.roleId                 member's role_id
 * @param {string[]}    args.memberExcludedFeatures member-level exclusions
 * @param {object}      [client]                    supabase client (defaults to server)
 * @returns {Promise<string[]>} combined exclusion keys
 */
export async function resolveMemberExclusions(
  { roleId, memberExcludedFeatures = [] } = {},
  client = defaultSupabase
) {
  let roleExclusions = [];
  if (roleId) {
    if (!client) {
      throw new Error('Cannot resolve role exclusions: no database client');
    }
    const { data, error } = await client
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    // Fail closed on lookup error (but tolerate a missing role row: a member
    // with a dangling role_id is treated as having no role exclusions, matching
    // the client which resolves an absent role to an empty list).
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to load role exclusions: ${error.message}`);
    }
    if (data && Array.isArray(data.excluded_features)) {
      roleExclusions = data.excluded_features;
    }
  }
  const memberExclusions = Array.isArray(memberExcludedFeatures)
    ? memberExcludedFeatures
    : [];
  return [...roleExclusions, ...memberExclusions];
}

/**
 * Build an access checker from a combined exclusion list.
 */
export function makeFeatureAccessChecker(exclusions) {
  const list = Array.isArray(exclusions) ? exclusions : [];
  const isFeatureExcluded = (key) => isResourceExcluded(list, key);
  return {
    exclusions: list,
    isFeatureExcluded,
    canAccessFeature: (key) => !isFeatureExcluded(key),
    // A chunk is visible only when EVERY one of its gates is accessible.
    canAccessAllGates: (gates) =>
      !Array.isArray(gates) || gates.length === 0
        ? true
        : gates.every((g) => !g || !isFeatureExcluded(g)),
  };
}

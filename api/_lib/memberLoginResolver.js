import { supabase as defaultSupabase } from './database.js';

/**
 * Returns true if a member row has been soft-deleted/anonymized.
 * Soft-deleted members keep their id (for FK preservation) but have an
 * email of the form `deleted_<uuid>@deleted.local` and login_enabled=false.
 */
export function isMemberSoftDeleted(member) {
  if (!member) return false;
  const email = member.email || '';
  return email.startsWith('deleted_') && email.endsWith('@deleted.local');
}

function pickFirstValid(members) {
  if (!Array.isArray(members)) return null;
  return members.find((m) => m && !isMemberSoftDeleted(m)) || null;
}

/**
 * Resolve which `member` row should be used to authenticate a given
 * (identity, tenant) or (email, tenant) combination.
 *
 * The same resolution is used by:
 *   - api/auth/login.js (email/password flow)
 *   - api/auth/google/callback.js (Google OAuth flow)
 *   - api/admin/members/[memberId] (so the admin "Active / Login Disabled"
 *     badge reflects what auth actually sees)
 *
 * Returns:
 *   {
 *     member,                     // the resolved active member, or null
 *     candidates,                 // all member rows considered (active + soft-deleted)
 *     duplicateActiveMembers,     // active member rows for (tenant, lower(email))
 *     source                      // 'tenant_membership' | 'identity_id' | 'email' | null
 *   }
 */
export async function resolveMemberForTenantLogin({
  supabase = defaultSupabase,
  identityId = null,
  email = null,
  tenantId = null,
} = {}) {
  if (!supabase) {
    return { member: null, candidates: [], duplicateActiveMembers: [], source: null };
  }

  const lowerEmail = email ? email.toLowerCase() : null;
  const candidates = [];
  let resolved = null;
  let source = null;

  // 1) Via tenant_membership.member_id for this identity in this tenant
  if (identityId && tenantId) {
    const { data: memberships } = await supabase
      .from('tenant_membership')
      .select('member_id')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .not('member_id', 'is', null);

    const memberIds = (memberships || []).map((m) => m.member_id).filter(Boolean);
    if (memberIds.length) {
      const { data: rows } = await supabase
        .from('member')
        .select('*')
        .in('id', memberIds);
      (rows || []).forEach((r) => candidates.push(r));
      const valid = pickFirstValid(rows || []);
      if (valid) {
        resolved = valid;
        source = 'tenant_membership';
      }
    }
  }

  // 2) Via member.identity_id + tenant_id
  if (!resolved && identityId && tenantId) {
    const { data: rows } = await supabase
      .from('member')
      .select('*')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId);
    (rows || []).forEach((r) => {
      if (!candidates.some((c) => c.id === r.id)) candidates.push(r);
    });
    const valid = pickFirstValid(rows || []);
    if (valid) {
      resolved = valid;
      source = 'identity_id';
    }
  }

  // 3) Via lower(email) + tenant_id
  if (!resolved && lowerEmail && tenantId) {
    const { data: rows } = await supabase
      .from('member')
      .select('*')
      .eq('email', lowerEmail)
      .eq('tenant_id', tenantId);
    (rows || []).forEach((r) => {
      if (!candidates.some((c) => c.id === r.id)) candidates.push(r);
    });
    const valid = pickFirstValid(rows || []);
    if (valid) {
      resolved = valid;
      source = 'email';
    }
  }

  // 4) No tenant context – fall back to identity_id then email (single)
  if (!resolved && !tenantId) {
    if (identityId) {
      const { data: rows } = await supabase
        .from('member')
        .select('*')
        .eq('identity_id', identityId);
      (rows || []).forEach((r) => {
        if (!candidates.some((c) => c.id === r.id)) candidates.push(r);
      });
      const valid = pickFirstValid(rows || []);
      if (valid) {
        resolved = valid;
        source = 'identity_id';
      }
    }
    if (!resolved && lowerEmail) {
      const { data: rows } = await supabase
        .from('member')
        .select('*')
        .eq('email', lowerEmail);
      (rows || []).forEach((r) => {
        if (!candidates.some((c) => c.id === r.id)) candidates.push(r);
      });
      const valid = pickFirstValid(rows || []);
      if (valid) {
        resolved = valid;
        source = 'email';
      }
    }
  }

  // Detect duplicate active member rows for (tenant_id, lower(email)).
  // This is what surfaces the "more than one member row for the same email
  // in the same tenant" warning in the admin UI.
  let duplicateActiveMembers = [];
  if (lowerEmail && tenantId) {
    const { data: rows } = await supabase
      .from('member')
      .select('id, email, login_enabled, identity_id, organization_id, created_on')
      .eq('email', lowerEmail)
      .eq('tenant_id', tenantId);
    duplicateActiveMembers = (rows || []).filter((r) => !isMemberSoftDeleted(r));
  }

  return {
    member: resolved,
    candidates,
    duplicateActiveMembers,
    source,
  };
}

/**
 * Compute whether a resolved member can log in right now, and if not, why.
 *
 * `member` should be the row returned from `resolveMemberForTenantLogin`.
 *
 * Optional `extra` lets callers attach context (duplicate detection, locked
 * credentials info, missing tenant membership) without re-querying.
 *
 * Returns { canLogin, reason, message, duplicateActiveMembers }
 *   reason ∈ 'no_member' | 'soft_deleted' | 'login_disabled'
 *          | 'guest_expired' | 'account_locked' | 'tenant_mismatch'
 *          | 'no_membership' | null
 */
export function computeEffectiveLoginStatus(member, extra = {}) {
  const {
    duplicateActiveMembers = [],
    tenantMismatch = false,
    accountLocked = false,
    lockedUntil = null,
    hasTenantMembership = true,
  } = extra;

  if (!member) {
    return {
      canLogin: false,
      reason: 'no_member',
      message: 'No member record found for this account.',
      duplicateActiveMembers,
    };
  }

  if (isMemberSoftDeleted(member)) {
    return {
      canLogin: false,
      reason: 'soft_deleted',
      message: 'This member record has been deleted.',
      duplicateActiveMembers,
    };
  }

  if (tenantMismatch) {
    return {
      canLogin: false,
      reason: 'tenant_mismatch',
      message: 'This account does not have access to this portal.',
      duplicateActiveMembers,
    };
  }

  // NOTE: hasTenantMembership=false is reported as a *warning* (see
  // getEffectiveLoginStatusForMember which surfaces it via warnings), not
  // as a blocking reason — api/auth/login.js does not actually require a
  // tenant_membership row (it falls back to identity_id+tenant and
  // email+tenant), so blocking here would let admin and login disagree.

  if (member.is_guest && member.guest_expires_at) {
    const expiresAt = new Date(member.guest_expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
      return {
        canLogin: false,
        reason: 'guest_expired',
        message: 'Guest access expired.',
        guestExpiresAt: member.guest_expires_at,
        duplicateActiveMembers,
      };
    }
  }

  if (accountLocked) {
    return {
      canLogin: false,
      reason: 'account_locked',
      message: 'Account temporarily locked due to failed login attempts.',
      lockedUntil,
      duplicateActiveMembers,
    };
  }

  if (member.login_enabled === false) {
    return {
      canLogin: false,
      reason: 'login_disabled',
      message: 'Login is disabled for this account.',
      duplicateActiveMembers,
    };
  }

  return {
    canLogin: true,
    reason: null,
    message: null,
    duplicateActiveMembers,
  };
}

/**
 * Resolve account-lock state using the same credential-source precedence as
 * api/auth/login.js:
 *   1. tenant_membership_credentials for (identity, tenant)
 *   2. tenant_identity (shared)
 *   3. legacy member_credentials (by member_id or email)
 *
 * Returns { accountLocked, lockedUntil } reflecting whichever credential
 * source the login flow would actually use.
 */
export async function resolveAccountLockState({
  supabase = defaultSupabase,
  identityId = null,
  tenantId = null,
  memberId = null,
  email = null,
} = {}) {
  if (!supabase) return { accountLocked: false, lockedUntil: null };
  const now = Date.now();
  const isLocked = (until) => {
    if (!until) return false;
    const t = new Date(until).getTime();
    return Number.isFinite(t) && t > now;
  };

  if (identityId && tenantId) {
    const { data: tc } = await supabase
      .from('tenant_membership_credentials')
      .select('locked_until, password_hash')
      .eq('identity_id', identityId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (tc?.password_hash) {
      return { accountLocked: isLocked(tc.locked_until), lockedUntil: tc.locked_until || null };
    }
  }

  if (identityId) {
    const { data: ti } = await supabase
      .from('tenant_identity')
      .select('locked_until, password_hash')
      .eq('id', identityId)
      .maybeSingle();
    if (ti?.password_hash) {
      return { accountLocked: isLocked(ti.locked_until), lockedUntil: ti.locked_until || null };
    }
  }

  if (memberId) {
    const { data: mc } = await supabase
      .from('member_credentials')
      .select('locked_until, password_hash')
      .eq('member_id', memberId)
      .maybeSingle();
    if (mc) {
      return { accountLocked: isLocked(mc.locked_until), lockedUntil: mc.locked_until || null };
    }
  }
  if (email) {
    const { data: mc } = await supabase
      .from('member_credentials')
      .select('locked_until, password_hash')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (mc) {
      return { accountLocked: isLocked(mc.locked_until), lockedUntil: mc.locked_until || null };
    }
  }

  return { accountLocked: false, lockedUntil: null };
}

/**
 * Convenience helper for admin UIs: given a member row from the database,
 * resolve what the auth flow would actually see for that member's tenant
 * and return the effective login status. Mirrors api/auth/login.js:
 *
 *   1. Resolves the *same* member row login would pick (skipping
 *      soft-deleted candidates).
 *   2. Detects tenant_mismatch when the resolved member doesn't belong to
 *      the tenant context the admin is asking about.
 *   3. Detects no_membership when there's no tenant_membership row for
 *      (identity, tenant) at all.
 *   4. Detects account_locked from the same credential source the login
 *      flow would use (tenant_membership_credentials → tenant_identity →
 *      legacy member_credentials).
 *
 * `tenantContext` may be passed to evaluate the status as if logging into
 * a specific portal/tenant (defaults to the member's own tenant).
 */
export async function getEffectiveLoginStatusForMember(member, {
  supabase = defaultSupabase,
  tenantContext = null,
} = {}) {
  if (!member) {
    return computeEffectiveLoginStatus(null);
  }

  // Determine tenant for this member (direct or via organization)
  let memberTenantId = member.tenant_id || null;
  if (!memberTenantId && member.organization_id && supabase) {
    const { data: org } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .maybeSingle();
    memberTenantId = org?.tenant_id || null;
  }

  const tenantId = tenantContext || memberTenantId;

  // What would auth actually resolve for (identity_id|email, tenantId)?
  const resolution = await resolveMemberForTenantLogin({
    supabase,
    identityId: member.identity_id || null,
    email: member.email || null,
    tenantId,
  });

  let authMember = resolution.member;
  let resolutionSource = resolution.source;

  // Legacy parity with api/auth/login.js: when there's no identity-based
  // resolution, login falls back to `member_credentials.email ->
  // credentials.member_id`. Mirror that here so admin and login agree
  // even on legacy accounts.
  if (!authMember && supabase && member.email) {
    const { data: legacyCred } = await supabase
      .from('member_credentials')
      .select('member_id')
      .eq('email', String(member.email).toLowerCase())
      .maybeSingle();
    if (legacyCred?.member_id) {
      const { data: legacyMember } = await supabase
        .from('member')
        .select('*')
        .eq('id', legacyCred.member_id)
        .maybeSingle();
      if (legacyMember && !isMemberSoftDeleted(legacyMember)) {
        authMember = legacyMember;
        resolutionSource = 'member_credentials';
      }
    }
  }

  // Compute tenant_mismatch: viewing this member from a tenant context
  // they don't belong to.
  let tenantMismatch = false;
  if (tenantContext && memberTenantId && memberTenantId !== tenantContext) {
    tenantMismatch = true;
  }

  // Compute hasTenantMembership: is there any tenant_membership row for
  // this identity in the tenant the auth flow would target?
  let hasTenantMembership = true;
  if (supabase && tenantId && (member.identity_id || authMember?.identity_id)) {
    const idForLookup = member.identity_id || authMember?.identity_id;
    const { data: tm } = await supabase
      .from('tenant_membership')
      .select('id')
      .eq('identity_id', idForLookup)
      .eq('tenant_id', tenantId)
      .limit(1);
    hasTenantMembership = (tm || []).length > 0;
  }

  // Compute account-lock state from the same credential source the login
  // flow would use.
  const { accountLocked, lockedUntil } = await resolveAccountLockState({
    supabase,
    identityId: member.identity_id || authMember?.identity_id || null,
    tenantId,
    memberId: authMember?.id || member.id,
    email: member.email || authMember?.email,
  });

  const status = computeEffectiveLoginStatus(authMember, {
    duplicateActiveMembers: resolution.duplicateActiveMembers,
    tenantMismatch,
    hasTenantMembership,
    accountLocked,
    lockedUntil,
  });

  // Non-blocking warnings the admin UI can surface separately. These do
  // not gate canLogin (so they cannot disagree with the real login flow),
  // but help an admin see latent data-quality issues.
  const warnings = [];
  if (!hasTenantMembership) warnings.push('no_tenant_membership');
  if (resolution.duplicateActiveMembers.length > 1) warnings.push('duplicate_active_members');
  if (authMember && authMember.id !== member.id) warnings.push('auth_resolves_different_member');

  return {
    ...status,
    resolvedMemberId: authMember?.id || null,
    viewedMemberId: member.id,
    resolutionSource,
    mismatch: !!authMember && authMember.id !== member.id,
    hasTenantMembership,
    warnings,
    tenantId: tenantId || null,
  };
}

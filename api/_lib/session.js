import { parse, serialize } from 'cookie';
import crypto from 'crypto';
import cookieSignature from 'cookie-signature';
import { supabase } from './database.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

const SESSION_COOKIE_NAME = 'iconnect.sid';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function signSessionId(sessionId) {
  return 's:' + cookieSignature.sign(sessionId, SESSION_SECRET);
}

function unsignSessionId(signedValue) {
  if (!signedValue) return null;
  
  // Handle signed format: s:sessionId.signature
  if (signedValue.startsWith('s:')) {
    const val = signedValue.slice(2); // Remove 's:' prefix
    const unsigned = cookieSignature.unsign(val, SESSION_SECRET);
    return unsigned || null;
  }
  
  // Fallback for unsigned (shouldn't happen in production)
  return signedValue;
}

export async function getSession(req) {
  if (!supabase) {
    console.log('[Session] getSession: No supabase client');
    return null;
  }
  
  const cookies = parse(req.headers.cookie || '');
  const signedSessionId = cookies[SESSION_COOKIE_NAME];
  
  if (!signedSessionId) {
    console.log('[Session] getSession: No session cookie found');
    return null;
  }
  
  // Unsign the session ID
  const sessionId = unsignSessionId(signedSessionId);
  if (!sessionId) {
    console.log('[Session] Invalid session signature for:', signedSessionId.substring(0, 20));
    return null;
  }
  
  console.log('[Session] getSession: Looking up session:', sessionId.substring(0, 8));
  
  try {
    const { data, error } = await supabase
      .from('session')
      .select('sess, expire')
      .eq('sid', sessionId)
      .single();
    
    if (error) {
      console.log('[Session] getSession: Database error:', error.message);
      return null;
    }
    
    if (!data) {
      console.log('[Session] getSession: Session not found in database');
      return null;
    }
    
    // Check if session expired
    if (new Date(data.expire) < new Date()) {
      console.log('[Session] getSession: Session expired');
      await supabase.from('session').delete().eq('sid', sessionId);
      return null;
    }
    
    const sessData = typeof data.sess === 'string' ? JSON.parse(data.sess) : data.sess;
    
    console.log('[Session] getSession: Session found, userType:', sessData?.userType);
    
    return {
      id: sessionId,
      data: sessData
    };
  } catch (err) {
    console.error('[Session] getSession error:', err);
    return null;
  }
}

// Production cookie domain for cross-subdomain session sharing
const PRODUCTION_COOKIE_DOMAIN = '.iconn.app';

export async function createSession(res, sessionData, options = {}) {
  if (!supabase) return null;
  
  const sessionId = generateSessionId();
  const expire = new Date(Date.now() + SESSION_MAX_AGE);
  const { cookieDomain, replaceSessionId } = options;
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Always use .iconn.app domain in production for cross-subdomain cookies
  const effectiveDomain = cookieDomain || (isProduction ? PRODUCTION_COOKIE_DOMAIN : undefined);
  
  // If replacing an existing session, delete it first (database only, not cookie)
  if (replaceSessionId) {
    try {
      await supabase.from('session').delete().eq('sid', replaceSessionId);
      console.log('[Session] Deleted old session:', replaceSessionId.substring(0, 8));
    } catch (err) {
      console.error('[Session] Error deleting old session:', err);
    }
  }
  
  // Build session object in Express/connect-pg-simple compatible format
  // Spread sessionData to support both member and tenant_user sessions
  const sessObject = {
    cookie: {
      originalMaxAge: SESSION_MAX_AGE,
      expires: expire.toISOString(),
      secure: isProduction,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      domain: effectiveDomain
    },
    ...sessionData
  };
  
  try {
    const { error: insertError } = await supabase.from('session').insert({
      sid: sessionId,
      sess: sessObject,
      expire: expire.toISOString()
    });
    
    if (insertError) {
      console.error('[Session] createSession: Database insert failed:', insertError.message);
      return null;
    }
    
    console.log('[Session] createSession: Session inserted into database:', sessionId.substring(0, 8));
    
    // Sign the cookie value like Express does
    const signedId = signSessionId(sessionId);
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE / 1000 // maxAge in seconds for cookie
    };
    
    // Critical: Set domain for cross-subdomain cookie sharing in production
    if (effectiveDomain) {
      cookieOptions.domain = effectiveDomain;
    }
    
    const cookie = serialize(SESSION_COOKIE_NAME, signedId, cookieOptions);
    
    console.log('[Session] Created session with domain:', effectiveDomain || 'default');
    res.setHeader('Set-Cookie', cookie);
    
    return { id: sessionId, data: sessionData };
  } catch (err) {
    console.error('Error creating session:', err);
    return null;
  }
}

export async function updateSession(sessionId, sessionData) {
  if (!supabase || !sessionId) return false;
  
  try {
    const expire = new Date(Date.now() + SESSION_MAX_AGE);
    
    // Get existing session to preserve cookie metadata
    const { data: existing } = await supabase
      .from('session')
      .select('sess')
      .eq('sid', sessionId)
      .single();
    
    const existingSess = existing?.sess ? 
      (typeof existing.sess === 'string' ? JSON.parse(existing.sess) : existing.sess) : 
      {};
    
    const sessObject = {
      cookie: existingSess.cookie || {
        originalMaxAge: SESSION_MAX_AGE,
        expires: expire.toISOString(),
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        path: '/',
        sameSite: 'lax'
      },
      ...sessionData
    };
    
    // Update cookie expiry
    sessObject.cookie.expires = expire.toISOString();
    
    await supabase
      .from('session')
      .update({
        sess: sessObject,
        expire: expire.toISOString()
      })
      .eq('sid', sessionId);
    
    return true;
  } catch (err) {
    console.error('Error updating session:', err);
    return false;
  }
}

export async function destroySession(req, res, options = {}) {
  if (!supabase) return;
  
  const cookies = parse(req.headers.cookie || '');
  const signedSessionId = cookies[SESSION_COOKIE_NAME];
  
  // Unsign the session ID
  const sessionId = unsignSessionId(signedSessionId);
  
  if (sessionId) {
    try {
      await supabase.from('session').delete().eq('sid', sessionId);
    } catch (err) {
      console.error('Error destroying session:', err);
    }
  }
  
  // Clear the cookie - must use same domain as was used to set it for cross-subdomain cookies
  const { cookieDomain } = options;
  const isProduction = process.env.NODE_ENV === 'production';
  const domain = cookieDomain || (isProduction ? PRODUCTION_COOKIE_DOMAIN : undefined);
  
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  };
  
  if (domain) {
    cookieOptions.domain = domain;
  }
  
  const cookie = serialize(SESSION_COOKIE_NAME, '', cookieOptions);
  
  res.setHeader('Set-Cookie', cookie);
}

/**
 * Try to promote a member session to tenant_user access.
 * This is called when a user logged in via portal SSO tries to access the admin dashboard.
 * If the user's identity has owner/admin membership for the tenant, we grant access.
 * 
 * @param {object} session - The current session object with id and data
 * @param {object} req - The request object (for hostname-based tenant resolution)
 * @returns {Promise<object|null>} - The tenant_user object if promotion succeeds, null otherwise
 */
async function tryPromoteMemberToTenantUser(session, req) {
  if (!supabase || !session?.data?.identityId) {
    return null;
  }
  
  const identityId = session.data.identityId;
  
  // Get the tenant context - try multiple sources in order of priority
  let targetTenantId = session.data.tenantId;
  
  // If no tenantId in session, try to get it from the request hostname
  if (!targetTenantId && req) {
    try {
      const { resolveTenantFromRequest } = await import('./tenantResolver.js');
      const tenantFromHost = await resolveTenantFromRequest(req);
      if (tenantFromHost) {
        targetTenantId = tenantFromHost.id;
      }
    } catch (err) {
      // Tenant resolver may not be available
    }
  }
  
  // If still no tenantId, try to get it from the member's organization
  if (!targetTenantId && session.data.memberId) {
    const { data: member } = await supabase
      .from('member')
      .select('organization:organization_id(tenant_id)')
      .eq('id', session.data.memberId)
      .single();
    
    targetTenantId = member?.organization?.tenant_id;
  }
  
  if (!targetTenantId) {
    console.log('[Session] Cannot promote member session - no tenant context');
    return null;
  }
  
  try {
    // Primary approach: Look up tenant_user directly by identity_id and tenant_id
    // This is the most reliable method as it doesn't depend on tenant_membership schema
    let tenantUser = null;
    
    const { data: directTenantUser } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('identity_id', identityId)
      .eq('tenant_id', targetTenantId)
      .single();
    
    if (directTenantUser) {
      tenantUser = directTenantUser;
      console.log('[Session] Found tenant_user via identity_id lookup:', tenantUser.id);
    }
    
    // Fallback: Check tenant_membership table if direct lookup fails
    // This supports the newer membership-based access model
    if (!tenantUser) {
      try {
        const { data: membership } = await supabase
          .from('tenant_membership')
          .select('*, tenant_user:tenant_user_id(*)')
          .eq('identity_id', identityId)
          .eq('tenant_id', targetTenantId)
          .eq('membership_type', 'owner')
          .single();
        
        if (membership?.tenant_user) {
          tenantUser = membership.tenant_user;
          console.log('[Session] Found tenant_user via membership lookup');
        } else if (membership?.tenant_user_id) {
          const { data } = await supabase
            .from('tenant_user')
            .select('*, tenant:tenant_id(*)')
            .eq('id', membership.tenant_user_id)
            .single();
          tenantUser = data;
        }
      } catch (membershipErr) {
        // tenant_membership table may not have required columns yet
        console.log('[Session] Membership lookup skipped (table may need migration)');
      }
    }
    
    if (!tenantUser) {
      console.log('[Session] No tenant_user record found for identity promotion');
      return null;
    }
    
    if (tenantUser.status !== 'active') {
      console.log('[Session] Tenant user inactive, cannot promote:', tenantUser.id);
      return null;
    }
    
    // Upgrade the session to full tenant_user access
    // Change userType so all downstream admin guards pass
    const upgradedSessionData = {
      ...session.data,
      userType: 'tenant_user', // Critical: change userType so subsequent API calls pass
      tenantUserId: tenantUser.id,
      tenantId: targetTenantId,
      // Preserve original member info for potential back-navigation
      originalUserType: session.data.userType,
      promotedFromMember: true
    };
    
    await updateSession(session.id, upgradedSessionData);
    
    console.log('[Session] Successfully promoted member session to include tenant_user access:', {
      identityId,
      tenantUserId: tenantUser.id,
      tenantId: targetTenantId
    });
    
    // Attach session metadata
    tenantUser._sessionTenantId = targetTenantId;
    tenantUser._sessionIdentityId = identityId;
    
    // Fetch tenant data if not included
    if (!tenantUser.tenant) {
      const { data: tenant } = await supabase
        .from('tenant')
        .select('*')
        .eq('id', targetTenantId)
        .single();
      tenantUser.tenant = tenant;
    }
    
    return tenantUser;
  } catch (err) {
    console.error('[Session] Error promoting member session:', err);
    return null;
  }
}

export async function getSessionMember(req) {
  const session = await getSession(req);
  
  if (!session?.data?.memberId) {
    return null;
  }
  
  if (!supabase) return null;
  
  try {
    const { data: member, error } = await supabase
      .from('member')
      .select('*')
      .eq('id', session.data.memberId)
      .single();
    
    // If member doesn't exist at all (hard deleted), clean up the stale session
    if (error || !member) {
      console.log('[Session] Member not found in database, cleaning up stale session:', session.data.memberId);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    // Security check: Reject authentication for disabled or deleted members
    // This ensures immediate logout when admin disables login or deletes member
    if (member.login_enabled === false) {
      console.log('[Session] Member login disabled, rejecting session:', member.id);
      // Delete the session to force logout
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    // Check if member is deleted (anonymized email pattern)
    if (member.email?.startsWith('deleted_') && member.email?.endsWith('@deleted.local')) {
      console.log('[Session] Member is deleted, rejecting session:', member.id);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    return member;
  } catch (err) {
    console.error('Error getting session member:', err);
    return null;
  }
}

export async function getSessionTenantUser(req) {
  const session = await getSession(req);
  
  console.log('[Session] getSessionTenantUser called, session data:', JSON.stringify({
    hasSession: !!session,
    sessionId: session?.id?.substring(0, 8),
    userType: session?.data?.userType,
    tenantUserId: session?.data?.tenantUserId,
    preservedTenantUserId: session?.data?.preservedTenantUserId,
    memberId: session?.data?.memberId,
    identityId: session?.data?.identityId,
    tenantId: session?.data?.tenantId
  }));
  
  // Standard tenant_user session check
  // Also handle legacy sessions where userType may be undefined but tenantUserId exists
  const isTenantUserSession = session?.data?.tenantUserId && 
    (session.data.userType === 'tenant_user' || session.data.userType === undefined);
  
  if (isTenantUserSession) {
    console.log('[Session] Found tenant_user session, continuing with normal handling');
    // Continue with normal tenant_user session handling below
  } else if (session?.data?.preservedTenantUserId && session.data.userType === 'member') {
    // Session has preserved admin context from portal SSO - restore it
    console.log('[Session] Found member session with preserved admin context, restoring tenant_user access');
    
    const restoredSessionData = {
      ...session.data,
      tenantUserId: session.data.preservedTenantUserId,
      tenantUserEmail: session.data.preservedTenantUserEmail,
      identityId: session.data.preservedIdentityId,
      tenantId: session.data.preservedTenantId,
      userType: 'tenant_user',
      // Keep member context for potential return to portal
      preservedMemberId: session.data.memberId,
      preservedMemberEmail: session.data.memberEmail,
      preservedMemberType: 'member'
    };
    
    // Remove the preservedTenantUser fields since we're restoring
    delete restoredSessionData.preservedTenantUserId;
    delete restoredSessionData.preservedTenantUserEmail;
    delete restoredSessionData.preservedIdentityId;
    delete restoredSessionData.preservedTenantId;
    delete restoredSessionData.preservedTenantUserType;
    
    await updateSession(session.id, restoredSessionData);
    console.log('[Session] Restored admin context from preserved session');
    
    // Now continue with normal tenant_user handling using the restored tenantUserId
    session.data = restoredSessionData;
  } else if (session?.data?.identityId && session.data.userType === 'member') {
    console.log('[Session] Found member session with identityId, attempting promotion');
    // Member session - check if this identity is also a tenant owner
    // and can be promoted to tenant_user access
    const promotedUser = await tryPromoteMemberToTenantUser(session, req);
    if (promotedUser) {
      console.log('[Session] Member session promoted successfully');
      return promotedUser;
    }
    console.log('[Session] Member session promotion failed');
    return null;
  } else {
    console.log('[Session] No valid session for tenant_user access, userType:', session?.data?.userType);
    return null;
  }
  
  // SECURITY: Reject sessions without tenantId to prevent tenant isolation bypass
  // This ensures pre-patch sessions that lack tenantId cannot access APIs
  if (!session.data.tenantId) {
    console.warn('[Session] SECURITY: Tenant user session missing tenantId, forcing re-authentication:', session.data.tenantUserId);
    if (supabase) {
      await supabase.from('session').delete().eq('sid', session.id);
    }
    return null;
  }
  
  if (!supabase) return null;
  
  try {
    // First, try unified identity system (tenant_identity + tenant_membership)
    // Check if the tenantUserId is an identity ID by looking it up in tenant_identity
    if (session.data.identityId || session.data.membershipId) {
      const identityId = session.data.identityId || session.data.tenantUserId;
      
      const { data: identity, error: identityError } = await supabase
        .from('tenant_identity')
        .select('*')
        .eq('id', identityId)
        .single();
      
      if (identity) {
        // Found in unified identity system - verify membership
        const { data: membership, error: membershipError } = await supabase
          .from('tenant_membership')
          .select('*, tenant:tenant_id(*)')
          .eq('identity_id', identity.id)
          .eq('tenant_id', session.data.tenantId)
          .eq('status', 'active')
          .single();
        
        if (membership && !membershipError) {
          console.log('[Session] Verified via unified identity system:', identity.email);
          
          // Return a tenant user-like object for API compatibility
          const unifiedUser = {
            id: identity.id,
            email: identity.email,
            first_name: identity.first_name,
            last_name: identity.last_name,
            role: membership.role || 'owner',
            status: 'active',
            tenant_id: session.data.tenantId,
            tenant: membership.tenant,
            _sessionTenantId: session.data.tenantId,
            _sessionIdentityId: identity.id,
            _isUnifiedIdentity: true
          };
          
          return unifiedUser;
        } else {
          console.log('[Session] Unified identity membership not found or inactive for tenant:', session.data.tenantId);
        }
      }
    }
    
    // Fallback: Verify the user in legacy tenant_user table
    const { data: tenantUser, error } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('id', session.data.tenantUserId)
      .eq('tenant_id', session.data.tenantId) // SECURITY: Verify tenant match
      .single();
    
    if (error || !tenantUser) {
      console.log('[Session] Tenant user not found in database or tenant mismatch, cleaning up stale session:', session.data.tenantUserId);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    if (tenantUser.status !== 'active') {
      console.log('[Session] Tenant user inactive, rejecting session:', tenantUser.id);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    // Attach session metadata to the tenant user for downstream use
    tenantUser._sessionTenantId = session.data.tenantId;
    tenantUser._sessionIdentityId = session.data.identityId;
    
    return tenantUser;
  } catch (err) {
    console.error('Error getting session tenant user:', err);
    return null;
  }
}

/**
 * Invalidate all sessions for a specific member.
 * Call this when a member is deleted or their login_enabled is set to false.
 * Uses direct JSONB query for reliability instead of fetching and filtering in JS.
 * @param {string} memberId - The member ID to invalidate sessions for
 * @returns {Promise<{success: boolean, count: number}>}
 */
export async function invalidateMemberSessions(memberId) {
  if (!supabase || !memberId) {
    console.log('[Session] invalidateMemberSessions called with invalid params:', { supabase: !!supabase, memberId });
    return { success: false, count: 0 };
  }
  
  try {
    console.log('[Session] Attempting to invalidate sessions for member:', memberId);
    
    // First, count how many sessions exist for this member using JSONB query
    // Supabase filter on JSONB: sess->memberId equals the member ID
    const { data: matchingSessions, error: countError } = await supabase
      .from('session')
      .select('sid')
      .filter('sess->>memberId', 'eq', memberId);
    
    if (countError) {
      console.error('[Session] Error counting sessions with JSONB filter:', countError);
      // Fallback: try the old method
      return await invalidateMemberSessionsFallback(memberId);
    }
    
    const count = matchingSessions?.length || 0;
    console.log(`[Session] Found ${count} session(s) for member ${memberId} using JSONB filter`);
    
    if (count === 0) {
      // Double-check by fetching all sessions and logging what's there
      const { data: allSessions } = await supabase
        .from('session')
        .select('sid, sess')
        .limit(10);
      
      console.log('[Session] Sample of all sessions in table:', 
        allSessions?.map(s => ({
          sid: s.sid?.substring(0, 8) + '...',
          memberId: (typeof s.sess === 'string' ? JSON.parse(s.sess) : s.sess)?.memberId
        }))
      );
      
      return { success: true, count: 0 };
    }
    
    // Delete sessions using the same JSONB filter
    const { error: deleteError } = await supabase
      .from('session')
      .delete()
      .filter('sess->>memberId', 'eq', memberId);
    
    if (deleteError) {
      console.error('[Session] Error deleting sessions with JSONB filter:', deleteError);
      return { success: false, count: 0 };
    }
    
    console.log(`[Session] Successfully invalidated ${count} session(s) for member:`, memberId);
    return { success: true, count };
  } catch (err) {
    console.error('[Session] Error invalidating member sessions:', err);
    return { success: false, count: 0 };
  }
}

/**
 * Fallback method using JS filtering if JSONB filter doesn't work
 */
async function invalidateMemberSessionsFallback(memberId) {
  console.log('[Session] Using fallback method for session invalidation');
  
  try {
    const { data: sessions, error: fetchError } = await supabase
      .from('session')
      .select('sid, sess');
    
    if (fetchError) {
      console.error('[Session] Fallback: Error fetching sessions:', fetchError);
      return { success: false, count: 0 };
    }
    
    console.log(`[Session] Fallback: Fetched ${sessions?.length || 0} total sessions`);
    
    // Filter sessions that belong to this member
    const memberSessions = (sessions || []).filter(s => {
      const sessData = typeof s.sess === 'string' ? JSON.parse(s.sess) : s.sess;
      const matches = sessData?.memberId === memberId;
      if (matches) {
        console.log('[Session] Fallback: Found matching session:', s.sid?.substring(0, 8) + '...');
      }
      return matches;
    });
    
    if (memberSessions.length === 0) {
      console.log('[Session] Fallback: No sessions found for member:', memberId);
      // Log what memberIds are in the sessions for debugging
      const allMemberIds = (sessions || []).map(s => {
        const sessData = typeof s.sess === 'string' ? JSON.parse(s.sess) : s.sess;
        return sessData?.memberId;
      }).filter(Boolean);
      console.log('[Session] Fallback: MemberIds in sessions:', [...new Set(allMemberIds)]);
      return { success: true, count: 0 };
    }
    
    const sessionIds = memberSessions.map(s => s.sid);
    const { error: deleteError } = await supabase
      .from('session')
      .delete()
      .in('sid', sessionIds);
    
    if (deleteError) {
      console.error('[Session] Fallback: Error deleting sessions:', deleteError);
      return { success: false, count: 0 };
    }
    
    console.log(`[Session] Fallback: Invalidated ${sessionIds.length} session(s) for member:`, memberId);
    return { success: true, count: sessionIds.length };
  } catch (err) {
    console.error('[Session] Fallback: Error:', err);
    return { success: false, count: 0 };
  }
}

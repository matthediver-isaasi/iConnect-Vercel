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
  if (!supabase) return null;
  
  const cookies = parse(req.headers.cookie || '');
  const signedSessionId = cookies[SESSION_COOKIE_NAME];
  
  if (!signedSessionId) return null;
  
  // Unsign the session ID
  const sessionId = unsignSessionId(signedSessionId);
  if (!sessionId) {
    console.log('[Session] Invalid session signature');
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('session')
      .select('sess, expire')
      .eq('sid', sessionId)
      .single();
    
    if (error || !data) return null;
    
    // Check if session expired
    if (new Date(data.expire) < new Date()) {
      await supabase.from('session').delete().eq('sid', sessionId);
      return null;
    }
    
    const sessData = typeof data.sess === 'string' ? JSON.parse(data.sess) : data.sess;
    
    return {
      id: sessionId,
      data: sessData
    };
  } catch (err) {
    console.error('Error getting session:', err);
    return null;
  }
}

export async function createSession(res, sessionData, options = {}) {
  if (!supabase) return null;
  
  const sessionId = generateSessionId();
  const expire = new Date(Date.now() + SESSION_MAX_AGE);
  const { cookieDomain } = options;
  
  // Build session object in Express/connect-pg-simple compatible format
  // Spread sessionData to support both member and tenant_user sessions
  const sessObject = {
    cookie: {
      originalMaxAge: SESSION_MAX_AGE,
      expires: expire.toISOString(),
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      domain: cookieDomain || undefined
    },
    ...sessionData
  };
  
  try {
    await supabase.from('session').insert({
      sid: sessionId,
      sess: sessObject,
      expire: expire.toISOString()
    });
    
    // Sign the cookie value like Express does
    const signedId = signSessionId(sessionId);
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE / 1000 // maxAge in seconds for cookie
    };
    
    if (cookieDomain) {
      cookieOptions.domain = cookieDomain;
    }
    
    const cookie = serialize(SESSION_COOKIE_NAME, signedId, cookieOptions);
    
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

export async function destroySession(req, res) {
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
  
  // Clear the cookie
  const cookie = serialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  
  res.setHeader('Set-Cookie', cookie);
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
  
  if (!session?.data?.tenantUserId || session.data.userType !== 'tenant_user') {
    return null;
  }
  
  if (!supabase) return null;
  
  try {
    const { data: tenantUser, error } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('id', session.data.tenantUserId)
      .single();
    
    if (error || !tenantUser) {
      console.log('[Session] Tenant user not found in database, cleaning up stale session:', session.data.tenantUserId);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
    if (tenantUser.status !== 'active') {
      console.log('[Session] Tenant user inactive, rejecting session:', tenantUser.id);
      await supabase.from('session').delete().eq('sid', session.id);
      return null;
    }
    
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

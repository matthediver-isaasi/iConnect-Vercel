import { parse } from 'cookie';
import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse cookies to see what's being sent
    const cookies = parse(req.headers.cookie || '');
    const sessionCookie = cookies['iconnect.sid'];
    
    // Manually unsign to get the session ID
    let rawSessionId = null;
    if (sessionCookie && sessionCookie.startsWith('s:')) {
      const parts = sessionCookie.slice(2).split('.');
      rawSessionId = parts[0]; // Get the session ID without signature
    }
    
    // Check if this session exists in the database directly
    let dbSessionCheck = null;
    if (rawSessionId && supabase) {
      const { data, error } = await supabase
        .from('session')
        .select('sid, expire')
        .eq('sid', rawSessionId)
        .single();
      
      dbSessionCheck = {
        found: !!data,
        error: error?.message || null,
        expire: data?.expire || null
      };
    }
    
    // Also count total sessions
    let totalSessions = null;
    if (supabase) {
      const { count } = await supabase
        .from('session')
        .select('*', { count: 'exact', head: true });
      totalSessions = count;
    }
    
    const session = await getSession(req);
    const tenantFromHost = await resolveTenantFromRequest(req);
    
    const debug = {
      timestamp: new Date().toISOString(),
      host: req.headers.host || req.headers['x-forwarded-host'],
      nodeEnv: process.env.NODE_ENV,
      hasCookieHeader: !!req.headers.cookie,
      cookieNames: Object.keys(cookies),
      hasSessionCookie: !!sessionCookie,
      sessionCookiePreview: sessionCookie ? sessionCookie.substring(0, 30) + '...' : null,
      rawSessionIdPreview: rawSessionId ? rawSessionId.substring(0, 8) + '...' : null,
      dbSessionCheck,
      totalSessionsInDb: totalSessions,
      tenantFromHost: tenantFromHost ? { id: tenantFromHost.id, slug: tenantFromHost.slug } : null,
      session: session ? {
        id: session.id?.substring(0, 8) + '...',
        userType: session.data?.userType,
        memberId: session.data?.memberId,
        identityId: session.data?.identityId,
        tenantId: session.data?.tenantId,
        tenantUserId: session.data?.tenantUserId
      } : null
    };

    // If we have a memberId but no identityId, check why
    if (session?.data?.memberId && !session?.data?.identityId) {
      const { data: member } = await supabase
        .from('member')
        .select('id, email, identity_id, google_id')
        .eq('id', session.data.memberId)
        .single();
      
      debug.memberData = member ? {
        id: member.id,
        email: member.email,
        identity_id: member.identity_id,
        has_google_id: !!member.google_id
      } : null;

      // Check if tenant_identity exists for this email
      if (member?.email) {
        const { data: identity } = await supabase
          .from('tenant_identity')
          .select('id, email')
          .eq('email', member.email.toLowerCase())
          .single();
        
        debug.identityByEmail = identity ? { id: identity.id, email: identity.email } : null;
      }
    }

    // If we have an identityId, check tenant_membership
    if (session?.data?.identityId) {
      const targetTenantId = session.data.tenantId || tenantFromHost?.id;
      
      if (targetTenantId) {
        const { data: membership, error } = await supabase
          .from('tenant_membership')
          .select('id, membership_type, tenant_user_id, status')
          .eq('identity_id', session.data.identityId)
          .eq('tenant_id', targetTenantId)
          .eq('membership_type', 'owner')
          .single();
        
        debug.ownerMembership = membership || null;
        debug.ownerMembershipError = error?.message || null;
        
        // Also check for tenant_user directly
        const { data: tenantUser } = await supabase
          .from('tenant_user')
          .select('id, email, status, identity_id')
          .eq('identity_id', session.data.identityId)
          .eq('tenant_id', targetTenantId)
          .single();
        
        debug.tenantUserByIdentity = tenantUser ? {
          id: tenantUser.id,
          email: tenantUser.email,
          status: tenantUser.status
        } : null;
      }
    }

    res.json(debug);
  } catch (error) {
    console.error('[Session Debug] Error:', error);
    res.status(500).json({ error: error.message });
  }
}

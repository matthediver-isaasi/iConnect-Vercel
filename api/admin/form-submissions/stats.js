import { createClient } from '@supabase/supabase-js';

let supabase = null;

function getSupabaseClient() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

async function verifyPermission(cookies, permissionId) {
  try {
    const db = getSupabaseClient();
    
    const sessionId = cookies?.['connect.sid'];
    if (!sessionId) {
      return { hasPermission: false, memberId: null, error: 'Not authenticated' };
    }

    const cleanSessionId = sessionId.startsWith('s:') 
      ? sessionId.slice(2).split('.')[0] 
      : sessionId.split('.')[0];

    const { data: sessions, error: sessionError } = await db
      .from('session')
      .select('sess')
      .eq('sid', cleanSessionId);

    if (sessionError || !sessions || sessions.length === 0) {
      return { hasPermission: false, memberId: null, error: 'Session not found' };
    }

    const sessionData = sessions[0].sess;
    const memberEmail = sessionData?.memberEmail;
    if (!memberEmail) {
      return { hasPermission: false, memberId: null, error: 'No member email in session' };
    }

    const { data: member, error: memberError } = await db
      .from('member')
      .select('id, role_id, login_enabled')
      .eq('email', memberEmail)
      .single();

    if (memberError || !member) {
      return { hasPermission: false, memberId: null, error: 'Member not found' };
    }

    if (!member.login_enabled) {
      return { hasPermission: false, memberId: member.id, error: 'Login disabled' };
    }

    if (!member.role_id) {
      return { hasPermission: false, memberId: member.id };
    }

    const { data: role, error: roleError } = await db
      .from('role')
      .select('excluded_features')
      .eq('id', member.role_id)
      .single();

    if (roleError || !role) {
      return { hasPermission: false, memberId: member.id };
    }

    const excludedFeatures = role.excluded_features || [];
    const hasPermission = !excludedFeatures.includes(permissionId);

    return { hasPermission, memberId: member.id };
  } catch (error) {
    console.error('[Permission Verify] Error:', error);
    return { hasPermission: false, memberId: null, error: 'Verification failed' };
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      cookies[name.trim()] = rest.join('=').trim();
    });
  }
  return cookies;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const cookies = parseCookies(req.headers.cookie);
    const result = await verifyPermission(cookies, 'page_FormSubmissions');

    if (result.error) {
      return res.status(401).json({ error: result.error });
    }

    if (!result.hasPermission) {
      return res.status(403).json({ error: 'Access to form submissions required' });
    }

    const db = getSupabaseClient();

    const { count: totalCount, error: totalError } = await db
      .from('form_submission')
      .select('id', { count: 'exact', head: true });

    if (totalError) {
      console.error('[FormSubmissionStats] Error getting total count:', totalError);
      return res.status(500).json({ error: 'Failed to get submission count' });
    }

    const { count: newCount, error: newError } = await db
      .from('form_submission')
      .select('id', { count: 'exact', head: true })
      .or('status.eq.new,status.is.null');

    if (newError) {
      console.error('[FormSubmissionStats] Error getting new count:', newError);
      return res.status(500).json({ error: 'Failed to get new submission count' });
    }

    return res.json({ 
      total: totalCount || 0, 
      new: newCount || 0 
    });
  } catch (error) {
    console.error('[Admin Form Submission Stats] Error:', error);
    return res.status(500).json({ error: 'Failed to get form submission stats' });
  }
}

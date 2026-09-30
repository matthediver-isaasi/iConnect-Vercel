import { supabase } from './database.js';

const PLATFORM_SESSION_COOKIE = 'platform_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateSecureToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPlatformOwnerSession(res, ownerId) {
  if (!supabase) return null;

  const sessionToken = generateSecureToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // Store session in database
  const { data: session, error: sessionError } = await supabase
    .from('platform_owner_session')
    .insert({
      owner_id: ownerId,
      session_token: sessionToken,
      expires_at: expiresAt.toISOString()
    })
    .select()
    .single();

  if (sessionError) {
    console.error('[Platform Session] Failed to create session:', sessionError);
    return null;
  }

  // Update last login
  await supabase
    .from('platform_owner')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', ownerId);

  // Set secure cookie with only the token (not the owner ID)
  const isSecure = process.env.NODE_ENV === 'production';
  const cookieOptions = [
    `${PLATFORM_SESSION_COOKIE}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`
  ];
  if (isSecure) cookieOptions.push('Secure');
  
  res.setHeader('Set-Cookie', cookieOptions.join('; '));
  
  return { sessionId: session.id, ownerId };
}

export async function getSessionPlatformOwner(req) {
  if (!supabase) return null;

  const cookies = req.headers.cookie || '';
  const sessionCookie = cookies.split(';').find(c => c.trim().startsWith(`${PLATFORM_SESSION_COOKIE}=`));
  
  if (!sessionCookie) return null;

  const [, sessionToken] = sessionCookie.split('=');
  if (!sessionToken || sessionToken.length < 32) return null;

  // Validate session in database
  const { data: session, error: sessionError } = await supabase
    .from('platform_owner_session')
    .select('id, owner_id, expires_at')
    .eq('session_token', sessionToken.trim())
    .single();

  if (sessionError || !session) return null;

  // Check if session is expired
  if (new Date(session.expires_at) < new Date()) {
    // Clean up expired session
    await supabase.from('platform_owner_session').delete().eq('id', session.id);
    return null;
  }

  // Get owner details
  const { data: owner, error: ownerError } = await supabase
    .from('platform_owner')
    .select('id, email, name, is_active')
    .eq('id', session.owner_id)
    .eq('is_active', true)
    .single();

  if (ownerError || !owner) return null;

  return owner;
}

export async function clearPlatformOwnerSession(req, res) {
  // Get token from cookie to delete session from DB
  const cookies = req.headers.cookie || '';
  const sessionCookie = cookies.split(';').find(c => c.trim().startsWith(`${PLATFORM_SESSION_COOKIE}=`));
  
  if (sessionCookie && supabase) {
    const [, sessionToken] = sessionCookie.split('=');
    if (sessionToken) {
      await supabase.from('platform_owner_session').delete().eq('session_token', sessionToken.trim());
    }
  }

  res.setHeader('Set-Cookie', `${PLATFORM_SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

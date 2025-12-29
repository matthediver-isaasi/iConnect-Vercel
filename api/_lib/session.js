import { createClient } from '@supabase/supabase-js';
import { parse, serialize } from 'cookie';
import crypto from 'crypto';
import cookieSignature from 'cookie-signature';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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

export async function createSession(res, sessionData) {
  if (!supabase) return null;
  
  const sessionId = generateSessionId();
  const expire = new Date(Date.now() + SESSION_MAX_AGE);
  
  // Build session object in Express/connect-pg-simple compatible format
  const sessObject = {
    cookie: {
      originalMaxAge: SESSION_MAX_AGE,
      expires: expire.toISOString(),
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      path: '/',
      sameSite: 'lax'
    },
    memberId: sessionData.memberId,
    memberEmail: sessionData.memberEmail
  };
  
  try {
    await supabase.from('session').insert({
      sid: sessionId,
      sess: sessObject,
      expire: expire.toISOString()
    });
    
    // Sign the cookie value like Express does
    const signedId = signSessionId(sessionId);
    const cookie = serialize(SESSION_COOKIE_NAME, signedId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE / 1000 // maxAge in seconds for cookie
    });
    
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
    
    if (error || !member) return null;
    
    return member;
  } catch (err) {
    console.error('Error getting session member:', err);
    return null;
  }
}

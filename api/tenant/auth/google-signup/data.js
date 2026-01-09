import crypto from 'crypto';
import { parse, serialize } from 'cookie';

const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

function verifySignedData(signedData) {
  try {
    const decoded = JSON.parse(Buffer.from(signedData, 'base64url').toString());
    const { data, signature } = decoded;
    const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }
    
    const payload = JSON.parse(data);
    
    if (Date.now() - payload.timestamp > 10 * 60 * 1000) {
      return null;
    }
    
    return payload;
  } catch (err) {
    return null;
  }
}

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

  const cookies = parse(req.headers.cookie || '');
  const signedData = cookies['google_signup_data'];

  if (!signedData) {
    return res.status(404).json({ error: 'No Google signup data found' });
  }

  const googleData = verifySignedData(signedData);

  if (!googleData) {
    return res.status(400).json({ error: 'Invalid or expired Google signup data' });
  }

  const clearCookie = serialize('google_signup_data', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  res.setHeader('Set-Cookie', clearCookie);

  return res.status(200).json({
    googleId: googleData.googleId,
    email: googleData.email,
    firstName: googleData.firstName,
    lastName: googleData.lastName
  });
}

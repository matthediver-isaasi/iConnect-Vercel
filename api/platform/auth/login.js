import { supabase } from '../../_lib/database.js';
import { createPlatformOwnerSession } from '../../_lib/platformSession.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data: owner, error } = await supabase
      .from('platform_owner')
      .select('id, email, name, password_hash, is_active')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !owner) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!owner.is_active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    const passwordValid = await bcrypt.compare(password, owner.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await createPlatformOwnerSession(res, owner.id);

    return res.status(200).json({
      success: true,
      owner: {
        id: owner.id,
        email: owner.email,
        name: owner.name
      }
    });

  } catch (error) {
    console.error('[Platform Login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

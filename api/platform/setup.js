import { supabase } from '../_lib/database.js';
import { createPlatformOwnerSession } from '../_lib/platformSession.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleCheckSetupAvailable(req, res);
  }
  
  if (req.method === 'POST') {
    return handleCreateFirstOwner(req, res);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleCheckSetupAvailable(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { count, error } = await supabase
      .from('platform_owner')
      .select('id', { count: 'exact', head: true });

    if (error) {
      console.error('[Platform Setup] Error checking owners:', error);
      return res.status(500).json({ error: 'Failed to check setup status' });
    }

    const setupAvailable = count === 0;
    return res.status(200).json({ setupAvailable });
  } catch (error) {
    console.error('[Platform Setup] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleCreateFirstOwner(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: insertResult, error: rpcError } = await supabase.rpc('create_first_platform_owner', {
      p_name: name.trim(),
      p_email: email.toLowerCase().trim(),
      p_password_hash: passwordHash
    });

    if (rpcError) {
      console.error('[Platform Setup] RPC error:', rpcError);
      if (rpcError.message?.includes('already exists')) {
        return res.status(403).json({ 
          error: 'Setup is no longer available. A platform owner already exists.' 
        });
      }
      if (rpcError.code === '23505') {
        return res.status(400).json({ error: 'An account with this email already exists' });
      }
      return res.status(500).json({ error: 'Failed to create account' });
    }

    if (!insertResult || insertResult.owner_id === null) {
      return res.status(403).json({ 
        error: 'Setup is no longer available. A platform owner already exists.' 
      });
    }

    const ownerId = insertResult.owner_id;

    const { data: owner, error: fetchError } = await supabase
      .from('platform_owner')
      .select('id, email, name')
      .eq('id', ownerId)
      .single();

    if (fetchError || !owner) {
      console.error('[Platform Setup] Error fetching created owner:', fetchError);
      return res.status(500).json({ error: 'Account created but failed to retrieve details' });
    }

    await createPlatformOwnerSession(res, owner.id);

    return res.status(201).json({
      success: true,
      message: 'Platform owner account created successfully',
      owner: {
        id: owner.id,
        email: owner.email,
        name: owner.name
      }
    });

  } catch (error) {
    console.error('[Platform Setup] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

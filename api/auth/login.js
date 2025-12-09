import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { createSession } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const { data: credentials, error: credError } = await supabase
      .from('member_credentials')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (credError || !credentials) {
      console.log('[Auth Login] No credentials found for:', email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (credentials.locked_until && new Date(credentials.locked_until) > new Date()) {
      return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
    }

    if (!credentials.password_hash) {
      return res.status(401).json({ 
        success: false, 
        error: 'Password not set', 
        needsPasswordSetup: true,
        memberId: credentials.member_id 
      });
    }

    const isValid = await bcrypt.compare(password, credentials.password_hash);
    
    if (!isValid) {
      const newFailedAttempts = (credentials.failed_attempts || 0) + 1;
      const updates = { failed_attempts: newFailedAttempts };
      
      if (newFailedAttempts >= 5) {
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      
      await supabase
        .from('member_credentials')
        .update(updates)
        .eq('id', credentials.id);
      
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    await supabase
      .from('member_credentials')
      .update({ 
        failed_attempts: 0, 
        locked_until: null,
        last_login: new Date().toISOString() 
      })
      .eq('id', credentials.id);

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .eq('id', credentials.member_id)
      .single();

    if (memberError || !member) {
      return res.status(401).json({ success: false, error: 'Member not found' });
    }

    if (!member.role_id) {
      const { data: allRoles } = await supabase.from('role').select('*');
      
      // Check for role segmentation
      const { data: segmentationSettings } = await supabase
        .from('system_settings')
        .select('*')
        .eq('key', 'role_segmentation_field_id')
        .single();
      
      let defaultRole = null;
      const segmentationFieldId = segmentationSettings?.value;
      
      if (segmentationFieldId && member.organization_id) {
        // Get the organization's segment value
        const { data: orgPrefValue } = await supabase
          .from('organization_preference_value')
          .select('value')
          .eq('organization_id', member.organization_id)
          .eq('field_id', segmentationFieldId)
          .single();
        
        const orgSegmentValue = orgPrefValue?.value;
        
        if (orgSegmentValue) {
          // Find a default role that matches this segment value
          defaultRole = allRoles?.find((r) => 
            r.is_default === true && 
            r.segment_values && 
            Array.isArray(r.segment_values) && 
            r.segment_values.includes(orgSegmentValue)
          );
        }
      }
      
      // Fallback to any default role or a role named 'Member' if no segmented match
      if (!defaultRole) {
        const memberRole = allRoles?.find((r) => r.name === 'Member');
        const anyDefaultRole = allRoles?.find((r) => r.is_default === true);
        defaultRole = memberRole || anyDefaultRole;
      }
      
      if (defaultRole) {
        await supabase
          .from('member')
          .update({ role_id: defaultRole.id })
          .eq('id', member.id);
        member.role_id = defaultRole.id;
      }
    }

    // Create PostgreSQL-backed session
    await createSession(res, {
      memberId: member.id,
      memberEmail: member.email
    });

    console.log('[Auth Login] Success for:', email);
    
    res.json({ 
      success: true, 
      member,
      isTemporaryPassword: credentials.is_temp_password 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}

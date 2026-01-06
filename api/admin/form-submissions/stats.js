import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const roleId = sessionMember.role_id;
    
    if (!roleId) {
      return res.status(403).json({ error: 'No role assigned' });
    }

    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();

    if (roleError || !role) {
      return res.status(403).json({ error: 'Role not found' });
    }

    const excludedFeatures = role.excluded_features || [];
    if (excludedFeatures.includes('page_FormSubmissions')) {
      return res.status(403).json({ error: 'Access to form submissions required' });
    }

    const { count: totalCount, error: totalError } = await supabase
      .from('form_submission')
      .select('id', { count: 'exact', head: true });

    if (totalError) {
      console.error('[FormSubmissionStats] Error getting total count:', totalError);
      return res.status(500).json({ error: 'Failed to get submission count' });
    }

    const { count: newCount, error: newError } = await supabase
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

import { createClient } from '@supabase/supabase-js';
import { getSession } from '../../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const { 
      mode = 'preview',
      excludeOrganizationIds = [],
      excludeRoleIds = [],
      identifier = 'email'
    } = req.body;
    
    const validExcludeOrgIds = Array.isArray(excludeOrganizationIds) 
      ? excludeOrganizationIds.filter(isValidUUID)
      : [];
    const validExcludeRoleIds = Array.isArray(excludeRoleIds)
      ? excludeRoleIds.filter(isValidUUID)
      : [];
    
    console.log(`[Dedupe] Mode: ${mode}, Exclude orgs: ${validExcludeOrgIds.length}, Exclude roles: ${validExcludeRoleIds.length}`);
    
    if (!['preview', 'execute'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Use "preview" or "execute"' });
    }
    
    // Try to use database functions first (much faster)
    // Pass IDs as text array to avoid UUID type mismatch
    if (mode === 'preview') {
      const { data, error } = await supabase.rpc('preview_duplicate_members', {
        exclude_org_ids: validExcludeOrgIds.map(id => String(id)),
        exclude_role_ids: validExcludeRoleIds.map(id => String(id)),
        max_groups: 100
      });
      
      if (!error && data) {
        console.log('[Dedupe] Preview via RPC successful');
        // Transform the response to match expected format
        const groups = (data.groups || []).map(g => ({
          email: g.email,
          keeper: g.members?.find(m => m.is_keeper),
          duplicates: g.members?.filter(m => !m.is_keeper) || []
        }));
        
        return res.json({
          success: true,
          mode: 'preview',
          summary: {
            totalDuplicateEmails: data.summary?.total_duplicate_emails || 0,
            totalKeepers: data.summary?.total_keepers || 0,
            totalToDelete: data.summary?.total_to_delete || 0
          },
          groups,
          note: data.summary?.total_duplicate_emails > 100 
            ? `Showing first 100 of ${data.summary.total_duplicate_emails} duplicate groups` 
            : undefined
        });
      }
      
      console.log('[Dedupe] RPC preview failed, falling back to JS:', error?.message);
    }
    
    if (mode === 'execute') {
      // Log the exact parameters being sent
      const rpcParams = {
        exclude_org_ids: validExcludeOrgIds.map(id => String(id)),
        exclude_role_ids: validExcludeRoleIds.map(id => String(id))
      };
      console.log('[Dedupe] Calling RPC with params:', JSON.stringify(rpcParams));
      
      const { data, error } = await supabase.rpc('execute_duplicate_members', rpcParams);
      
      if (!error && data) {
        console.log('[Dedupe] Execute via RPC successful');
        return res.json({
          success: true,
          mode: 'execute',
          deleted: data.deleted || 0,
          summary: {
            totalDuplicateEmails: data.summary?.totalDuplicateEmails || 0,
            totalDeleted: data.deleted || 0
          }
        });
      }
      
      console.log('[Dedupe] RPC execute failed:', error?.message, 'Code:', error?.code, 'Details:', error?.details);
      
      // For execute mode, we MUST use the database function - JS fallback will timeout
      return res.status(500).json({
        error: 'Database function failed. Please ensure the SQL functions are installed in Supabase.',
        details: error?.message,
        hint: 'Run the contents of supabase/functions/dedupe_members.sql in Supabase SQL Editor'
      });
    }
    
    // Preview mode can use JS fallback for smaller datasets
    if (mode === 'preview') {
      console.log('[Dedupe] Preview RPC failed, trying JS fallback...');
      
      // Fetch a sample of members for preview
      const { data: sampleMembers, error: fetchError } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, role_id, organization_id, created_on')
        .not('email', 'is', null)
        .neq('email', '')
        .limit(5000);
      
      if (fetchError) {
        return res.status(500).json({ error: 'Failed to fetch members for preview' });
      }
      
      // Filter by exclusions
      let filteredMembers = sampleMembers;
      
      if (validExcludeOrgIds.length > 0) {
        filteredMembers = filteredMembers.filter(m => 
          !m.organization_id || !validExcludeOrgIds.includes(m.organization_id)
        );
      }
      
      if (validExcludeRoleIds.length > 0) {
        filteredMembers = filteredMembers.filter(m => 
          !m.role_id || !validExcludeRoleIds.includes(m.role_id)
        );
      }
      
      // Group by email
      const emailGroups = {};
      for (const member of filteredMembers) {
        if (!member.email) continue;
        const emailLower = member.email.toLowerCase().trim();
        if (!emailLower) continue;
        if (!emailGroups[emailLower]) emailGroups[emailLower] = [];
        emailGroups[emailLower].push(member);
      }
      
      // Find duplicates
      const previewGroups = [];
      let totalDuplicates = 0;
      let totalToDelete = 0;
      
      for (const emailLower in emailGroups) {
        const members = emailGroups[emailLower];
        if (members.length <= 1) continue;
        
        totalDuplicates++;
        totalToDelete += members.length - 1;
        
        if (previewGroups.length < 100) {
          members.sort((a, b) => {
            // Prefer members WITHOUT a role (they get kept)
            const aHasRole = a.role_id ? 1 : 0;
            const bHasRole = b.role_id ? 1 : 0;
            if (aHasRole !== bHasRole) return aHasRole - bHasRole;
            const aDate = a.created_on ? new Date(a.created_on).getTime() : 0;
            const bDate = b.created_on ? new Date(b.created_on).getTime() : 0;
            if (aDate !== bDate) return aDate - bDate;
            return (a.id || '').localeCompare(b.id || '');
          });
          
          previewGroups.push({
            email: emailLower,
            keeper: members[0],
            duplicates: members.slice(1)
          });
        }
      }
      
      return res.json({
        success: true,
        mode: 'preview',
        summary: {
          totalDuplicateEmails: totalDuplicates,
          totalKeepers: totalDuplicates,
          totalToDelete: totalToDelete
        },
        groups: previewGroups,
        note: 'Preview based on sample of 5000 members. Install database function for accurate counts.'
      });
    }
    
  } catch (error) {
    console.error('[Dedupe] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to deduplicate members' });
  }
}

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
    if (mode === 'preview') {
      const { data, error } = await supabase.rpc('preview_duplicate_members', {
        exclude_org_ids: validExcludeOrgIds,
        exclude_role_ids: validExcludeRoleIds,
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
      const { data, error } = await supabase.rpc('execute_duplicate_members', {
        exclude_org_ids: validExcludeOrgIds,
        exclude_role_ids: validExcludeRoleIds
      });
      
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
      
      console.log('[Dedupe] RPC execute failed, falling back to JS:', error?.message);
    }
    
    // Fallback to JavaScript-based approach (slower, may timeout for large datasets)
    console.log('[Dedupe] Using JavaScript fallback...');
    
    // Fetch members in parallel batches
    const FETCH_BATCH_SIZE = 1000;
    const MAX_PARALLEL_BATCHES = 10;
    
    const { count: totalCount } = await supabase
      .from('member')
      .select('id', { count: 'exact', head: true })
      .not('email', 'is', null)
      .neq('email', '');
    
    console.log(`[Dedupe] Total members with email: ${totalCount}`);
    
    const numBatches = Math.ceil(totalCount / FETCH_BATCH_SIZE);
    let allMembers = [];
    
    for (let wave = 0; wave < numBatches; wave += MAX_PARALLEL_BATCHES) {
      const batchPromises = [];
      
      for (let i = wave; i < Math.min(wave + MAX_PARALLEL_BATCHES, numBatches); i++) {
        const offset = i * FETCH_BATCH_SIZE;
        batchPromises.push(
          supabase
            .from('member')
            .select('id, email, first_name, last_name, role_id, organization_id, created_on')
            .not('email', 'is', null)
            .neq('email', '')
            .range(offset, offset + FETCH_BATCH_SIZE - 1)
        );
      }
      
      const results = await Promise.all(batchPromises);
      
      for (const result of results) {
        if (result.error) throw new Error(`Failed to fetch: ${result.error.message}`);
        if (result.data) allMembers = allMembers.concat(result.data);
      }
    }
    
    // Filter by exclusions
    let filteredMembers = allMembers;
    
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
    
    // Find and rank duplicates
    const keepers = [];
    const toDelete = [];
    const keeperMap = new Map();
    
    for (const emailLower in emailGroups) {
      const members = emailGroups[emailLower];
      if (members.length <= 1) continue;
      
      members.sort((a, b) => {
        const aHasRole = a.role_id ? 0 : 1;
        const bHasRole = b.role_id ? 0 : 1;
        if (aHasRole !== bHasRole) return aHasRole - bHasRole;
        const aDate = a.created_on ? new Date(a.created_on).getTime() : 0;
        const bDate = b.created_on ? new Date(b.created_on).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;
        return (a.id || '').localeCompare(b.id || '');
      });
      
      keepers.push(members[0]);
      for (let i = 1; i < members.length; i++) {
        toDelete.push(members[i]);
        keeperMap.set(members[i].id, members[0].id);
      }
    }
    
    console.log(`[Dedupe] Found ${keepers.length} groups, ${toDelete.length} to delete`);
    
    if (mode === 'preview') {
      const previewGroups = [];
      let count = 0;
      for (const emailLower in emailGroups) {
        const members = emailGroups[emailLower];
        if (members.length <= 1) continue;
        if (count >= 100) break;
        
        members.sort((a, b) => {
          const aHasRole = a.role_id ? 0 : 1;
          const bHasRole = b.role_id ? 0 : 1;
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
        count++;
      }
      
      return res.json({
        success: true,
        mode: 'preview',
        summary: {
          totalDuplicateEmails: keepers.length,
          totalKeepers: keepers.length,
          totalToDelete: toDelete.length
        },
        groups: previewGroups,
        note: keepers.length > 100 ? `Showing first 100 of ${keepers.length} duplicate groups` : undefined
      });
    }
    
    // Execute mode
    if (toDelete.length === 0) {
      return res.json({
        success: true,
        mode: 'execute',
        message: 'No duplicates found',
        deleted: 0
      });
    }
    
    const idsToDelete = toDelete.map(r => r.id);
    
    // Update FK references in parallel
    const updatePromises = [];
    for (const [dupId, keeperId] of keeperMap) {
      updatePromises.push(
        supabase.from('member_note').update({ target_member_id: keeperId }).eq('target_member_id', dupId),
        supabase.from('member_note').update({ author_member_id: keeperId }).eq('author_member_id', dupId),
        supabase.from('organization_note').update({ member_id: keeperId }).eq('member_id', dupId)
      );
    }
    
    const UPDATE_BATCH = 50;
    for (let i = 0; i < updatePromises.length; i += UPDATE_BATCH) {
      await Promise.all(updatePromises.slice(i, i + UPDATE_BATCH));
    }
    
    // Delete in batches
    const DELETE_BATCH = 200;
    let deletedCount = 0;
    
    for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH) {
      const batch = idsToDelete.slice(i, i + DELETE_BATCH);
      const { error } = await supabase.from('member').delete().in('id', batch);
      if (!error) deletedCount += batch.length;
    }
    
    return res.json({
      success: true,
      mode: 'execute',
      deleted: deletedCount,
      summary: {
        totalDuplicateEmails: keepers.length,
        totalDeleted: deletedCount
      }
    });
    
  } catch (error) {
    console.error('[Dedupe] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to deduplicate members' });
  }
}

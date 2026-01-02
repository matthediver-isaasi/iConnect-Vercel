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
    
    // Step 1: Fetch all members in parallel batches for speed
    const FETCH_BATCH_SIZE = 1000;
    const MAX_PARALLEL_BATCHES = 10;
    
    // First, get total count
    const { count: totalCount, error: countError } = await supabase
      .from('member')
      .select('id', { count: 'exact', head: true })
      .not('email', 'is', null)
      .neq('email', '');
    
    if (countError) {
      throw new Error(`Failed to count members: ${countError.message}`);
    }
    
    console.log(`[Dedupe] Total members with email: ${totalCount}`);
    
    // Calculate number of batches needed
    const numBatches = Math.ceil(totalCount / FETCH_BATCH_SIZE);
    let allMembers = [];
    
    // Fetch in parallel waves
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
        if (result.error) {
          throw new Error(`Failed to fetch members: ${result.error.message}`);
        }
        if (result.data) {
          allMembers = allMembers.concat(result.data);
        }
      }
      
      console.log(`[Dedupe] Fetched ${allMembers.length} members...`);
    }
    
    console.log(`[Dedupe] Total members fetched: ${allMembers.length}`);
    
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
    
    // Group by lowercase email using object for speed
    const emailGroups = {};
    for (const member of filteredMembers) {
      if (!member.email) continue;
      const emailLower = member.email.toLowerCase().trim();
      if (!emailLower) continue;
      
      if (!emailGroups[emailLower]) {
        emailGroups[emailLower] = [];
      }
      emailGroups[emailLower].push(member);
    }
    
    // Find duplicates and rank them
    const duplicateResults = [];
    const keepers = [];
    const toDelete = [];
    const keeperMap = new Map();
    
    for (const emailLower in emailGroups) {
      const members = emailGroups[emailLower];
      if (members.length <= 1) continue;
      
      // Sort: role_id NOT NULL first, then by created_on, then by id
      members.sort((a, b) => {
        const aHasRole = a.role_id ? 0 : 1;
        const bHasRole = b.role_id ? 0 : 1;
        if (aHasRole !== bHasRole) return aHasRole - bHasRole;
        
        const aDate = a.created_on ? new Date(a.created_on).getTime() : 0;
        const bDate = b.created_on ? new Date(b.created_on).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;
        
        return (a.id || '').localeCompare(b.id || '');
      });
      
      const keeper = members[0];
      keepers.push({ ...keeper, rn: 1, is_keeper: true });
      
      for (let i = 1; i < members.length; i++) {
        const dup = { ...members[i], rn: i + 1, is_keeper: false };
        toDelete.push(dup);
        keeperMap.set(dup.id, keeper.id);
        duplicateResults.push(dup);
      }
      duplicateResults.unshift({ ...keeper, rn: 1, is_keeper: true });
    }
    
    console.log(`[Dedupe] Found ${keepers.length} duplicate email groups, ${toDelete.length} records to delete`);
    
    if (mode === 'preview') {
      // Get role and org names for display (limit to first 100 groups for preview)
      const previewGroups = [];
      let groupCount = 0;
      
      for (const emailLower in emailGroups) {
        const members = emailGroups[emailLower];
        if (members.length <= 1) continue;
        if (groupCount >= 100) break;
        
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
        groupCount++;
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
    
    // Execute mode - actually delete duplicates
    if (toDelete.length === 0) {
      return res.json({
        success: true,
        mode: 'execute',
        message: 'No duplicates found to delete',
        deleted: 0
      });
    }
    
    const idsToDelete = toDelete.map(r => r.id);
    
    // Update foreign key references in parallel batches
    console.log(`[Dedupe] Updating foreign key references for ${keeperMap.size} duplicates...`);
    
    const updatePromises = [];
    for (const [dupId, keeperId] of keeperMap) {
      updatePromises.push(
        supabase.from('member_note').update({ target_member_id: keeperId }).eq('target_member_id', dupId),
        supabase.from('member_note').update({ author_member_id: keeperId }).eq('author_member_id', dupId),
        supabase.from('organization_note').update({ member_id: keeperId }).eq('member_id', dupId)
      );
    }
    
    // Execute updates in batches to avoid overwhelming the database
    const UPDATE_BATCH_SIZE = 50;
    for (let i = 0; i < updatePromises.length; i += UPDATE_BATCH_SIZE) {
      await Promise.all(updatePromises.slice(i, i + UPDATE_BATCH_SIZE));
    }
    
    // Delete duplicates in parallel batches
    console.log(`[Dedupe] Deleting ${idsToDelete.length} duplicate members...`);
    
    const DELETE_BATCH_SIZE = 200;
    let deletedCount = 0;
    const deleteErrors = [];
    
    const deleteBatches = [];
    for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH_SIZE) {
      deleteBatches.push(idsToDelete.slice(i, i + DELETE_BATCH_SIZE));
    }
    
    // Delete in parallel waves
    const DELETE_PARALLEL = 5;
    for (let i = 0; i < deleteBatches.length; i += DELETE_PARALLEL) {
      const batchPromises = deleteBatches.slice(i, i + DELETE_PARALLEL).map(batch =>
        supabase.from('member').delete().in('id', batch)
      );
      
      const results = await Promise.all(batchPromises);
      
      results.forEach((result, idx) => {
        if (result.error) {
          deleteErrors.push({ batch: i + idx + 1, error: result.error.message });
        } else {
          deletedCount += deleteBatches[i + idx].length;
        }
      });
    }
    
    console.log(`[Dedupe] Complete: Deleted ${deletedCount} duplicates`);
    
    return res.json({
      success: true,
      mode: 'execute',
      deleted: deletedCount,
      errors: deleteErrors.length > 0 ? deleteErrors : undefined,
      summary: {
        totalDuplicateEmails: keepers.length,
        totalDeleted: deletedCount,
        totalErrors: deleteErrors.length
      }
    });
    
  } catch (error) {
    console.error('[Dedupe] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to deduplicate members' });
  }
}

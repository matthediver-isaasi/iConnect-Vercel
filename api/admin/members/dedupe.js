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
    
    // Validate and sanitize exclusion arrays - only allow valid UUIDs
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
    
    // Fetch all members using pagination to handle large datasets
    // Supabase has a default limit of 1000 rows per query
    const FETCH_BATCH_SIZE = 1000;
    let allMembers = [];
    let offset = 0;
    let hasMore = true;
    
    console.log('[Dedupe] Fetching all members...');
    
    while (hasMore) {
      const { data: batch, error: batchError } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, role_id, organization_id, created_on')
        .not('email', 'is', null)
        .neq('email', '')
        .range(offset, offset + FETCH_BATCH_SIZE - 1);
      
      if (batchError) {
        throw new Error(`Failed to fetch members: ${batchError.message}`);
      }
      
      if (batch && batch.length > 0) {
        allMembers = allMembers.concat(batch);
        offset += batch.length;
        hasMore = batch.length === FETCH_BATCH_SIZE;
        console.log(`[Dedupe] Fetched ${allMembers.length} members so far...`);
      } else {
        hasMore = false;
      }
    }
    
    console.log(`[Dedupe] Total members fetched: ${allMembers.length}`);
    
    // Filter by exclusions in JavaScript (safe approach)
    let filteredMembers = allMembers || [];
    
    if (validExcludeOrgIds.length > 0) {
      // Keep members with NULL organization_id OR organization_id not in exclusion list
      filteredMembers = filteredMembers.filter(m => 
        !m.organization_id || !validExcludeOrgIds.includes(m.organization_id)
      );
    }
    
    if (validExcludeRoleIds.length > 0) {
      // Keep members with NULL role_id OR role_id not in exclusion list
      filteredMembers = filteredMembers.filter(m => 
        !m.role_id || !validExcludeRoleIds.includes(m.role_id)
      );
    }
    
    // Group by lowercase email
    const emailGroups = new Map();
    filteredMembers.forEach(member => {
      if (!member.email) return;
      const emailLower = member.email.toLowerCase().trim();
      if (!emailLower) return;
      
      if (!emailGroups.has(emailLower)) {
        emailGroups.set(emailLower, []);
      }
      emailGroups.get(emailLower).push(member);
    });
    
    // Find duplicates and rank them
    const duplicateResults = [];
    emailGroups.forEach((members, emailLower) => {
      if (members.length > 1) {
        // Sort: role_id NOT NULL first, then by created_on, then by id
        members.sort((a, b) => {
          // role_id NOT NULL comes first
          const aHasRole = a.role_id ? 0 : 1;
          const bHasRole = b.role_id ? 0 : 1;
          if (aHasRole !== bHasRole) return aHasRole - bHasRole;
          
          // Earlier created_on comes first
          const aDate = a.created_on ? new Date(a.created_on) : new Date(0);
          const bDate = b.created_on ? new Date(b.created_on) : new Date(0);
          if (aDate.getTime() !== bDate.getTime()) return aDate.getTime() - bDate.getTime();
          
          // Finally by id
          return (a.id || '').localeCompare(b.id || '');
        });
        
        members.forEach((member, index) => {
          duplicateResults.push({
            ...member,
            rn: index + 1,
            is_keeper: index === 0
          });
        });
      }
    });
    
    // Separate keepers and duplicates to delete
    const keepers = duplicateResults.filter(r => r.is_keeper);
    const toDelete = duplicateResults.filter(r => !r.is_keeper);
    
    // Build keeper map (duplicate id -> keeper id)
    const keeperMap = new Map();
    keepers.forEach(keeper => {
      const emailLower = keeper.email.toLowerCase().trim();
      toDelete.forEach(dup => {
        if (dup.email.toLowerCase().trim() === emailLower) {
          keeperMap.set(dup.id, keeper.id);
        }
      });
    });
    
    // Get role and org names for display
    const roleIds = [...new Set(duplicateResults.filter(r => r.role_id).map(r => r.role_id))];
    const orgIds = [...new Set(duplicateResults.filter(r => r.organization_id).map(r => r.organization_id))];
    
    let roleNames = {};
    let orgNames = {};
    
    if (roleIds.length > 0) {
      const { data: roles } = await supabase
        .from('role')
        .select('id, name')
        .in('id', roleIds);
      if (roles) {
        roles.forEach(r => roleNames[r.id] = r.name);
      }
    }
    
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', orgIds);
      if (orgs) {
        orgs.forEach(o => orgNames[o.id] = o.name);
      }
    }
    
    // Enrich results with names
    const enrichedResults = duplicateResults.map(r => ({
      ...r,
      role_name: r.role_id ? roleNames[r.role_id] : null,
      organization_name: r.organization_id ? orgNames[r.organization_id] : null
    }));
    
    if (mode === 'preview') {
      // Group by email for preview display
      const grouped = {};
      enrichedResults.forEach(r => {
        const emailLower = r.email.toLowerCase().trim();
        if (!grouped[emailLower]) {
          grouped[emailLower] = { keeper: null, duplicates: [] };
        }
        if (r.is_keeper) {
          grouped[emailLower].keeper = r;
        } else {
          grouped[emailLower].duplicates.push(r);
        }
      });
      
      return res.json({
        success: true,
        mode: 'preview',
        summary: {
          totalDuplicateEmails: Object.keys(grouped).length,
          totalKeepers: keepers.length,
          totalToDelete: toDelete.length
        },
        groups: Object.entries(grouped).map(([email, data]) => ({
          email,
          keeper: data.keeper,
          duplicates: data.duplicates
        }))
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
    
    // First, update foreign key references in member_note
    console.log(`[Dedupe] Updating member_note references...`);
    
    for (const [dupId, keeperId] of keeperMap) {
      // Update target_member_id references
      const { error: targetError } = await supabase
        .from('member_note')
        .update({ target_member_id: keeperId })
        .eq('target_member_id', dupId);
      
      if (targetError) {
        console.log(`[Dedupe] Warning: Failed to update target_member_id: ${targetError.message}`);
      }
      
      // Update author_member_id references
      const { error: authorError } = await supabase
        .from('member_note')
        .update({ author_member_id: keeperId })
        .eq('author_member_id', dupId);
      
      if (authorError) {
        console.log(`[Dedupe] Warning: Failed to update author_member_id: ${authorError.message}`);
      }
    }
    
    // Update organization_note references
    console.log(`[Dedupe] Updating organization_note references...`);
    for (const [dupId, keeperId] of keeperMap) {
      const { error: orgNoteError } = await supabase
        .from('organization_note')
        .update({ member_id: keeperId })
        .eq('member_id', dupId);
      
      if (orgNoteError) {
        console.log(`[Dedupe] Warning: Failed to update organization_note: ${orgNoteError.message}`);
      }
    }
    
    // Delete duplicates in batches
    console.log(`[Dedupe] Deleting ${idsToDelete.length} duplicate members...`);
    
    const BATCH_SIZE = 100;
    let deletedCount = 0;
    let deleteErrors = [];
    
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const batch = idsToDelete.slice(i, i + BATCH_SIZE);
      
      const { error: deleteError } = await supabase
        .from('member')
        .delete()
        .in('id', batch);
      
      if (deleteError) {
        console.log(`[Dedupe] Delete batch error: ${deleteError.message}`);
        deleteErrors.push({ batch: Math.floor(i / BATCH_SIZE) + 1, error: deleteError.message });
      } else {
        deletedCount += batch.length;
      }
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

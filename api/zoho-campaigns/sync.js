import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser, getSessionMember } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { 
  isZohoCampaignsConnected, 
  addSubscriberToList, 
  removeSubscriberFromList,
  syncMemberToZohoLists 
} from '../_lib/zohoCampaignsClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = context.tenantId;
    const { categoryId, memberId, offset } = req.body;

    const tenantUser = await getSessionTenantUser(req);
    const sessionMember = await getSessionMember(req);

    if (memberId) {
      if (!tenantUser && (!sessionMember || sessionMember.id !== memberId)) {
        return res.status(403).json({ error: 'You can only sync your own preferences' });
      }
    } else {
      if (!tenantUser) {
        return res.status(403).json({ error: 'Admin access required for bulk sync' });
      }
    }

    const connected = await isZohoCampaignsConnected(tenantId);
    if (!connected) {
      return res.status(400).json({ 
        error: 'Zoho Campaigns not connected',
        message: 'Please connect Zoho Campaigns before syncing'
      });
    }

    if (memberId) {
      const result = await syncSingleMember(tenantId, memberId);
      return res.status(200).json(result);
    }

    if (categoryId) {
      const result = await syncCategory(tenantId, categoryId, offset || 0);
      return res.status(200).json(result);
    }

    const result = await syncAllCategories(tenantId);
    return res.status(200).json(result);
    
  } catch (error) {
    console.error('[ZohoCampaigns] Sync error:', error);
    return res.status(500).json({ 
      error: 'Failed to sync with Zoho Campaigns',
      details: error.message 
    });
  }
}

async function syncSingleMember(tenantId, memberId) {
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('id, email, first_name, last_name, role_id, communications_opted_out_all')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .single();

  if (memberError || !member) {
    return { success: false, error: 'Member not found' };
  }

  const { data: preferences } = await supabase
    .from('member_communication_preference')
    .select('category_id, is_subscribed')
    .eq('member_id', memberId)
    .eq('tenant_id', tenantId);

  const results = await syncMemberToZohoLists(tenantId, member, preferences || []);
  
  return { 
    success: true, 
    member: member.email,
    results 
  };
}

const BATCH_SIZE = 10;

// Basic email validation to skip invalid emails before API calls
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    console.log('[ZohoCampaigns] Skipping member - email is null or not a string:', email);
    return false;
  }
  const trimmedEmail = email.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isValid = emailRegex.test(trimmedEmail);
  if (!isValid) {
    console.log('[ZohoCampaigns] Skipping member - email failed validation:', trimmedEmail);
  }
  return isValid;
}

async function syncCategory(tenantId, categoryId, offset = 0) {
  const { data: category, error: catError } = await supabase
    .from('communication_category')
    .select('id, name, zoho_list_id')
    .eq('id', categoryId)
    .eq('tenant_id', tenantId)
    .single();

  if (catError || !category) {
    return { success: false, error: 'Category not found' };
  }

  if (!category.zoho_list_id) {
    return { success: false, error: 'Category not mapped to a Zoho list' };
  }

  const { data: categoryRoles } = await supabase
    .from('communication_category_role')
    .select('role_id')
    .eq('category_id', categoryId);

  const roleIds = categoryRoles?.map(r => r.role_id) || [];

  // First get total count
  let countQuery = supabase
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (roleIds.length > 0) {
    countQuery = countQuery.in('role_id', roleIds);
  }

  const { count: totalMembers } = await countQuery;

  // Get batch of members
  let membersQuery = supabase
    .from('member')
    .select('id, email, first_name, last_name, role_id, communications_opted_out_all')
    .eq('tenant_id', tenantId)
    .range(offset, offset + BATCH_SIZE - 1);

  if (roleIds.length > 0) {
    membersQuery = membersQuery.in('role_id', roleIds);
  }

  const { data: members, error: membersError } = await membersQuery;

  if (membersError) {
    return { success: false, error: 'Failed to fetch members' };
  }

  const { data: preferences } = await supabase
    .from('member_communication_preference')
    .select('member_id, category_id, is_subscribed')
    .eq('category_id', categoryId)
    .eq('tenant_id', tenantId);

  const results = {
    category: category.name,
    zohoListId: category.zoho_list_id,
    subscribed: 0,
    unsubscribed: 0,
    errors: 0,
    processed: 0,
    total: totalMembers || 0,
    offset: offset,
    hasMore: false,
    details: []
  };

  for (const member of members || []) {
    // Skip members with invalid emails to avoid wasting API calls
    if (!isValidEmail(member.email)) {
      results.processed++;
      results.skipped = (results.skipped || 0) + 1;
      continue;
    }

    const pref = preferences?.find(p => p.member_id === member.id);
    const isOptedOutAll = member.communications_opted_out_all === true;
    const isSubscribed = !isOptedOutAll && pref?.is_subscribed !== false;

    try {
      if (isSubscribed) {
        const result = await addSubscriberToList(tenantId, category.zoho_list_id, {
          email: member.email.trim(),
          first_name: member.first_name,
          last_name: member.last_name
        });
        if (result.success) {
          results.subscribed++;
        } else {
          results.errors++;
        }
      } else {
        const result = await removeSubscriberFromList(tenantId, category.zoho_list_id, member.email.trim());
        if (result.success) {
          results.unsubscribed++;
        } else {
          results.errors++;
        }
      }
      results.processed++;
    } catch (error) {
      results.errors++;
      results.processed++;
    }
  }

  // Calculate if there are more members to process
  const nextOffset = offset + BATCH_SIZE;
  results.hasMore = nextOffset < (totalMembers || 0);
  results.nextOffset = results.hasMore ? nextOffset : null;
  results.totalProcessed = offset + results.processed;

  return { success: true, ...results };
}

async function syncAllCategories(tenantId) {
  const { data: categories, error: catError } = await supabase
    .from('communication_category')
    .select('id, name, zoho_list_id')
    .eq('tenant_id', tenantId)
    .not('zoho_list_id', 'is', null);

  if (catError || !categories?.length) {
    return { 
      success: true, 
      message: 'No categories with Zoho list mappings found',
      categories: [] 
    };
  }

  const results = [];
  for (const category of categories) {
    const result = await syncCategory(tenantId, category.id);
    results.push(result);
  }

  return { 
    success: true,
    categories: results 
  };
}

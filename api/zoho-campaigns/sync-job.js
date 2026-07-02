import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { 
  isZohoCampaignsConnected, 
  addSubscriberToList, 
  removeSubscriberFromList 
} from '../_lib/zohoCampaignsClient.js';

const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = 10;

async function processWithConcurrency(items, processor, limit) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(processor));
    results.push(...chunkResults);
  }
  return results;
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

export default async function handler(req, res) {
  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = context.tenantId;
    const tenantUser = await getSessionTenantUser(req);
    
    if (!tenantUser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (req.method === 'POST') {
      const { action } = req.body;
      if (action === 'continue') {
        return handleContinueJob(req, res, tenantId);
      }
      return handleStartJob(req, res, tenantId);
    } else if (req.method === 'GET') {
      return handleGetJobStatus(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[ZohoCampaigns] Sync job error:', error);
    return res.status(500).json({ error: 'Failed to process sync job', details: error.message });
  }
}

async function handleStartJob(req, res, tenantId) {
  const { categoryId } = req.body;
  
  if (!categoryId) {
    return res.status(400).json({ error: 'categoryId is required' });
  }

  const connected = await isZohoCampaignsConnected(tenantId);
  if (!connected) {
    return res.status(400).json({ error: 'Zoho Campaigns not connected' });
  }

  const { data: category, error: catError } = await supabase
    .from('communication_category')
    .select('id, name, zoho_list_id')
    .eq('id', categoryId)
    .eq('tenant_id', tenantId)
    .single();

  if (catError || !category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  if (!category.zoho_list_id) {
    return res.status(400).json({ error: 'Category not mapped to a Zoho list' });
  }

  const { data: existingJob } = await supabase
    .from('zoho_sync_job')
    .select('id, status')
    .eq('tenant_id', tenantId)
    .eq('category_id', categoryId)
    .in('status', ['pending', 'running'])
    .single();

  if (existingJob) {
    return res.status(200).json({ 
      success: true,
      jobId: existingJob.id,
      resumed: true,
      message: 'Attached to existing job'
    });
  }

  const { data: categoryRoles } = await supabase
    .from('communication_category_role')
    .select('role_id')
    .eq('category_id', categoryId);

  const roleIds = categoryRoles?.map(r => r.role_id) || [];

  let countQuery = supabase
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('email', 'ilike', 'deleted_%@deleted.local');

  if (roleIds.length > 0) {
    countQuery = countQuery.in('role_id', roleIds);
  }

  const { count: totalMembers } = await countQuery;

  const { data: job, error: jobError } = await supabase
    .from('zoho_sync_job')
    .insert({
      tenant_id: tenantId,
      category_id: categoryId,
      status: 'running',
      total_members: totalMembers || 0
    })
    .select()
    .single();

  if (jobError) {
    console.error('[ZohoCampaigns] Failed to create sync job:', jobError);
    return res.status(500).json({ error: 'Failed to create sync job' });
  }

  return res.status(200).json({
    success: true,
    jobId: job.id,
    totalMembers: totalMembers || 0,
    message: 'Sync job started'
  });
}

async function handleContinueJob(req, res, tenantId) {
  const { jobId } = req.body;
  
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  const { data: job, error: jobError } = await supabase
    .from('zoho_sync_job')
    .select('*')
    .eq('id', jobId)
    .eq('tenant_id', tenantId)
    .single();

  if (jobError || !job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'running') {
    return res.status(200).json({
      id: job.id,
      status: job.status,
      currentOffset: job.current_offset,
      totalMembers: job.total_members,
      subscribed: job.subscribed,
      unsubscribed: job.unsubscribed,
      skipped: job.skipped,
      errors: job.errors,
      progress: job.total_members > 0 ? Math.round((job.current_offset / job.total_members) * 100) : 100,
      message: 'Job already completed or failed'
    });
  }

  const result = await processBatch(tenantId, job);

  return res.status(200).json(result);
}

async function handleGetJobStatus(req, res, tenantId) {
  const { jobId } = req.query;
  
  if (!jobId) {
    const { data: runningJob } = await supabase
      .from('zoho_sync_job')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (runningJob) {
      return res.status(200).json({
        id: runningJob.id,
        categoryId: runningJob.category_id,
        status: runningJob.status,
        currentOffset: runningJob.current_offset,
        totalMembers: runningJob.total_members,
        subscribed: runningJob.subscribed,
        unsubscribed: runningJob.unsubscribed,
        skipped: runningJob.skipped,
        errors: runningJob.errors,
        progress: runningJob.total_members > 0 
          ? Math.round((runningJob.current_offset / runningJob.total_members) * 100) 
          : 0,
        createdAt: runningJob.created_at,
        updatedAt: runningJob.updated_at
      });
    }
    return res.status(200).json({ status: 'none' });
  }

  const { data: job, error } = await supabase
    .from('zoho_sync_job')
    .select('*')
    .eq('id', jobId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.status(200).json({
    id: job.id,
    categoryId: job.category_id,
    status: job.status,
    currentOffset: job.current_offset,
    totalMembers: job.total_members,
    subscribed: job.subscribed,
    unsubscribed: job.unsubscribed,
    skipped: job.skipped,
    errors: job.errors,
    errorMessage: job.error_message,
    progress: job.total_members > 0 
      ? Math.round((job.current_offset / job.total_members) * 100) 
      : 0,
    createdAt: job.created_at,
    updatedAt: job.updated_at
  });
}

async function processBatch(tenantId, job) {
  try {
    const { data: category } = await supabase
      .from('communication_category')
      .select('id, name, zoho_list_id')
      .eq('id', job.category_id)
      .single();

    if (!category?.zoho_list_id) {
      await updateJobStatus(job.id, 'failed', { error_message: 'Category or Zoho list not found' });
      return { status: 'failed', error: 'Category or Zoho list not found' };
    }

    const { data: categoryRoles } = await supabase
      .from('communication_category_role')
      .select('role_id')
      .eq('category_id', job.category_id);

    const roleIds = categoryRoles?.map(r => r.role_id) || [];

    let membersQuery = supabase
      .from('member')
      .select('id, email, first_name, last_name, role_id, communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .range(job.current_offset, job.current_offset + BATCH_SIZE - 1);

    if (roleIds.length > 0) {
      membersQuery = membersQuery.in('role_id', roleIds);
    }

    const { data: members, error: membersError } = await membersQuery;

    if (membersError) {
      await updateJobStatus(job.id, 'failed', { error_message: 'Failed to fetch members' });
      return { status: 'failed', error: 'Failed to fetch members' };
    }

    if (!members || members.length === 0) {
      await updateJobStatus(job.id, 'completed');
      console.log('[ZohoCampaigns] Sync job completed:', job.id);
      return { 
        status: 'completed',
        currentOffset: job.current_offset,
        totalMembers: job.total_members,
        subscribed: job.subscribed,
        unsubscribed: job.unsubscribed,
        skipped: job.skipped,
        errors: job.errors,
        progress: 100
      };
    }

    const { data: preferences } = await supabase
      .from('member_communication_preference')
      .select('member_id, category_id, is_subscribed')
      .eq('category_id', job.category_id)
      .eq('tenant_id', tenantId);

    const validMembers = members.filter(m => isValidEmail(m.email));
    const skippedCount = members.length - validMembers.length;

    const syncResults = await processWithConcurrency(validMembers, async (member) => {
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
          return { success: result.success, action: 'subscribed' };
        } else {
          const result = await removeSubscriberFromList(tenantId, category.zoho_list_id, member.email.trim());
          return { success: result.success, action: 'unsubscribed' };
        }
      } catch (error) {
        return { success: false, action: 'error' };
      }
    }, CONCURRENCY_LIMIT);

    let subscribed = 0, unsubscribed = 0, errors = 0;
    for (const result of syncResults) {
      if (result.success) {
        if (result.action === 'subscribed') subscribed++;
        else if (result.action === 'unsubscribed') unsubscribed++;
      } else {
        errors++;
      }
    }

    const newOffset = job.current_offset + members.length;
    const isComplete = newOffset >= job.total_members;

    const updatedStats = {
      current_offset: newOffset,
      subscribed: job.subscribed + subscribed,
      unsubscribed: job.unsubscribed + unsubscribed,
      skipped: job.skipped + skippedCount,
      errors: job.errors + errors,
      status: isComplete ? 'completed' : 'running',
      updated_at: new Date().toISOString()
    };

    await supabase
      .from('zoho_sync_job')
      .update(updatedStats)
      .eq('id', job.id);

    if (isComplete) {
      console.log('[ZohoCampaigns] Sync job completed:', job.id);
    }

    return {
      id: job.id,
      status: updatedStats.status,
      currentOffset: updatedStats.current_offset,
      totalMembers: job.total_members,
      subscribed: updatedStats.subscribed,
      unsubscribed: updatedStats.unsubscribed,
      skipped: updatedStats.skipped,
      errors: updatedStats.errors,
      progress: job.total_members > 0 
        ? Math.round((updatedStats.current_offset / job.total_members) * 100) 
        : 100,
      hasMore: !isComplete
    };

  } catch (error) {
    console.error('[ZohoCampaigns] Batch processing error:', error);
    await updateJobStatus(job.id, 'failed', { error_message: error.message });
    return { status: 'failed', error: error.message };
  }
}

async function updateJobStatus(jobId, status, extra = {}) {
  await supabase
    .from('zoho_sync_job')
    .update({
      status,
      ...extra,
      updated_at: new Date().toISOString()
    })
    .eq('id', jobId);
}

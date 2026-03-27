import { supabase } from './database.js';
import { sendEmail } from './emailService.js';
import crypto from 'crypto';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
const BATCH_SIZE = 100;
const SUPABASE_PAGE_SIZE = 1000;

async function fetchAllRows(queryBuilder) {
  const allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await queryBuilder(offset, SUPABASE_PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    offset += SUPABASE_PAGE_SIZE;
  }
  return allRows;
}

export function getTenantBaseUrl(tenantSlug, requestHost = null) {
  if (requestHost && !requestHost.includes('localhost') && !requestHost.includes('127.0.0.1')) {
    return `https://${requestHost}`;
  }
  if (!tenantSlug) {
    return process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5000');
  }
  return `https://${tenantSlug}.${APP_DOMAIN}`;
}

async function enrichCampaignCounts(campaign) {
  if (!supabase || !campaign || !campaign.id) return campaign;
  if (!['sent', 'sending'].includes(campaign.status)) return campaign;

  try {
    const [sentResult, openedResult, clickedResult, deliveredResult, pendingSentResult] = await Promise.all([
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).in('status', ['sent', 'delivered', 'opened', 'clicked']),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).gt('open_count', 0),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).gt('click_count', 0),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).in('status', ['delivered', 'opened', 'clicked']),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).eq('status', 'sent')
        .not('mailgun_message_id', 'is', null)
        .lt('sent_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    ]);

    if (sentResult.error) throw sentResult.error;
    if (openedResult.error) throw openedResult.error;
    if (clickedResult.error) throw clickedResult.error;
    if (deliveredResult.error) throw deliveredResult.error;

    const liveSentCount = sentResult.count || 0;
    const liveOpenedCount = openedResult.count || 0;
    const liveClickedCount = clickedResult.count || 0;
    const liveDeliveredCount = deliveredResult.count || 0;
    const likelyDeliveredCount = (pendingSentResult.count || 0);

    const needsUpdate = campaign.sent_count !== liveSentCount ||
      campaign.opened_count !== liveOpenedCount ||
      campaign.clicked_count !== liveClickedCount ||
      campaign.delivered_count !== liveDeliveredCount;

    if (needsUpdate) {
      supabase.from('email_campaign').update({
        sent_count: liveSentCount,
        opened_count: liveOpenedCount,
        clicked_count: liveClickedCount,
        delivered_count: liveDeliveredCount
      }).eq('id', campaign.id).eq('tenant_id', campaign.tenant_id)
        .then(({ error }) => {
          if (error) console.warn('[Campaign Service] Failed to persist enriched counts for campaign', campaign.id, error.message);
        });
    }

    return {
      ...campaign,
      sent_count: liveSentCount,
      opened_count: liveOpenedCount,
      clicked_count: liveClickedCount,
      delivered_count: liveDeliveredCount,
      likely_delivered_count: likelyDeliveredCount
    };
  } catch (err) {
    console.warn('[Campaign Service] Failed to enrich campaign counts:', campaign.id, err.message);
    return campaign;
  }
}

export async function getCampaigns(tenantId, options = {}) {
  if (!supabase || !tenantId) {
    return { success: false, error: 'Database not configured or missing tenant' };
  }

  try {
    let query = supabase
      .from('email_campaign')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) throw error;

    const campaigns = data || [];
    const enriched = await Promise.all(campaigns.map(c => enrichCampaignCounts(c)));

    return { success: true, campaigns: enriched };
  } catch (err) {
    console.error('[Campaign Service] Error fetching campaigns:', err);
    return { success: false, error: err.message };
  }
}

export async function getCampaign(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data, error } = await supabase
      .from('email_campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (error) throw error;
    const enriched = await enrichCampaignCounts(data);
    return { success: true, campaign: enriched };
  } catch (err) {
    console.error('[Campaign Service] Error fetching campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function createCampaign(campaignData, tenantId, createdBy) {
  if (!supabase || !tenantId) {
    return { success: false, error: 'Database not configured or missing tenant' };
  }

  try {
    const cleanedData = { ...campaignData };
    if (cleanedData.scheduled_at === '' || cleanedData.scheduled_at === undefined) {
      cleanedData.scheduled_at = null;
    }
    if (cleanedData.email_template_id === '' || cleanedData.email_template_id === 'none') {
      cleanedData.email_template_id = null;
    }
    if (cleanedData.communication_category_id === '') {
      cleanedData.communication_category_id = null;
    }

    const { data, error } = await supabase
      .from('email_campaign')
      .insert({
        ...cleanedData,
        tenant_id: tenantId,
        created_by: createdBy,
        status: 'draft'
      })
      .select()
      .single();

    if (error) throw error;
    return { success: true, campaign: data };
  } catch (err) {
    console.error('[Campaign Service] Error creating campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function updateCampaign(campaignId, updates, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const cleanedUpdates = { ...updates };
    if (cleanedUpdates.scheduled_at === '' || cleanedUpdates.scheduled_at === undefined) {
      cleanedUpdates.scheduled_at = null;
    }
    if (cleanedUpdates.email_template_id === '' || cleanedUpdates.email_template_id === 'none') {
      cleanedUpdates.email_template_id = null;
    }
    if (cleanedUpdates.communication_category_id === '') {
      cleanedUpdates.communication_category_id = null;
    }

    const { data, error } = await supabase
      .from('email_campaign')
      .update({
        ...cleanedUpdates,
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    return { success: true, campaign: data };
  } catch (err) {
    console.error('[Campaign Service] Error updating campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function duplicateCampaign(campaignId, tenantId, createdBy) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: original, error: fetchError } = await supabase
      .from('email_campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError) throw fetchError;
    if (!original) return { success: false, error: 'Campaign not found' };

    const {
      id, created_at, updated_at, status, sent_at, scheduled_at,
      sent_count, delivered_count, opened_count, clicked_count,
      bounced_count, complained_count, unsubscribed_count,
      ...cloneFields
    } = original;

    const { data: newCampaign, error: insertError } = await supabase
      .from('email_campaign')
      .insert({
        ...cloneFields,
        name: `${original.name} (Copy)`,
        status: 'draft',
        created_by: createdBy || original.created_by,
        sent_count: 0,
        delivered_count: 0,
        opened_count: 0,
        clicked_count: 0,
        bounced_count: 0,
        complained_count: 0,
        unsubscribed_count: 0
      })
      .select()
      .single();

    if (insertError) throw insertError;
    return { success: true, campaign: newCampaign };
  } catch (err) {
    console.error('[Campaign Service] Error duplicating campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function cancelCampaign(campaignId, tenantId, cancelledBy = null) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, status, name, total_recipients')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !campaign) {
      return { success: false, error: 'Campaign not found' };
    }

    if (campaign.status !== 'sending' && campaign.status !== 'scheduled') {
      return { success: false, error: `Cannot cancel campaign with status: ${campaign.status}. Only sending or scheduled campaigns can be cancelled.` };
    }

    const cancelledAt = new Date().toISOString();
    const { data: updatedRows, error: updateError } = await supabase
      .from('email_campaign')
      .update({
        status: 'cancelled',
        cancelled_at: cancelledAt,
        cancelled_by: cancelledBy,
        updated_at: cancelledAt
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .in('status', ['sending', 'scheduled'])
      .select('id');

    if (updateError) throw updateError;

    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: `Campaign status has already changed and cannot be cancelled. Current status: ${campaign.status}` };
    }

    let cancelledRecipients = 0;
    let alreadySent = 0;

    const { count: pendingCount } = await supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['pending', 'processing']);

    if (pendingCount > 0) {
      const { error: recipientError } = await supabase
        .from('email_campaign_recipient')
        .update({ status: 'cancelled' })
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'processing']);

      if (recipientError) {
        console.error('[Campaign Service] Error cancelling pending recipients:', recipientError);
        return { success: false, error: 'Campaign status set to cancelled but failed to cancel pending recipients. Please retry or check manually.' };
      }
    }

    cancelledRecipients = pendingCount || 0;

    const { count: sentCount } = await supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['sent', 'delivered', 'opened', 'clicked']);

    alreadySent = sentCount || 0;

    console.log(`[Campaign Service] Campaign ${campaignId} (${campaign.name}) CANCELLED by ${cancelledBy || 'unknown'} — ${alreadySent} already sent, ${cancelledRecipients} cancelled`);

    return {
      success: true,
      cancelled: true,
      campaignId,
      campaignName: campaign.name,
      alreadySent,
      cancelledRecipients,
      cancelledAt
    };
  } catch (err) {
    console.error('[Campaign Service] Error cancelling campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function deleteCampaign(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const BATCH_SIZE = 200;
    let deletedTotal = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: batch, error: fetchErr } = await supabase
        .from('email_campaign_recipient')
        .select('id')
        .eq('campaign_id', campaignId)
        .limit(BATCH_SIZE);

      if (fetchErr) throw fetchErr;

      if (!batch || batch.length === 0) {
        hasMore = false;
        break;
      }

      const ids = batch.map(r => r.id);
      const { error: delErr } = await supabase
        .from('email_campaign_recipient')
        .delete()
        .in('id', ids);

      if (delErr) throw delErr;
      deletedTotal += ids.length;

      if (batch.length < BATCH_SIZE) {
        hasMore = false;
      }
    }

    if (deletedTotal > 0) {
      console.log(`[Campaign Service] Deleted ${deletedTotal} recipient records for campaign ${campaignId}`);
    }

    const { error } = await supabase
      .from('email_campaign')
      .delete()
      .eq('id', campaignId)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error('[Campaign Service] Error deleting campaign:', err);
    return { success: false, error: err.message };
  }
}

export function generateTrackingToken(campaignId, recipientId, linkIndex) {
  const data = `${campaignId}:${recipientId}:${linkIndex}`;
  return Buffer.from(data).toString('base64url');
}

export function rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug, requestHost = null) {
  if (!html) return html;

  const baseUrl = getTenantBaseUrl(tenantSlug, requestHost);
  let linkIndex = 0;

  const rewritten = html.replace(
    /<a\s+([^>]*href=["'])([^"']+)(["'][^>]*)>/gi,
    (match, prefix, url, suffix) => {
      if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) {
        return match;
      }

      if (url.includes('/email-preferences')) {
        return match;
      }

      const token = generateTrackingToken(campaignId, recipientId, linkIndex);
      const trackUrl = `${baseUrl}/api/track/click?t=${token}&url=${encodeURIComponent(url)}`;
      linkIndex++;

      return `<a ${prefix}${trackUrl}${suffix}>`;
    }
  );

  return rewritten;
}

// Helper to fetch all members with pagination (bypasses Supabase 1000 row limit)
async function fetchAllMembersPaginated(tenantId, selectFields, filters = {}) {
  const allRecords = [];
  const batchSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('member')
      .select(selectFields)
      .eq('tenant_id', tenantId)
      .not('email', 'ilike', 'deleted_%@deleted.local');

    // Apply optional filters
    if (filters.roleIds && filters.roleIds.length > 0) {
      query = query.in('role_id', filters.roleIds);
    }

    query = query.range(offset, offset + batchSize - 1);

    const { data: batch, error } = await query;

    if (error) {
      console.error('[Campaign Service] Pagination error:', error);
      break;
    }

    if (batch && batch.length > 0) {
      allRecords.push(...batch);
      offset += batch.length;
      hasMore = batch.length === batchSize;
    } else {
      hasMore = false;
    }
  }

  return allRecords;
}

const ALLOWED_SEGMENT_TYPES = new Set([
  'audience_list', 'individual_members', 'role', 'organisation', 
  'communication_category', 'form', 'member_group', 'event_attendees'
]);

function validateCampaignTargeting(campaign) {
  const audiences = campaign.target_audiences;
  const hasAudiences = Array.isArray(audiences) && audiences.length > 0;

  if (hasAudiences) {
    for (const segment of audiences) {
      if (!segment.type || !ALLOWED_SEGMENT_TYPES.has(segment.type)) {
        return { valid: false, reason: `Invalid or disallowed audience segment type: "${segment.type}". Campaigns cannot target all members.` };
      }
      if (!Array.isArray(segment.ids) || segment.ids.length === 0) {
        return { valid: false, reason: `Audience segment "${segment.type}" has no IDs configured.` };
      }
    }
    return { valid: true };
  }

  if (campaign.target_type && campaign.target_type !== 'all_members' && 
      ALLOWED_SEGMENT_TYPES.has(campaign.target_type) &&
      Array.isArray(campaign.target_ids) && campaign.target_ids.length > 0) {
    return { valid: true };
  }

  return { valid: false, reason: 'Campaign has no audience targeting configured. Please select an audience list before sending.' };
}

async function getRecipientsForSegment(targetType, targetIds, tenantId) {
  let recipients = [];

  if (!targetType) return recipients;

  if (targetType === 'communication_category' && targetIds.length > 0) {
    const { data: categoryRoles } = await supabase
      .from('communication_category_role')
      .select('role_id')
      .in('category_id', targetIds);

    const roleIds = [...new Set((categoryRoles || []).map(cr => cr.role_id))];

    if (roleIds.length > 0) {
      const members = await fetchAllMembersPaginated(
        tenantId, 
        'id, email, first_name, last_name, role_id, communications_opted_out_all',
        { roleIds }
      );

      const { data: unsubscribes } = await supabase
        .from('member_communication_preference')
        .select('member_id')
        .in('category_id', targetIds)
        .eq('is_subscribed', false);

      const unsubscribedIds = new Set((unsubscribes || []).map(u => u.member_id));

      recipients = members.filter(m => 
        m.email && 
        !unsubscribedIds.has(m.id)
      );
    }

    const allExtSubscribers = [];
    let extOffset = 0;
    const extBatchSize = 1000;
    let hasMoreExt = true;

    while (hasMoreExt) {
      const { data: extBatch } = await supabase
        .from('email_subscriber')
        .select('id, email, first_name, last_name')
        .eq('tenant_id', tenantId)
        .in('communication_category_id', targetIds)
        .eq('opted_out', false)
        .range(extOffset, extOffset + extBatchSize - 1);

      if (extBatch && extBatch.length > 0) {
        allExtSubscribers.push(...extBatch);
        extOffset += extBatch.length;
        hasMoreExt = extBatch.length === extBatchSize;
      } else {
        hasMoreExt = false;
      }
    }

    if (allExtSubscribers.length > 0) {
      const memberEmails = new Set(recipients.map(r => r.email.toLowerCase()));
      for (const sub of allExtSubscribers) {
        if (sub.email && !memberEmails.has(sub.email.toLowerCase())) {
          recipients.push({
            id: sub.id,
            member_id: null,
            email: sub.email,
            first_name: sub.first_name,
            last_name: sub.last_name
          });
        }
      }
    }
  } else if (targetType === 'member_group' && targetIds.length > 0) {
    const allAssignments = [];
    let assignmentOffset = 0;
    const assignmentBatchSize = 1000;
    let hasMoreAssignments = true;

    while (hasMoreAssignments) {
      const { data: batch } = await supabase
        .from('member_group_assignment')
        .select('member_id')
        .in('group_id', targetIds)
        .range(assignmentOffset, assignmentOffset + assignmentBatchSize - 1);

      if (batch && batch.length > 0) {
        allAssignments.push(...batch);
        assignmentOffset += batch.length;
        hasMoreAssignments = batch.length === assignmentBatchSize;
      } else {
        hasMoreAssignments = false;
      }
    }

    const memberIds = [...new Set(allAssignments.map(a => a.member_id))];

    if (memberIds.length > 0) {
      const allMembers = [];
      const idBatchSize = 500;
      
      for (let i = 0; i < memberIds.length; i += idBatchSize) {
        const idBatch = memberIds.slice(i, i + idBatchSize);
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .in('id', idBatch)
          .not('email', 'ilike', 'deleted_%@deleted.local');
        
        if (members) allMembers.push(...members);
      }

      recipients = allMembers.filter(m => m.email);
    }
  } else if (targetType === 'role' && targetIds.length > 0) {
    const members = await fetchAllMembersPaginated(
      tenantId,
      'id, email, first_name, last_name, communications_opted_out_all',
      { roleIds: targetIds }
    );

    recipients = members.filter(m => m.email);
  } else if (targetType === 'all_members') {
    const members = await fetchAllMembersPaginated(
      tenantId,
      'id, email, first_name, last_name, communications_opted_out_all'
    );

    recipients = members.filter(m => m.email);
  } else if (targetType === 'individual_members' && targetIds.length > 0) {
    const allMembers = [];
    const idBatchSize = 500;

    for (let i = 0; i < targetIds.length; i += idBatchSize) {
      const idBatch = targetIds.slice(i, i + idBatchSize);
      const { data: members } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, communications_opted_out_all')
        .eq('tenant_id', tenantId)
        .in('id', idBatch)
        .not('email', 'ilike', 'deleted_%@deleted.local');

      if (members) allMembers.push(...members);
    }

    recipients = allMembers.filter(m => m.email);
  } else if (targetType === 'form' && targetIds.length > 0) {
    const { data: forms } = await supabase
      .from('form')
      .select('id, name, communication_category_id')
      .eq('tenant_id', tenantId)
      .in('id', targetIds);

    if (forms && forms.length > 0) {
      const categoryIds = [...new Set(forms.map(f => f.communication_category_id).filter(Boolean))];
      const formIds = forms.map(f => f.id);

      if (categoryIds.length > 0) {
        const memberMap = new Map();
        const PAGE_SIZE = 1000;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const { data: subscribedPrefs, error: prefError } = await supabase
            .from('member_communication_preference')
            .select(`
              member_id,
              member!inner (
                id,
                email,
                first_name,
                last_name,
                tenant_id,
                communications_opted_out_all
              )
            `)
            .in('category_id', categoryIds)
            .eq('is_subscribed', true)
            .eq('member.tenant_id', tenantId)
            .range(offset, offset + PAGE_SIZE - 1);

          if (prefError) {
            console.error('[CampaignService] Error fetching member subscriptions:', prefError);
            break;
          }

          if (subscribedPrefs && subscribedPrefs.length > 0) {
            for (const pref of subscribedPrefs) {
              const m = pref.member;
              if (m && m.email && !memberMap.has(m.id)) {
                memberMap.set(m.id, {
                  id: m.id,
                  member_id: m.id,
                  email: m.email,
                  first_name: m.first_name,
                  last_name: m.last_name,
                  communications_opted_out_all: m.communications_opted_out_all
                });
              }
            }
          }

          hasMore = subscribedPrefs && subscribedPrefs.length === PAGE_SIZE;
          offset += PAGE_SIZE;
        }

        recipients = Array.from(memberMap.values());
      }

      const { data: subscribers } = await supabase
        .from('email_subscriber')
        .select('id, email, first_name, last_name, form_id, communication_category_id')
        .eq('tenant_id', tenantId)
        .eq('opted_out', false)
        .in('form_id', formIds);

      if (subscribers && subscribers.length > 0) {
        for (const sub of subscribers) {
          recipients.push({
            id: sub.id,
            member_id: null,
            email: sub.email,
            first_name: sub.first_name,
            last_name: sub.last_name
          });
        }
      }
    }
  } else if (targetType === 'fundraisers') {
    const campaignFilter = targetIds.includes('all') ? null : targetIds;

    let allTeamMembers = [];
    let tmOffset = 0;
    const tmBatchSize = 1000;
    let hasMoreTm = true;

    while (hasMoreTm) {
      let query = supabase
        .from('fundraising_team_member')
        .select('id, email, first_name, last_name, campaign_id')
        .eq('tenant_id', tenantId);

      if (campaignFilter && campaignFilter.length > 0) {
        query = query.in('campaign_id', campaignFilter);
      }

      const { data: batch } = await query.range(tmOffset, tmOffset + tmBatchSize - 1);

      if (batch && batch.length > 0) {
        allTeamMembers.push(...batch);
        tmOffset += batch.length;
        hasMoreTm = batch.length === tmBatchSize;
      } else {
        hasMoreTm = false;
      }
    }

    recipients = allTeamMembers
      .filter(tm => tm.email)
      .map(tm => ({
        id: tm.id,
        member_id: null,
        email: tm.email,
        first_name: tm.first_name,
        last_name: tm.last_name
      }));

  } else if (targetType === 'donors') {
    const campaignFilter = targetIds.includes('all') ? null : targetIds;

    let allDonations = [];
    let donOffset = 0;
    const donBatchSize = 1000;
    let hasMoreDon = true;

    while (hasMoreDon) {
      let query = supabase
        .from('fundraising_donation')
        .select('id, donor_name, donor_email, campaign_id')
        .eq('tenant_id', tenantId)
        .eq('payment_status', 'succeeded');

      if (campaignFilter && campaignFilter.length > 0) {
        query = query.in('campaign_id', campaignFilter);
      }

      const { data: batch } = await query.range(donOffset, donOffset + donBatchSize - 1);

      if (batch && batch.length > 0) {
        allDonations.push(...batch);
        donOffset += batch.length;
        hasMoreDon = batch.length === donBatchSize;
      } else {
        hasMoreDon = false;
      }
    }

    recipients = allDonations
      .filter(d => d.donor_email)
      .map(d => {
        const nameParts = (d.donor_name || '').split(' ');
        return {
          id: d.id,
          member_id: null,
          email: d.donor_email,
          first_name: nameParts[0] || '',
          last_name: nameParts.slice(1).join(' ') || ''
        };
      });
  } else if (targetType === 'audience_list' && targetIds.length > 0) {
    const { data: lists } = await supabase
      .from('audience_list')
      .select('id, target_audiences')
      .eq('tenant_id', tenantId)
      .in('id', targetIds);

    if (lists && lists.length > 0) {
      for (const list of lists) {
        const savedAudiences = list.target_audiences;
        if (Array.isArray(savedAudiences) && savedAudiences.length > 0) {
          for (const segment of savedAudiences) {
            if (segment.type === 'audience_list') continue;
            const segRecipients = await getRecipientsForSegment(segment.type, segment.ids || [], tenantId);
            recipients.push(...segRecipients);
          }
        }
      }
    }
  }

  return recipients;
}

export async function getTargetRecipients(campaign, tenantId, countOnly = false, detailedLists = false) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    let allRecipients = [];

    const audiences = campaign.target_audiences;
    if (Array.isArray(audiences) && audiences.length > 0) {
      for (const segment of audiences) {
        const segRecipients = await getRecipientsForSegment(segment.type, segment.ids || [], tenantId);
        allRecipients.push(...segRecipients);
      }
    } else {
      const segRecipients = await getRecipientsForSegment(campaign.target_type, campaign.target_ids || [], tenantId);
      allRecipients.push(...segRecipients);
    }

    const totalAudience = allRecipients.length;
    const rawAudienceList = detailedLists ? allRecipients.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })) : null;

    // Step 1: Remove members with global opt-out (communications_opted_out_all flag)
    const beforeGlobal = allRecipients.length;
    const globalFlagRemoved = detailedLists ? allRecipients.filter(r => r.communications_opted_out_all === true) : [];
    allRecipients = allRecipients.filter(r => r.communications_opted_out_all !== true);

    // Step 1b: Remove emails with global unsubscribe record
    const { data: globalUnsubscribes } = await supabase
      .from('email_unsubscribe')
      .select('email')
      .eq('tenant_id', tenantId)
      .eq('unsubscribe_type', 'all');

    const globalUnsubSet = new Set((globalUnsubscribes || []).map(u => u.email.toLowerCase()));
    const globalEmailRemoved = detailedLists ? allRecipients.filter(r => globalUnsubSet.has(r.email.toLowerCase())) : [];
    allRecipients = allRecipients.filter(r => !globalUnsubSet.has(r.email.toLowerCase()));
    const globalOptOuts = beforeGlobal - allRecipients.length;
    const globalOptOutList = detailedLists
      ? [...globalFlagRemoved, ...globalEmailRemoved].map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name }))
      : null;

    // Step 2: Filter by campaign's communication category (subscription category funnel)
    let categoryOptOuts = 0;
    let categoryOptOutList = detailedLists ? [] : null;
    const communicationCategoryId = campaign.communication_category_id;
    if (communicationCategoryId) {
      const beforeCategory = allRecipients.length;
      const resolveMemberId = (r) => {
        if (r.member_id === null) return null;
        return r.member_id || r.id;
      };
      const memberIds = [...new Set(allRecipients.map(resolveMemberId).filter(Boolean))];

      if (memberIds.length > 0) {
        const subscribedMemberIds = new Set();
        const PAGE_SIZE = 100;

        for (let i = 0; i < memberIds.length; i += PAGE_SIZE) {
          const batch = memberIds.slice(i, i + PAGE_SIZE);
          const { data: prefs, error: prefError } = await supabase
            .from('member_communication_preference')
            .select('member_id')
            .eq('category_id', communicationCategoryId)
            .eq('is_subscribed', true)
            .in('member_id', batch);

          if (prefError) {
            console.error(`[Campaign Service] Error fetching category subscriptions for batch ${i / PAGE_SIZE + 1}:`, prefError.message || prefError);
          }

          if (prefs && prefs.length > 0) {
            for (const p of prefs) {
              subscribedMemberIds.add(p.member_id);
            }
          }
        }

        const excludedCount = memberIds.length - subscribedMemberIds.size;
        console.log(`[Campaign Service] Category subscription filter: ${subscribedMemberIds.size} members subscribed, ${excludedCount} excluded (no record or unsubscribed) for category ${communicationCategoryId}`);

        if (detailedLists) {
          const catMemberRemoved = allRecipients.filter(r => {
            const memberId = resolveMemberId(r);
            return memberId && !subscribedMemberIds.has(memberId);
          });
          categoryOptOutList.push(...catMemberRemoved.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })));
        }

        allRecipients = allRecipients.filter(r => {
          const memberId = resolveMemberId(r);
          if (!memberId) return true;
          return subscribedMemberIds.has(memberId);
        });
      }

      // Also filter external subscribers who opted out of this category
      const { data: categoryUnsubscribes, error: catUnsubError } = await supabase
        .from('email_unsubscribe')
        .select('email')
        .eq('tenant_id', tenantId)
        .eq('unsubscribe_type', 'category')
        .eq('communication_category_id', communicationCategoryId);

      if (catUnsubError) {
        console.error('[Campaign Service] Error fetching category unsubscribes:', catUnsubError.message || catUnsubError);
      }

      if (categoryUnsubscribes && categoryUnsubscribes.length > 0) {
        const categoryUnsubSet = new Set(categoryUnsubscribes.map(u => u.email.toLowerCase()));
        if (detailedLists) {
          const catEmailRemoved = allRecipients.filter(r => categoryUnsubSet.has(r.email.toLowerCase()));
          categoryOptOutList.push(...catEmailRemoved.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })));
        }
        allRecipients = allRecipients.filter(r => !categoryUnsubSet.has(r.email.toLowerCase()));
      }
      categoryOptOuts = beforeCategory - allRecipients.length;
    }

    // Deduplicate by email
    const beforeDedup = allRecipients.length;
    const uniqueRecipients = [];
    const seenEmails = new Set();
    for (const r of allRecipients) {
      const emailLower = r.email.toLowerCase();
      if (!seenEmails.has(emailLower)) {
        seenEmails.add(emailLower);
        uniqueRecipients.push(r);
      }
    }
    const duplicatesRemoved = beforeDedup - uniqueRecipients.length;

    const stats = {
      totalAudience,
      globalOptOuts,
      categoryOptOuts,
      duplicatesRemoved,
      finalCount: uniqueRecipients.length,
    };

    if (countOnly) {
      return { success: true, count: uniqueRecipients.length, stats };
    }

    const result = { success: true, recipients: uniqueRecipients, stats };
    if (detailedLists) {
      result.detailedLists = {
        audience: rawAudienceList,
        globalOptOuts: globalOptOutList,
        categoryOptOuts: categoryOptOutList,
      };
    }
    return result;
  } catch (err) {
    console.error('[Campaign Service] Error getting recipients:', err);
    return { success: false, error: err.message };
  }
}

export async function scheduleCampaign(campaignId, tenantId, scheduledAt) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantId);
    if (!success || !campaign) {
      return { success: false, error: error || 'Campaign not found' };
    }

    if (campaign.status !== 'draft') {
      return { success: false, error: `Cannot schedule campaign with status: ${campaign.status}` };
    }

    const targetingValidation = validateCampaignTargeting(campaign);
    if (!targetingValidation.valid) {
      console.error(`[Campaign Service] BLOCKED SCHEDULE: Campaign ${campaignId} - ${targetingValidation.reason}`);
      return { success: false, error: targetingValidation.reason };
    }

    const { error: updateError } = await supabase
      .from('email_campaign')
      .update({ 
        status: 'scheduled', 
        scheduled_at: scheduledAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId);

    if (updateError) {
      throw updateError;
    }

    console.log(`[Campaign Service] Campaign ${campaignId} scheduled for ${scheduledAt.toISOString()}`);
    return { 
      success: true, 
      scheduled: true,
      scheduledAt: scheduledAt.toISOString()
    };
  } catch (err) {
    console.error('[Campaign Service] Error scheduling campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function processScheduledCampaigns() {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const now = new Date().toISOString();
    
    // Find all scheduled campaigns that are due
    const { data: dueCampaigns, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name')
      .eq('status', 'scheduled')
      .lte('scheduled_at', now);

    if (fetchError) {
      throw fetchError;
    }

    const scheduledResults = [];
    if (dueCampaigns && dueCampaigns.length > 0) {
      for (const campaign of dueCampaigns) {
        console.log(`[Campaign Service] Processing scheduled campaign: ${campaign.id} (${campaign.name})`);
        const result = await sendCampaign(campaign.id, campaign.tenant_id);
        scheduledResults.push({
          campaignId: campaign.id,
          name: campaign.name,
          ...result
        });
      }
    }

    const sendingResult = await processSendingCampaigns();

    return { 
      success: true, 
      processed: (dueCampaigns?.length || 0),
      campaigns: scheduledResults,
      sendingCampaigns: sendingResult
    };
  } catch (err) {
    console.error('[Campaign Service] Error processing scheduled campaigns:', err);
    return { success: false, error: err.message };
  }
}

export async function processSendingCampaigns() {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: sendingCampaigns, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name, updated_at')
      .eq('status', 'sending');

    if (fetchError) throw fetchError;

    if (!sendingCampaigns || sendingCampaigns.length === 0) {
      return { success: true, processed: 0, campaigns: [] };
    }

    const results = [];
    for (const sc of sendingCampaigns) {
      const { count: pendingCount } = await supabase
        .from('email_campaign_recipient')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', sc.id)
        .eq('status', 'pending');

      const { count: processingCount } = await supabase
        .from('email_campaign_recipient')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', sc.id)
        .eq('status', 'processing');

      if ((!pendingCount || pendingCount === 0) && (!processingCount || processingCount === 0)) {
        const { count: sentCount } = await supabase
          .from('email_campaign_recipient')
          .select('*', { count: 'exact', head: true })
          .eq('campaign_id', sc.id)
          .in('status', ['sent', 'delivered', 'opened', 'clicked']);

        await updateCampaign(sc.id, {
          status: 'sent',
          completed_at: new Date().toISOString(),
          sent_count: sentCount || 0
        }, sc.tenant_id);

        console.log(`[Campaign Service] Campaign ${sc.id} (${sc.name}) completed - no pending recipients`);
        results.push({ campaignId: sc.id, name: sc.name, status: 'sent', sent: sentCount || 0, remaining: 0 });
        continue;
      }

      if ((!pendingCount || pendingCount === 0) && processingCount > 0) {
        const STALE_THRESHOLD_MS = 5 * 60 * 1000;
        const lastUpdate = sc.updated_at ? new Date(sc.updated_at).getTime() : 0;
        const isStale = (Date.now() - lastUpdate) > STALE_THRESHOLD_MS;

        if (isStale) {
          console.log(`[Campaign Service] Campaign ${sc.id} (${sc.name}) has ${processingCount} stale processing recipients - resetting to pending`);
          await supabase
            .from('email_campaign_recipient')
            .update({ status: 'pending' })
            .eq('campaign_id', sc.id)
            .eq('status', 'processing');
        } else {
          console.log(`[Campaign Service] Campaign ${sc.id} (${sc.name}) has ${processingCount} processing recipients - skipping (another worker active)`);
          results.push({ campaignId: sc.id, name: sc.name, status: 'processing', processing: processingCount });
          continue;
        }
      }

      console.log(`[Campaign Service] Continuing campaign ${sc.id} (${sc.name}) - ${pendingCount} pending`);

      const campaignResult = await getCampaign(sc.id, sc.tenant_id);
      if (!campaignResult.success || !campaignResult.campaign) {
        console.error(`[Campaign Service] Could not load campaign ${sc.id}`);
        continue;
      }

      const campaign = campaignResult.campaign;

      if (campaign.status === 'cancelled') {
        console.log(`[Campaign Service] Campaign ${sc.id} (${sc.name}) was cancelled — stopping batch processing`);
        results.push({ campaignId: sc.id, name: sc.name, status: 'cancelled' });
        continue;
      }

      const { data: tenant } = await supabase
        .from('tenant')
        .select('slug')
        .eq('id', sc.tenant_id)
        .single();

      const tenantSlug = tenant?.slug || '';

      const batchResult = await sendBatch(sc.id, sc.tenant_id, campaign, tenantSlug, null);

      if (batchResult.remaining === 0) {
        const freshCampaign = await getCampaign(sc.id, sc.tenant_id);
        if (freshCampaign.campaign?.status === 'cancelled') {
          console.log(`[Campaign Service] Campaign ${sc.id} was cancelled during batch — not marking as sent`);
          results.push({ campaignId: sc.id, name: sc.name, status: 'cancelled' });
          continue;
        }
        await updateCampaign(sc.id, {
          status: 'sent',
          completed_at: new Date().toISOString(),
          sent_count: freshCampaign.campaign?.sent_count || 0
        }, sc.tenant_id);
        console.log(`[Campaign Service] Campaign ${sc.id} (${sc.name}) fully sent`);
      }

      results.push({
        campaignId: sc.id,
        name: sc.name,
        sent: batchResult.sent,
        failed: batchResult.failed,
        remaining: batchResult.remaining
      });
    }

    return { success: true, processed: sendingCampaigns.length, campaigns: results };
  } catch (err) {
    console.error('[Campaign Service] Error processing sending campaigns:', err);
    return { success: false, error: err.message };
  }
}

function parseCampaignDesign(campaign) {
  let skipFooter = false;
  let hasUnsubscribeBlock = false;
  let contentWidth = null;
  if (campaign.design_json) {
    skipFooter = true;
    try {
      const designData = typeof campaign.design_json === 'string' ? JSON.parse(campaign.design_json) : campaign.design_json;
      if (designData?.globalStyles?.contentWidth) {
        contentWidth = designData.globalStyles.contentWidth;
      }
      const checkForUnsubscribe = (blocks) => {
        if (!Array.isArray(blocks)) return false;
        for (const block of blocks) {
          if (block.type === 'unsubscribe') return true;
          if (block.children && checkForUnsubscribe(block.children)) return true;
          if (block.columns) {
            for (const col of block.columns) {
              if (checkForUnsubscribe(col.blocks)) return true;
            }
          }
        }
        return false;
      };
      if (designData?.blocks) {
        hasUnsubscribeBlock = checkForUnsubscribe(designData.blocks);
      }
    } catch (e) {}
  }
  return { skipFooter, hasUnsubscribeBlock, contentWidth };
}

async function sendToRecipient(recipient, campaign, tenantId, tenantSlug, requestHost, designInfo) {
  try {
    let html = campaign.html_content || '';
    let subject = campaign.subject || '';

    const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || '';
    html = html.replace(/\{\{recipient_name\}\}/gi, recipientName);
    html = html.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');
    html = html.replace(/\{\{last_name\}\}/gi, recipient.last_name || '');
    html = html.replace(/\{\{email\}\}/gi, recipient.email || '');
    subject = subject.replace(/\{\{recipient_name\}\}/gi, recipientName);
    subject = subject.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');

    const tenantBaseUrl = getTenantBaseUrl(tenantSlug, requestHost);
    const trackingToken = generateTrackingToken(campaign.id, recipient.id, 0);
    const preferencesUrl = `${tenantBaseUrl}/email-preferences?t=${trackingToken}`;
    const oneClickUnsubscribeUrl = `${tenantBaseUrl}/api/email-campaigns/unsubscribe?t=${trackingToken}&confirm=true`;
    const unsubscribeLink = `<a href="${preferencesUrl}" style="color: #666;">Unsubscribe</a>`;

    const hasUnsubscribePlaceholder = /\{\{unsubscribe_link\}\}/i.test(html) || /\{\{unsubscribe_url\}\}/i.test(html);

    html = html.replace(/\{\{unsubscribe_link\}\}/gi, unsubscribeLink);
    html = html.replace(/\{\{unsubscribe_url\}\}/gi, preferencesUrl);
    
    const commPreferencesLink = `<a href="${preferencesUrl}" style="color: #666;">Manage communication preferences</a>`;
    html = html.replace(/\{\{communication_preferences_link\}\}/gi, commPreferencesLink);
    html = html.replace(/\{\{communication_preferences_url\}\}/gi, preferencesUrl);

    html = rewriteLinksForTracking(html, campaign.id, recipient.id, tenantSlug, requestHost);

    if (!hasUnsubscribePlaceholder && !designInfo.hasUnsubscribeBlock) {
      html += `<p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
            <a href="${preferencesUrl}" style="color: #666;">Manage email preferences</a>
          </p>`;
    }

    const result = await sendEmail({
      to: recipient.email,
      subject: subject,
      html: html,
      from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
      tenantId: tenantId,
      skipFooter: designInfo.skipFooter,
      contentWidth: designInfo.contentWidth,
      enableTracking: true,
      unsubscribeUrl: oneClickUnsubscribeUrl,
      testMode: !!campaign.is_test_mode
    });

    if (result.success) {
      await supabase
        .from('email_campaign_recipient')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          mailgun_message_id: result.messageId ? result.messageId.replace(/^<|>$/g, '') : result.messageId
        })
        .eq('id', recipient.id)
        .eq('status', 'processing');
      return 'sent';
    } else {
      await supabase
        .from('email_campaign_recipient')
        .update({
          status: 'failed',
          error_message: result.error
        })
        .eq('id', recipient.id)
        .eq('status', 'processing');
      return 'failed';
    }
  } catch (err) {
    console.error(`[Campaign Service] Error sending to ${recipient.email}:`, err);
    await supabase
      .from('email_campaign_recipient')
      .update({
        status: 'failed',
        error_message: err.message
      })
      .eq('id', recipient.id)
      .eq('status', 'processing');
    return 'failed';
  }
}

async function claimPendingRecipients(campaignId, batchSize = BATCH_SIZE) {
  const { data: pendingIds } = await supabase
    .from('email_campaign_recipient')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('id', { ascending: true })
    .limit(batchSize);

  if (!pendingIds || pendingIds.length === 0) return [];

  const ids = pendingIds.map(r => r.id);
  const { data: claimed } = await supabase
    .from('email_campaign_recipient')
    .update({ status: 'processing' })
    .in('id', ids)
    .eq('status', 'pending')
    .select();

  return claimed || [];
}

async function sendBatch(campaignId, tenantId, campaign, tenantSlug, requestHost, batchSize = BATCH_SIZE) {
  const claimedRecipients = await claimPendingRecipients(campaignId, batchSize);

  if (claimedRecipients.length === 0) {
    return { sent: 0, failed: 0, remaining: 0 };
  }

  const { data: campaignCheck } = await supabase
    .from('email_campaign')
    .select('status')
    .eq('id', campaignId)
    .single();

  if (campaignCheck?.status === 'cancelled') {
    console.log(`[Campaign Service] Campaign ${campaignId} cancelled — releasing ${claimedRecipients.length} claimed recipients`);
    await supabase
      .from('email_campaign_recipient')
      .update({ status: 'cancelled' })
      .in('id', claimedRecipients.map(r => r.id))
      .eq('status', 'processing');
    return { sent: 0, failed: 0, remaining: 0, cancelled: true };
  }

  const designInfo = parseCampaignDesign(campaign);
  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of claimedRecipients) {
    const result = await sendToRecipient(recipient, campaign, tenantId, tenantSlug, requestHost, designInfo);
    if (result === 'sent') sentCount++;
    else failedCount++;
  }

  const { count: remainingCount } = await supabase
    .from('email_campaign_recipient')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'processing']);

  const { count: totalSentCount } = await supabase
    .from('email_campaign_recipient')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['sent', 'delivered', 'opened', 'clicked']);

  await updateCampaign(campaignId, {
    sent_count: totalSentCount || 0
  }, tenantId);

  return { sent: sentCount, failed: failedCount, remaining: remainingCount || 0 };
}

export async function sendCampaign(campaignId, tenantId, requestHost = null) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantId);
    if (!success || !campaign) {
      return { success: false, error: error || 'Campaign not found' };
    }

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return { success: false, error: `Cannot send campaign with status: ${campaign.status}` };
    }

    const { data: claimedCampaign, error: claimError } = await supabase
      .from('email_campaign')
      .update({
        status: 'sending',
        sent_at: new Date().toISOString(),
        sent_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .in('status', ['draft', 'scheduled'])
      .select()
      .single();

    if (claimError || !claimedCampaign) {
      return { success: false, error: 'Campaign is already being sent or has been sent' };
    }

    const targetingValidation = validateCampaignTargeting(campaign);
    if (!targetingValidation.valid) {
      console.error(`[Campaign Service] BLOCKED SEND: Campaign ${campaignId} - ${targetingValidation.reason}`);
      await updateCampaign(campaignId, { status: 'draft' }, tenantId).catch(() => {});
      return { success: false, error: targetingValidation.reason };
    }

    let recipientsResult;
    try {
      recipientsResult = await getTargetRecipients(campaign, tenantId);
    } catch (recipientErr) {
      await updateCampaign(campaignId, { status: 'failed' }, tenantId).catch(() => {});
      return { success: false, error: recipientErr.message || 'Failed to resolve recipients' };
    }

    if (!recipientsResult.success) {
      await updateCampaign(campaignId, { status: 'failed' }, tenantId).catch(() => {});
      return recipientsResult;
    }

    const recipients = recipientsResult.recipients;
    if (recipients.length === 0) {
      await updateCampaign(campaignId, { status: 'failed' }, tenantId).catch(() => {});
      return { success: false, error: 'No recipients found for this campaign' };
    }

    await updateCampaign(campaignId, {
      total_recipients: recipients.length
    }, tenantId);

    const recipientRecords = recipients.map(r => ({
      campaign_id: campaignId,
      member_id: r.member_id !== undefined ? r.member_id : r.id,
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      status: 'pending'
    }));

    const { error: insertError } = await supabase
      .from('email_campaign_recipient')
      .insert(recipientRecords);

    if (insertError) throw insertError;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const tenantSlug = tenant?.slug || '';

    const updatedCampaignResult = await getCampaign(campaignId, tenantId);
    const updatedCampaign = updatedCampaignResult.campaign || campaign;

    const batchResult = await sendBatch(campaignId, tenantId, updatedCampaign, tenantSlug, requestHost);

    if (batchResult.remaining === 0) {
      const finalCheck = await getCampaign(campaignId, tenantId);
      if (finalCheck.campaign?.status === 'cancelled') {
        console.log(`[Campaign Service] Campaign ${campaignId} was cancelled during send — not marking as sent`);
        return {
          success: true,
          status: 'cancelled',
          totalRecipients: recipients.length,
          sent: batchResult.sent,
          failed: batchResult.failed,
          remaining: 0
        };
      }
      await updateCampaign(campaignId, {
        status: 'sent',
        completed_at: new Date().toISOString()
      }, tenantId);

      return {
        success: true,
        status: 'sent',
        totalRecipients: recipients.length,
        sent: batchResult.sent,
        failed: batchResult.failed,
        remaining: 0
      };
    }

    return {
      success: true,
      status: 'sending',
      totalRecipients: recipients.length,
      sent: batchResult.sent,
      failed: batchResult.failed,
      remaining: batchResult.remaining
    };
  } catch (err) {
    console.error('[Campaign Service] Error sending campaign:', err);
    await updateCampaign(campaignId, { status: 'failed' }, tenantId).catch(() => {});
    return { success: false, error: err.message };
  }
}

export async function getCampaignStats(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from('email_campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (campaignError) throw campaignError;

    const [
      totalCount,
      statusSentCount,
      statusDeliveredCount,
      statusOpenedCount,
      statusClickedCount,
      statusBouncedCount,
      statusFailedCount,
      statusUnsubscribedCount,
      statusComplainedCount,
      hasOpensCount,
      hasClicksCount
    ] = await Promise.all([
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'sent').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'delivered').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'opened').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'clicked').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'bounced').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'failed').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'unsubscribed').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'complained').then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).gt('open_count', 0).then(r => { if (r.error) throw r.error; return r.count || 0; }),
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).gt('click_count', 0).then(r => { if (r.error) throw r.error; return r.count || 0; }),
    ]);

    const stats = {
      total: totalCount,
      sent: statusSentCount + statusDeliveredCount + statusOpenedCount + statusClickedCount,
      sent_only: statusSentCount,
      delivered: statusDeliveredCount + statusOpenedCount + statusClickedCount,
      opened: hasOpensCount,
      clicked: hasClicksCount,
      bounced: statusBouncedCount,
      failed: statusFailedCount,
      unsubscribed: statusUnsubscribedCount,
      complained: statusComplainedCount
    };

    stats.openRate = stats.delivered > 0 ? ((stats.opened / stats.delivered) * 100).toFixed(1) : 0;
    stats.clickRate = stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : 0;
    stats.bounceRate = stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(1) : 0;

    return { success: true, campaign, stats };
  } catch (err) {
    console.error('[Campaign Service] Error getting campaign stats:', err);
    return { success: false, error: err.message };
  }
}

export async function getClickHeatmapData(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const clicks = await fetchAllRows((offset, limit) =>
      supabase
        .from('email_link_click')
        .select('original_url, link_position, link_index, link_text')
        .eq('campaign_id', campaignId)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
    );

    const heatmapData = {};
    for (const click of clicks || []) {
      const key = click.link_index?.toString() || click.link_position || click.original_url;
      if (!heatmapData[key]) {
        heatmapData[key] = {
          url: click.original_url,
          position: click.link_position,
          index: click.link_index,
          text: click.link_text,
          clicks: 0
        };
      }
      heatmapData[key].clicks++;
    }

    const sortedData = Object.values(heatmapData).sort((a, b) => b.clicks - a.clicks);

    return { success: true, heatmapData: sortedData };
  } catch (err) {
    console.error('[Campaign Service] Error getting heatmap data:', err);
    return { success: false, error: err.message };
  }
}

export async function getCampaignRecipients(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (campaignError) throw campaignError;

    const recipients = await fetchAllRows((offset, limit) =>
      supabase
        .from('email_campaign_recipient')
        .select('id, email, status, open_count, click_count, error_message, sent_at')
        .eq('campaign_id', campaignId)
        .order('email', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
    );

    let linkClicks = [];
    try {
      linkClicks = await fetchAllRows((offset, limit) =>
        supabase
          .from('email_link_click')
          .select('recipient_id, original_url, link_text, link_index, created_at')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1)
      );
    } catch (clicksError) {
      console.warn('[Campaign Service] Error fetching link clicks, continuing without:', clicksError.message);
    }

    const clicksByRecipient = {};
    for (const click of linkClicks || []) {
      if (!clicksByRecipient[click.recipient_id]) {
        clicksByRecipient[click.recipient_id] = [];
      }
      clicksByRecipient[click.recipient_id].push({
        url: click.original_url,
        link_text: click.link_text,
        link_index: click.link_index,
        clicked_at: click.created_at
      });
    }

    const enrichedRecipients = (recipients || []).map(r => ({
      ...r,
      link_clicks: clicksByRecipient[r.id] || []
    }));

    return { success: true, recipients: enrichedRecipients };
  } catch (err) {
    console.error('[Campaign Service] Error getting campaign recipients:', err);
    return { success: false, error: err.message };
  }
}

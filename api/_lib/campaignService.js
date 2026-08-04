import { supabase } from './database.js';
import { sendEmail, replacePlaceholders } from './emailService.js';
import { replaceBookingPlaceholders } from './eventConfirmationEmail.js';
import { checkEmailQuota } from './planQuota.js';
import { buildQrImageUrl, ensureBookingToken, ensureComplexSessionTokens } from './checkinService.js';
import { sanitizeSlotHtml, htmlSlotToPlainText } from './slotHtmlSanitizer.js';
import { getPublicBaseUrl } from './publicBaseUrl.js';
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
    // Never fall back to the raw VERCEL_URL deployment domain for
    // user-facing links (Task #3384).
    return getPublicBaseUrl(null);
  }
  return `https://${tenantSlug}.${APP_DOMAIN}`;
}

async function enrichCampaignCounts(campaign) {
  if (!supabase || !campaign || !campaign.id) return campaign;
  // Include 'paused' so the UI shows up-to-date counts on a paused campaign,
  // and include all final states ('sent', 'failed', 'cancelled') so the UI
  // can detect "stuck with pending recipients" cases and offer Resume.
  if (!['sent', 'sending', 'preparing', 'paused', 'failed', 'cancelled'].includes(campaign.status)) return campaign;

  try {
    const [sentResult, openedResult, clickedResult, deliveredResult, pendingSentResult, pendingResult] = await Promise.all([
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
      // pending_count drives the UI's "Resume sending" affordance on
      // campaigns that ended (sent/failed/cancelled) but still have rows
      // sitting in 'pending' or 'processing' (the GRAFTAs-style stuck state).
      supabase.from('email_campaign_recipient').select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id).in('status', ['pending', 'processing']),
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
    const livePendingCount = pendingResult?.count || 0;

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
      likely_delivered_count: likelyDeliveredCount,
      pending_count: livePendingCount
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

/**
 * Pure predicate: is this email_template row a visual-builder template?
 * True only when editor_type==='visual' AND design_json normalizes to an object
 * carrying a blocks array. Legacy plain-HTML templates (editor_type 'html', no
 * design_json) return false. Mirrors isVisualTemplate() in GroupEmail.jsx.
 */
export function isVisualTemplateRecord(tpl) {
  if (!tpl || tpl.editor_type !== 'visual') return false;
  let design = tpl.design_json;
  if (typeof design === 'string') {
    try { design = JSON.parse(design); } catch { return false; }
  }
  return !!(design && typeof design === 'object' && Array.isArray(design.blocks));
}

// Normalize a design_json value (object or JSON string) to an object or null.
function normalizeDesignJson(design) {
  if (!design) return null;
  if (typeof design === 'string') {
    try { const p = JSON.parse(design); return p && typeof p === 'object' ? p : null; }
    catch { return null; }
  }
  return typeof design === 'object' ? design : null;
}

/**
 * Collect every dynamic slot token from a design's block tree (top-level
 * blocks, section children, and column blocks). Server mirror of
 * extractDynamicSlots() in client/src/components/email-builder/types.js.
 * Dynamic blocks count as fill-in slots: `dynamic_text` and `dynamic_image`
 * contribute their `token`; `dynamic_button` contributes both its `token`
 * (button text) and its `linkToken` (link URL). Returns a Set of token strings.
 */
export function extractDynamicSlotTokens(design) {
  const root = normalizeDesignJson(design);
  const blocks = Array.isArray(root) ? root : (root?.blocks || []);
  const tokens = new Set();
  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    if ((block.type === 'dynamic_text' || block.type === 'dynamic_image' || block.type === 'dynamic_button') && block.token) {
      tokens.add(block.token);
    }
    if (block.type === 'dynamic_button' && block.linkToken) tokens.add(block.linkToken);
    if (Array.isArray(block.children)) block.children.forEach(visit);
    if (Array.isArray(block.columns)) {
      block.columns.forEach((col) => { if (Array.isArray(col?.blocks)) col.blocks.forEach(visit); });
    }
  };
  blocks.forEach(visit);
  return tokens;
}

/**
 * Collect the set of DYNAMIC TEXT tokens only (rich-text formatting is allowed
 * exclusively on dynamic_text slots — image URLs and button text/link stay
 * plain). Used to validate a client-supplied richSlots marker list.
 */
export function extractDynamicTextSlotTokens(design) {
  const root = normalizeDesignJson(design);
  const blocks = Array.isArray(root) ? root : (root?.blocks || []);
  const tokens = new Set();
  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'dynamic_text' && block.token) tokens.add(block.token);
    if (Array.isArray(block.children)) block.children.forEach(visit);
    if (Array.isArray(block.columns)) {
      block.columns.forEach((col) => { if (Array.isArray(col?.blocks)) col.blocks.forEach(visit); });
    }
  };
  blocks.forEach(visit);
  return tokens;
}

/**
 * Collect the set of PRIMARY dynamic tokens (the keys used in DYN_BLOCK markers
 * and in the hiddenSlots list) — i.e. every dynamic block's `token`, but NOT a
 * dynamic_button's `linkToken` (a link cannot be hidden independently of its
 * button). Used to validate/filter a client-supplied hiddenSlots list.
 */
export function extractHideableSlotTokens(design) {
  const root = normalizeDesignJson(design);
  const blocks = Array.isArray(root) ? root : (root?.blocks || []);
  const tokens = new Set();
  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    if ((block.type === 'dynamic_text' || block.type === 'dynamic_image' || block.type === 'dynamic_button') && block.token) {
      tokens.add(block.token);
    }
    if (Array.isArray(block.children)) block.children.forEach(visit);
    if (Array.isArray(block.columns)) {
      block.columns.forEach((col) => { if (Array.isArray(col?.blocks)) col.blocks.forEach(visit); });
    }
  };
  blocks.forEach(visit);
  return tokens;
}

/**
 * Pure predicate: is this email_template row a visual-builder template?
 * (kept for callers that only need a yes/no check.)
 */
export async function assertVisualTemplateForCampaign(templateId, tenantId) {
  const resolved = await resolveMemberCampaignTemplateContent({ templateId, tenantId });
  return resolved.ok ? { ok: true } : { ok: false, error: resolved.error };
}

/**
 * Resolve the CANONICAL content a member (Group Email) campaign must persist
 * for a given visual template, accepting ONLY per-send slot values from the
 * client. This is the server-side lock for the template-driven flow:
 *   - email_template_id is REQUIRED (a member campaign cannot be freeform).
 *   - the template must be a visual-builder template (editor_type='visual').
 *   - the template must be opted in for member-group use (member_group_opt_in=true).
 *   - if the template has a non-empty member_group_classification_ids allowlist,
 *     the group's classification_id must appear in it. A group with no
 *     classification_id (null / undefined) is ONLY permitted for templates whose
 *     allowlist is empty (= "all classifications").
 *   - html_content is pinned to the template body (client-supplied HTML is
 *     ignored — layout cannot be altered outside slot values).
 *   - design_json is pinned to the template design; the only client-controlled
 *     part is design_json.slotValues, and that is filtered down to the tokens
 *     actually declared by the template's Dynamic Text blocks.
 * Returns { ok, html_content, design_json, email_template_id } on success,
 * else { ok:false, error }.
 *
 * @param {object} opts
 * @param {string}        opts.templateId
 * @param {string}        opts.tenantId
 * @param {object}        [opts.requestedSlotValues]
 * @param {string[]}      [opts.requestedHiddenSlots]
 * @param {string|null}   [opts.groupClassificationId]  - classification_id of the
 *   member group that owns this campaign. Pass null/undefined for unclassified groups.
 */
export async function resolveMemberCampaignTemplateContent({ templateId, tenantId, requestedSlotValues, requestedHiddenSlots, requestedRichSlots, groupClassificationId } = {}) {
  if (!templateId || templateId === 'none' || templateId === '') {
    return { ok: false, error: 'A visual email template is required.' };
  }
  if (!supabase) return { ok: false, error: 'Database not configured' };
  try {
    const { data, error } = await supabase
      .from('email_template')
      .select('id, editor_type, design_json, body, member_group_opt_in, member_group_classification_ids')
      .eq('id', templateId)
      .eq('tenant_id', tenantId)
      .single();
    if (error || !data) return { ok: false, error: 'Selected template was not found.' };
    if (!isVisualTemplateRecord(data)) {
      return { ok: false, error: 'Group emails can only use visual-builder templates.' };
    }

    // Opt-in check: template must explicitly allow member-group use.
    if (!data.member_group_opt_in) {
      return { ok: false, error: 'The selected template is not available for member group emails.' };
    }

    // Classification check: empty allowlist = all; non-empty = only listed IDs.
    const allowedClassifications = Array.isArray(data.member_group_classification_ids)
      ? data.member_group_classification_ids.filter(Boolean)
      : [];
    if (allowedClassifications.length > 0) {
      // Non-empty allowlist: group must have a classification that's in the list.
      if (!groupClassificationId || !allowedClassifications.includes(String(groupClassificationId))) {
        return { ok: false, error: 'The selected template is not available for this group\'s classification.' };
      }
    }
    // Empty allowlist + opt-in true = available to all classifications (including no-classification groups).

    const design = normalizeDesignJson(data.design_json) || {};
    const tokens = extractDynamicSlotTokens(design);
    const slotValues = {};
    if (requestedSlotValues && typeof requestedSlotValues === 'object') {
      for (const token of tokens) {
        if (Object.prototype.hasOwnProperty.call(requestedSlotValues, token)) {
          const v = requestedSlotValues[token];
          slotValues[token] = v == null ? '' : String(v);
        }
      }
    }

    // hiddenSlots: per-send list of primary dynamic tokens the sender chose to
    // hide. Filter to tokens actually declared by the template so a client can
    // never inject arbitrary marker keys.
    const hideable = extractHideableSlotTokens(design);
    const hiddenSlots = [];
    if (Array.isArray(requestedHiddenSlots)) {
      for (const token of requestedHiddenSlots) {
        if (typeof token === 'string' && hideable.has(token) && !hiddenSlots.includes(token)) {
          hiddenSlots.push(token);
        }
      }
    }

    // richSlots: per-send marker for slot values authored as rich HTML in the
    // TipTap slot editor. Only dynamic_text tokens may be marked rich — image
    // and button slots stay plain — so a client can never flip a URL/text slot
    // into raw-HTML injection mode. Rich values are additionally sanitized so
    // the persisted design never carries scripts/dangerous markup.
    const richables = extractDynamicTextSlotTokens(design);
    const richSlots = [];
    if (Array.isArray(requestedRichSlots)) {
      for (const token of requestedRichSlots) {
        if (typeof token === 'string' && richables.has(token) && !richSlots.includes(token)) {
          richSlots.push(token);
        }
      }
    }
    for (const token of richSlots) {
      if (Object.prototype.hasOwnProperty.call(slotValues, token)) {
        slotValues[token] = sanitizeSlotHtml(slotValues[token]);
      }
    }

    return {
      ok: true,
      email_template_id: data.id,
      html_content: data.body || '',
      design_json: { ...design, slotValues, hiddenSlots, richSlots },
    };
  } catch (err) {
    console.error('[Campaign Service] Error resolving template content:', err);
    return { ok: false, error: err.message };
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

    if (campaign.status !== 'sending' && campaign.status !== 'scheduled' && campaign.status !== 'preparing' && campaign.status !== 'paused') {
      return { success: false, error: `Cannot cancel campaign with status: ${campaign.status}. Only sending, paused, or scheduled campaigns can be cancelled.` };
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
      .in('status', ['sending', 'scheduled', 'preparing', 'paused'])
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

// Pause an in-flight campaign. Allowed from 'sending' or 'preparing'. The
// campaign is flipped to 'paused' so the cron worker (which only looks for
// status='sending') will stop picking it up. Recipient rows remain in their
// current 'pending'/'processing' state — they are NOT cancelled, so the
// operator can resume from the exact same point with resumeCampaign().
//
// Note about in-flight batches: sendBatch may already have claimed up to 100
// recipients (status='processing') for the current invocation. Those will
// finish their Mailgun call (we don't kill them mid-flight). Any pending
// rows beyond that batch will remain pending until resume.
export async function pauseCampaign(campaignId, tenantId, pausedBy = null) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, status, name')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !campaign) {
      return { success: false, error: 'Campaign not found' };
    }

    if (campaign.status !== 'sending' && campaign.status !== 'preparing') {
      return { success: false, error: `Cannot pause campaign with status: ${campaign.status}. Only sending or preparing campaigns can be paused.` };
    }

    const pausedAt = new Date().toISOString();
    // Atomic claim — only flip if the status hasn't changed in the meantime
    // (the campaign could have just finished in the millisecond between the
    // fetch above and now).
    const { data: updatedRows, error: updateError } = await supabase
      .from('email_campaign')
      .update({ status: 'paused', updated_at: pausedAt })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .in('status', ['sending', 'preparing'])
      .select('id');

    if (updateError) throw updateError;

    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: `Campaign status changed before pause could be applied. Current status: ${campaign.status}` };
    }

    const { count: pendingCount } = await supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['pending', 'processing']);

    console.log(`[Campaign Service] Campaign ${campaignId} (${campaign.name}) PAUSED by ${pausedBy || 'unknown'} — ${pendingCount || 0} recipients pending`);

    return {
      success: true,
      paused: true,
      campaignId,
      campaignName: campaign.name,
      previousStatus: campaign.status,
      pendingCount: pendingCount || 0,
      pausedAt,
    };
  } catch (err) {
    console.error('[Campaign Service] Error pausing campaign:', err);
    return { success: false, error: err.message };
  }
}

// Resume a campaign back to 'sending' so the cron drains its remaining
// pending recipients. Handles two distinct scenarios:
//
//   1) Normal resume: campaign is 'paused' (operator hit Pause).
//   2) Stuck recovery: campaign is 'sent', 'failed', or 'cancelled' but
//      still has pending/processing recipient rows (e.g. the GRAFTAs
//      incident, or any future race / timeout that left rows orphaned).
//
// In BOTH cases we refuse to act unless there are actually pending or
// processing rows to drain — resuming a fully-completed campaign would be
// a no-op at best and confusing at worst. completed_at and cancelled_at
// are cleared so the cron's mark-sent path can set completed_at correctly
// when the drain finishes.
export async function resumeCampaign(campaignId, tenantId, resumedBy = null) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, status, name, completed_at, cancelled_at')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchError || !campaign) {
      return { success: false, error: 'Campaign not found' };
    }

    const resumableFromPaused = campaign.status === 'paused';
    const resumableFromStuck = ['sent', 'failed', 'cancelled'].includes(campaign.status);

    if (!resumableFromPaused && !resumableFromStuck) {
      return { success: false, error: `Cannot resume campaign with status: ${campaign.status}. Only paused or finished campaigns with remaining recipients can be resumed.` };
    }

    const { count: pendingCount } = await supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', ['pending', 'processing']);

    if (!pendingCount || pendingCount === 0) {
      return { success: false, error: 'Nothing to resume — there are no pending or processing recipients for this campaign.' };
    }

    const resumedAt = new Date().toISOString();
    // Atomic flip: only proceed if the status is still what we read above.
    // Clear completed_at + cancelled_at so the cron's completion path will
    // set them correctly when the drain actually finishes.
    const { data: updatedRows, error: updateError } = await supabase
      .from('email_campaign')
      .update({
        status: 'sending',
        completed_at: null,
        cancelled_at: null,
        cancelled_by: null,
        updated_at: resumedAt,
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .eq('status', campaign.status)
      .select('id');

    if (updateError) throw updateError;

    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: `Campaign status changed before resume could be applied. Current status was: ${campaign.status}` };
    }

    // If the operator is resuming cancelled rows back to pending? No — only
    // `pending`/`processing` rows are drained by the cron. cancelled rows
    // were intentionally cancelled and stay that way. Resume only finishes
    // the unprocessed remainder.

    const reason = resumableFromPaused ? 'paused' : `stuck-${campaign.status}`;
    console.log(`[Campaign Service] Campaign ${campaignId} (${campaign.name}) RESUMED by ${resumedBy || 'unknown'} from '${campaign.status}' → 'sending' (${pendingCount} pending recipients to drain). Reason: ${reason}`);

    return {
      success: true,
      resumed: true,
      campaignId,
      campaignName: campaign.name,
      previousStatus: campaign.status,
      pendingCount,
      resumedAt,
      stuckRecovery: resumableFromStuck,
    };
  } catch (err) {
    console.error('[Campaign Service] Error resuming campaign:', err);
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

// Decode the HTML entities a stored href can carry (most importantly &amp;,
// which the rich-text editor writes for a typed `&`) back to their literal
// characters. Without this the entity is percent-encoded verbatim into the
// tracking redirect and survives the round-trip, splitting query strings into
// bogus params like `amp;booking_id` instead of `booking_id`.
function decodeHtmlEntitiesInUrl(url) {
  if (!url) return url;
  return url
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'");
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

      // Normalize entity-encoded ampersands (and other entities) to their
      // literal form before wrapping, so the destination link carried in the
      // tracking redirect uses single `&` separators and its query params
      // arrive intact.
      const cleanUrl = decodeHtmlEntitiesInUrl(url);

      const token = generateTrackingToken(campaignId, recipientId, linkIndex);
      const trackUrl = `${baseUrl}/api/track/click?t=${token}&url=${encodeURIComponent(cleanUrl)}`;
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
  'communication_category', 'form', 'member_group', 'member_group_admins', 'event_attendees',
  'event_form', 'field_filter'
]);

function validateCampaignTargeting(campaign) {
  const audiences = campaign.target_audiences;
  const hasAudiences = Array.isArray(audiences) && audiences.length > 0;

  if (hasAudiences) {
    for (const segment of audiences) {
      if (!segment.type || !ALLOWED_SEGMENT_TYPES.has(segment.type)) {
        return { valid: false, reason: `Invalid or disallowed audience segment type: "${segment.type}". Campaigns cannot target all members.` };
      }
      if (segment.type === 'field_filter') {
        if (!Array.isArray(segment.filter_groups) || segment.filter_groups.length === 0) {
          return { valid: false, reason: 'Field filter segment has no filter groups configured.' };
        }
      } else if (segment.type === 'event_form') {
        if (!Array.isArray(segment.ids) || segment.ids.length !== 1) {
          return { valid: false, reason: 'Event form segment must reference exactly one form.' };
        }
        if (typeof segment.received !== 'boolean') {
          return { valid: false, reason: 'Event form segment must specify a Received/Not Received choice.' };
        }
      } else if (segment.type !== 'all_members' && (!Array.isArray(segment.ids) || segment.ids.length === 0)) {
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

async function getRecipientsForSegment(targetType, targetIds, tenantId, segmentData = null) {
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
    // Optional in-group role restriction (used by member-side group emails so
    // a Chair can email only Treasurers within their group). Tenant-admin
    // callers don't pass `roles`, preserving the existing wide behavior.
    const roleFilter = segmentData && Array.isArray(segmentData.roles) && segmentData.roles.length > 0
      ? segmentData.roles
      : null;

    const allAssignments = [];
    let assignmentOffset = 0;
    const assignmentBatchSize = 1000;
    let hasMoreAssignments = true;
    const nowIso = new Date().toISOString();

    while (hasMoreAssignments) {
      let q = supabase
        .from('member_group_assignment')
        .select('member_id, group_role, expires_at')
        .in('group_id', targetIds);
      if (roleFilter) q = q.in('group_role', roleFilter);
      const { data: batch } = await q.range(assignmentOffset, assignmentOffset + assignmentBatchSize - 1);

      if (batch && batch.length > 0) {
        allAssignments.push(...batch);
        assignmentOffset += batch.length;
        hasMoreAssignments = batch.length === assignmentBatchSize;
      } else {
        hasMoreAssignments = false;
      }
    }

    // Drop expired assignments client-side (tolerates NULL expires_at).
    const liveAssignments = allAssignments.filter(a => a.member_id && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso));
    const memberIds = [...new Set(liveAssignments.map(a => a.member_id))];

    if (memberIds.length === 0 && roleFilter) {
      console.log(`[Campaign Service] member_group resolver: 0 members for group(s) ${targetIds.join(',')} after role filter [${roleFilter.join(',')}]`);
    }

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
  } else if (targetType === 'member_group_admins' && targetIds.length > 0) {
    // Task #2981: only the admins of the selected groups. Admin status is the
    // per-assignment is_group_admin flag (legacy leadership roles retired)
    // plus a non-expired expires_at, mirroring memberGroupAdminAccess.js.
    const allAssignments = [];
    let assignmentOffset = 0;
    const assignmentBatchSize = 1000;
    let hasMoreAssignments = true;
    const nowIso = new Date().toISOString();

    while (hasMoreAssignments) {
      const { data: batch } = await supabase
        .from('member_group_assignment')
        .select('member_id, expires_at, is_group_admin')
        .in('group_id', targetIds)
        .eq('is_group_admin', true)
        .range(assignmentOffset, assignmentOffset + assignmentBatchSize - 1);

      if (batch && batch.length > 0) {
        allAssignments.push(...batch);
        assignmentOffset += batch.length;
        hasMoreAssignments = batch.length === assignmentBatchSize;
      } else {
        hasMoreAssignments = false;
      }
    }

    const liveAssignments = allAssignments.filter(a =>
      a.member_id
      && a.is_group_admin === true
      && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso)
    );
    const memberIds = [...new Set(liveAssignments.map(a => a.member_id))];

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
            .not('member.email', 'ilike', 'deleted_%@deleted.local')
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
  } else if (targetType === 'event_attendees' && targetIds.length > 0) {
    // Per-event ticket-type selection: { [eventId]: 'all' | [{id, name}] }
    // When a specific selection exists for an event, only include bookings whose
    // ticket class matches. Absent or 'all' means include all confirmed attendees.
    const ticketTypeSel = (segmentData && segmentData.ticket_type_selection) || null;

    // Per-event attendance selection: { [eventId]: 'all' | 'attended' | 'not_attended' }
    // Absent or 'all' means include all confirmed bookings regardless of check-in.
    const attendanceSelRaw = (segmentData && segmentData.attendance_selection) || null;
    const attendanceSel = attendanceSelRaw && typeof attendanceSelRaw === 'object'
      ? Object.fromEntries(
          Object.entries(attendanceSelRaw).filter(([, v]) => v === 'attended' || v === 'not_attended')
        )
      : null;
    const hasAttendanceFilter = attendanceSel && Object.keys(attendanceSel).length > 0;

    const NO_TICKET_TYPE_SENTINEL = '__no_ticket_type__';

    const shouldKeepBooking = (row, isComplex) => {
      if (!ticketTypeSel) return true;
      const sel = ticketTypeSel[row.event_id];
      if (!sel || sel === 'all' || !Array.isArray(sel) || sel.length === 0) return true;

      // "No ticket type" sentinel: bookings with neither a ticket class id nor name
      const hasNoTicketType = !row.ticket_class_id && !row.ticket_class_name;
      const sentinelSelected = sel.some(tc => tc.id === NO_TICKET_TYPE_SENTINEL);
      if (hasNoTicketType && sentinelSelected) return true;

      // Named-tier matching — exclude the sentinel so it doesn't pollute id/name lists
      const namedSel = sel.filter(tc => tc.id !== NO_TICKET_TYPE_SENTINEL);
      if (isComplex) {
        const selectedIds = namedSel.map(tc => tc.id).filter(Boolean);
        const selectedNamesLower = namedSel.map(tc => tc.name).filter(Boolean).map(n => n.toLowerCase());
        if (row.ticket_class_id && selectedIds.includes(row.ticket_class_id)) return true;
        if (row.ticket_class_name && selectedNamesLower.includes(row.ticket_class_name.toLowerCase())) return true;
        return false;
      } else {
        const selectedNamesLower = namedSel.map(tc => tc.name).filter(Boolean).map(n => n.toLowerCase());
        if (row.ticket_class_name && selectedNamesLower.includes(row.ticket_class_name.toLowerCase())) return true;
        return false;
      }
    };

    const collectBookings = async (table, isComplex) => {
      const rows = [];
      const idBatchSize = 200;
      // Simple bookings carry check-in state directly; complex bookings need
      // their id so session check-ins can be looked up afterwards.
      const selectCols = hasAttendanceFilter
        ? (isComplex
            ? 'id, event_id, ticket_class_id, ticket_class_name, attendee_email, attendee_first_name, attendee_last_name, member_id'
            : 'event_id, ticket_class_id, ticket_class_name, attendee_email, attendee_first_name, attendee_last_name, member_id, checked_in_at')
        : 'event_id, ticket_class_id, ticket_class_name, attendee_email, attendee_first_name, attendee_last_name, member_id';
      for (let i = 0; i < targetIds.length; i += idBatchSize) {
        const idBatch = targetIds.slice(i, i + idBatchSize);
        let offset = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await supabase
            .from(table)
            .select(selectCols)
            .eq('tenant_id', tenantId)
            .eq('status', 'confirmed')
            .in('event_id', idBatch)
            .range(offset, offset + pageSize - 1);
          if (error) {
            console.error(`[EventAttendees] ${table} query error:`, error);
            break;
          }
          if (data && data.length > 0) {
            const kept = ticketTypeSel ? data.filter(row => shouldKeepBooking(row, isComplex)) : data;
            rows.push(...kept);
            offset += data.length;
            hasMore = data.length === pageSize;
          } else {
            hasMore = false;
          }
        }
      }
      return rows;
    };

    let [regularBookings, complexBookings] = await Promise.all([
      collectBookings('booking', false),
      collectBookings('complex_event_booking', true),
    ]);

    if (hasAttendanceFilter) {
      // Complex events: attended = at least one session check-in with checked_in_at set.
      const complexIdsNeedingLookup = complexBookings
        .filter(row => attendanceSel[row.event_id])
        .map(row => row.id)
        .filter(Boolean);
      const attendedComplexBookingIds = new Set();
      const ckBatchSize = 200;
      for (let i = 0; i < complexIdsNeedingLookup.length; i += ckBatchSize) {
        const idBatch = complexIdsNeedingLookup.slice(i, i + ckBatchSize);
        let offset = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await supabase
            .from('complex_event_session_checkin')
            .select('booking_id')
            .eq('tenant_id', tenantId)
            .in('booking_id', idBatch)
            .not('checked_in_at', 'is', null)
            .range(offset, offset + pageSize - 1);
          if (error) {
            console.error('[EventAttendees] session check-in lookup error:', error);
            break;
          }
          if (data && data.length > 0) {
            for (const ck of data) attendedComplexBookingIds.add(ck.booking_id);
            offset += data.length;
            hasMore = data.length === pageSize;
          } else {
            hasMore = false;
          }
        }
      }

      const keepByAttendance = (row, attended) => {
        const sel = attendanceSel[row.event_id];
        if (!sel) return true;
        return sel === 'attended' ? attended : !attended;
      };

      regularBookings = regularBookings.filter(row => keepByAttendance(row, !!row.checked_in_at));
      complexBookings = complexBookings.filter(row => keepByAttendance(row, attendedComplexBookingIds.has(row.id)));
    }

    const bookingRows = [...regularBookings, ...complexBookings];

    if (bookingRows.length > 0) {
      const isDeletedEmail = (email) => /^deleted_.*@deleted\.local$/i.test(email || '');

      // Attendees identified directly by attendee_email.
      const attendeeByEmail = new Map(); // emailKey -> { email, first_name, last_name }
      // Bookings with no attendee_email fall back to the booker member.
      const fallbackBookerIds = new Set();

      for (const row of bookingRows) {
        const attendeeEmail = (row.attendee_email || '').trim();
        if (attendeeEmail) {
          if (isDeletedEmail(attendeeEmail)) continue;
          const key = attendeeEmail.toLowerCase();
          if (!attendeeByEmail.has(key)) {
            attendeeByEmail.set(key, {
              email: attendeeEmail,
              first_name: row.attendee_first_name || '',
              last_name: row.attendee_last_name || '',
            });
          }
        } else if (row.member_id) {
          fallbackBookerIds.add(row.member_id);
        }
      }

      // Resolve attendee emails to member rows (so members get id + opt-out flag).
      const memberByEmail = new Map(); // emailKey -> member row
      const attendeeEmailArr = [...attendeeByEmail.values()].map((a) => a.email);
      const emailBatchSize = 200;
      for (let i = 0; i < attendeeEmailArr.length; i += emailBatchSize) {
        const batch = attendeeEmailArr.slice(i, i + emailBatchSize);
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .or(buildEmailCaseInsensitiveOr(batch));
        if (members) {
          for (const m of members) {
            if (!m.email) continue;
            memberByEmail.set(m.email.toLowerCase(), m);
          }
        }
      }

      // Resolve fallback booker member_ids to member rows.
      const fallbackMembers = [];
      const fallbackIdArr = [...fallbackBookerIds];
      const idBatchSize = 500;
      for (let i = 0; i < fallbackIdArr.length; i += idBatchSize) {
        const batch = fallbackIdArr.slice(i, i + idBatchSize);
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .in('id', batch)
          .not('email', 'ilike', 'deleted_%@deleted.local');
        if (members) fallbackMembers.push(...members);
      }

      const seenEmails = new Set();
      const pushMember = (m) => {
        if (!m.email || isDeletedEmail(m.email)) return;
        const key = m.email.toLowerCase();
        if (seenEmails.has(key)) return;
        seenEmails.add(key);
        recipients.push({
          id: m.id,
          member_id: m.id,
          email: m.email,
          first_name: m.first_name,
          last_name: m.last_name,
          communications_opted_out_all: m.communications_opted_out_all,
        });
      };

      // Attendees: prefer the matching member row; otherwise include as a guest.
      for (const [key, attendee] of attendeeByEmail) {
        const member = memberByEmail.get(key);
        if (member) {
          pushMember(member);
        } else {
          if (seenEmails.has(key)) continue;
          seenEmails.add(key);
          recipients.push({
            id: null,
            member_id: null,
            email: attendee.email,
            first_name: attendee.first_name,
            last_name: attendee.last_name,
          });
        }
      }

      // Legacy bookings with no attendee_email: include the booker.
      for (const m of fallbackMembers) {
        pushMember(m);
      }
    }
  } else if (targetType === 'event_form' && targetIds.length > 0) {
    const formId = targetIds[0];
    const received = segmentData ? segmentData.received === true : true;

    const { data: form } = await supabase
      .from('form')
      .select('id, name, tenant_id, is_event_related, related_event_id, fields')
      .eq('id', formId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (form && form.is_event_related && form.related_event_id) {
      const eventId = form.related_event_id;
      const fields = Array.isArray(form.fields) ? form.fields : [];
      const isDeletedEmail = (email) => /^deleted_.*@deleted\.local$/i.test(email || '');
      const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

      // Gather confirmed attendees from both booking tables, de-duped by email.
      const collectBookings = async (table) => {
        const rows = [];
        let offset = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await supabase
            .from(table)
            .select('attendee_email, attendee_first_name, attendee_last_name, member_id')
            .eq('tenant_id', tenantId)
            .eq('status', 'confirmed')
            .eq('event_id', eventId)
            .range(offset, offset + pageSize - 1);
          if (error) {
            console.error(`[EventForm] ${table} query error:`, error);
            break;
          }
          if (data && data.length > 0) {
            rows.push(...data);
            offset += data.length;
            hasMore = data.length === pageSize;
          } else {
            hasMore = false;
          }
        }
        return rows;
      };

      const [regularBookings, complexBookings] = await Promise.all([
        collectBookings('booking'),
        collectBookings('complex_event_booking'),
      ]);
      const bookingRows = [...regularBookings, ...complexBookings];

      const attendeeByEmail = new Map(); // emailKey -> { email, first_name, last_name }
      const fallbackBookerIds = new Set();
      for (const row of bookingRows) {
        const attendeeEmail = (row.attendee_email || '').trim();
        if (attendeeEmail) {
          if (isDeletedEmail(attendeeEmail)) continue;
          const key = attendeeEmail.toLowerCase();
          if (!attendeeByEmail.has(key)) {
            attendeeByEmail.set(key, {
              email: attendeeEmail,
              first_name: row.attendee_first_name || '',
              last_name: row.attendee_last_name || '',
            });
          }
        } else if (row.member_id) {
          fallbackBookerIds.add(row.member_id);
        }
      }

      // Resolve fallback booker member_ids to member rows (gives them an email).
      const fallbackMembers = [];
      const fallbackIdArr = [...fallbackBookerIds];
      const idBatchSize = 500;
      for (let i = 0; i < fallbackIdArr.length; i += idBatchSize) {
        const batch = fallbackIdArr.slice(i, i + idBatchSize);
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .in('id', batch)
          .not('email', 'ilike', 'deleted_%@deleted.local');
        if (members) fallbackMembers.push(...members);
      }
      const fallbackMemberByEmail = new Map();
      for (const m of fallbackMembers) {
        const attendeeEmail = (m.email || '').trim();
        if (!attendeeEmail || isDeletedEmail(attendeeEmail)) continue;
        const key = attendeeEmail.toLowerCase();
        if (!attendeeByEmail.has(key)) {
          attendeeByEmail.set(key, {
            email: attendeeEmail,
            first_name: m.first_name || '',
            last_name: m.last_name || '',
          });
        }
        fallbackMemberByEmail.set(key, m);
      }

      // Load all submissions for the form and extract submitter emails using the
      // three-tier fallback (column -> email-typed/named field -> any email value).
      const extractSubmissionEmail = (submission) => {
        if (isEmail(submission.submitted_by_email)) return submission.submitted_by_email.trim();
        const data = submission.submission_data || {};
        for (const field of fields) {
          if (!field || !field.id) continue;
          const idLower = (field.id || '').toLowerCase();
          const labelLower = (field.label || '').toLowerCase();
          const looksLikeEmail =
            field.type === 'email' ||
            idLower.includes('email') || idLower.includes('e-mail') ||
            labelLower.includes('email') || labelLower.includes('e-mail');
          if (!looksLikeEmail) continue;
          const val = data[field.id];
          if (isEmail(val)) return val.trim();
        }
        for (const value of Object.values(data)) {
          if (isEmail(value)) return value.trim();
        }
        return null;
      };

      const submittedEmails = new Set();
      let subOffset = 0;
      const subPageSize = 1000;
      let hasMoreSubs = true;
      while (hasMoreSubs) {
        const { data: subs, error: subError } = await supabase
          .from('form_submission')
          .select('id, submitted_by_email, submission_data')
          .eq('form_id', formId)
          .eq('tenant_id', tenantId)
          .range(subOffset, subOffset + subPageSize - 1);
        if (subError) {
          console.error('[EventForm] form_submission query error:', subError);
          break;
        }
        if (subs && subs.length > 0) {
          for (const s of subs) {
            const email = extractSubmissionEmail(s);
            if (email) submittedEmails.add(email.toLowerCase());
          }
          subOffset += subs.length;
          hasMoreSubs = subs.length === subPageSize;
        } else {
          hasMoreSubs = false;
        }
      }

      // Keep attendees who have (received) / haven't (not received) submitted.
      const keptAttendees = [];
      for (const [key, attendee] of attendeeByEmail) {
        const hasSubmitted = submittedEmails.has(key);
        if (received ? hasSubmitted : !hasSubmitted) keptAttendees.push({ key, attendee });
      }

      // Resolve kept attendee emails to member rows so members get id + opt-out.
      const memberByEmail = new Map();
      const keptEmailArr = keptAttendees.map((k) => k.attendee.email);
      const emailBatchSize = 200;
      for (let i = 0; i < keptEmailArr.length; i += emailBatchSize) {
        const batch = keptEmailArr.slice(i, i + emailBatchSize);
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .or(buildEmailCaseInsensitiveOr(batch));
        if (members) {
          for (const m of members) {
            if (!m.email) continue;
            memberByEmail.set(m.email.toLowerCase(), m);
          }
        }
      }

      const seenEmails = new Set();
      for (const { key, attendee } of keptAttendees) {
        const member = memberByEmail.get(key) || fallbackMemberByEmail.get(key);
        if (member) {
          if (!member.email || isDeletedEmail(member.email)) continue;
          const mKey = member.email.toLowerCase();
          if (seenEmails.has(mKey)) continue;
          seenEmails.add(mKey);
          recipients.push({
            id: member.id,
            member_id: member.id,
            email: member.email,
            first_name: member.first_name,
            last_name: member.last_name,
            communications_opted_out_all: member.communications_opted_out_all,
          });
        } else {
          if (seenEmails.has(key)) continue;
          seenEmails.add(key);
          recipients.push({
            id: null,
            member_id: null,
            email: attendee.email,
            first_name: attendee.first_name,
            last_name: attendee.last_name,
          });
        }
      }
    }
  } else if (targetType === 'audience_list' && targetIds.length > 0) {
    const { data: lists } = await supabase
      .from('audience_list')
      .select('id, target_audiences, ignore_opt_outs')
      .eq('tenant_id', tenantId)
      .in('id', targetIds);

    if (lists && lists.length > 0) {
      for (const list of lists) {
        const savedAudiences = list.target_audiences;
        const bypassOptOut = list.ignore_opt_outs === true;
        if (Array.isArray(savedAudiences) && savedAudiences.length > 0) {
          for (const segment of savedAudiences) {
            if (segment.type === 'audience_list') continue;
            const segRecipients = await getRecipientsForSegment(segment.type, segment.ids || [], tenantId, segment);
            if (bypassOptOut) {
              for (const r of segRecipients) r.bypass_opt_out = true;
            }
            recipients.push(...segRecipients);
          }
        }
      }
    }
  } else if (targetType === 'field_filter' && segmentData) {
    const ALLOWED_CORE_MEMBER_KEYS = new Set(['first_name', 'last_name', 'email', 'job_title', 'role_id', 'login_enabled', 'communications_opted_out_all']);
    const ALLOWED_CORE_ORG_KEYS = new Set(['name', 'status']);
    const ALLOWED_CORE_EVENT_KEYS = new Set(['attended_event']);
    const ALLOWED_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty', 'is_true', 'is_false', 'greater_than', 'less_than', 'before', 'after', 'is_one_of', 'is_not_one_of']);
    const ALLOWED_SCOPES = new Set(['member', 'organization', 'event']);

    const filterGroups = segmentData.filter_groups || [];
    if (filterGroups.length > 0) {
      const groupMemberSets = [];

      for (const group of filterGroups) {
        const conditions = (group.conditions || []).filter(c => {
          if (!ALLOWED_SCOPES.has(c.entity_scope)) return false;
          if (!ALLOWED_OPERATORS.has(c.operator)) return false;
          if (c.entity_scope === 'event') {
            if (!ALLOWED_CORE_EVENT_KEYS.has(c.field_key)) return false;
            if (c.operator !== 'is_one_of' && c.operator !== 'is_not_one_of') return false;
          } else if (c.field_type === 'core') {
            const allowedKeys = c.entity_scope === 'member' ? ALLOWED_CORE_MEMBER_KEYS : ALLOWED_CORE_ORG_KEYS;
            if (!allowedKeys.has(c.field_key)) return false;
          }
          return true;
        });
        if (conditions.length === 0) continue;

        const memberConditions = conditions.filter(c => c.entity_scope === 'member');
        const orgConditions = conditions.filter(c => c.entity_scope === 'organization');
        const eventConditions = conditions.filter(c => c.entity_scope === 'event');

        let memberIds = null;

        if (memberConditions.length > 0) {
          const coreMemberConds = memberConditions.filter(c => c.field_type === 'core');
          const customMemberConds = memberConditions.filter(c => c.field_type === 'custom');

          let coreMatchedIds = null;
          if (coreMemberConds.length > 0) {
            let query = supabase
              .from('member')
              .select('id')
              .eq('tenant_id', tenantId)
              .not('email', 'ilike', 'deleted_%@deleted.local');

            for (const cond of coreMemberConds) {
              query = applyConditionToQuery(query, cond.field_key, cond.operator, cond.value, cond.data_type);
            }

            const allIds = [];
            let offset = 0;
            const batchSize = 1000;
            let hasMore = true;
            while (hasMore) {
              const { data: batch, error } = await query.range(offset, offset + batchSize - 1);
              if (error) { console.error('[FieldFilter] core member query error:', error); break; }
              if (batch && batch.length > 0) {
                allIds.push(...batch.map(r => r.id));
                offset += batch.length;
                hasMore = batch.length === batchSize;
              } else { hasMore = false; }
            }
            coreMatchedIds = new Set(allIds);
          }

          let customMatchedIds = null;
          for (const cond of customMemberConds) {
            const selectCols = (cond.data_type === 'number' || cond.data_type === 'decimal') && (cond.operator === 'greater_than' || cond.operator === 'less_than') ? 'member_id, value' : 'member_id';
            let query = supabase
              .from('member_preference_value')
              .select(selectCols)
              .eq('field_id', cond.field_key);

            const { query: filteredQuery, postFilter } = applyPrefValueCondition(query, cond.operator, cond.value, cond.data_type);
            query = filteredQuery;

            const allRows = [];
            let offset = 0;
            const batchSize = 1000;
            let hasMore = true;
            while (hasMore) {
              const { data: batch, error } = await query.range(offset, offset + batchSize - 1);
              if (error) { console.error('[FieldFilter] custom member query error:', error); break; }
              if (batch && batch.length > 0) {
                allRows.push(...batch);
                offset += batch.length;
                hasMore = batch.length === batchSize;
              } else { hasMore = false; }
            }

            const filteredRows = postFilter ? postFilter(allRows) : allRows;
            const allMemberIds = filteredRows.map(r => r.member_id);

            const condSet = new Set(allMemberIds);
            if (cond.operator === 'is_empty') {
              let allMembersQuery = supabase
                .from('member')
                .select('id')
                .eq('tenant_id', tenantId)
                .not('email', 'ilike', 'deleted_%@deleted.local');
              const allMembers = [];
              let mOffset = 0;
              let mHasMore = true;
              while (mHasMore) {
                const { data: mBatch } = await allMembersQuery.range(mOffset, mOffset + batchSize - 1);
                if (mBatch && mBatch.length > 0) {
                  allMembers.push(...mBatch.map(r => r.id));
                  mOffset += mBatch.length;
                  mHasMore = mBatch.length === batchSize;
                } else { mHasMore = false; }
              }
              const hasValueSet = new Set();
              let hvQuery = supabase
                .from('member_preference_value')
                .select('member_id')
                .eq('field_id', cond.field_key)
                .not('value', 'is', null)
                .neq('value', '')
                .neq('value', '[]');
              let hvOffset = 0;
              let hvHasMore = true;
              while (hvHasMore) {
                const { data: hvBatch } = await hvQuery.range(hvOffset, hvOffset + batchSize - 1);
                if (hvBatch && hvBatch.length > 0) {
                  hvBatch.forEach(r => hasValueSet.add(r.member_id));
                  hvOffset += hvBatch.length;
                  hvHasMore = hvBatch.length === batchSize;
                } else { hvHasMore = false; }
              }
              const emptySet = new Set(allMembers.filter(id => !hasValueSet.has(id)));
              customMatchedIds = customMatchedIds ? new Set([...customMatchedIds].filter(id => emptySet.has(id))) : emptySet;
            } else {
              customMatchedIds = customMatchedIds ? new Set([...customMatchedIds].filter(id => condSet.has(id))) : condSet;
            }
          }

          if (coreMatchedIds !== null && customMatchedIds !== null) {
            memberIds = new Set([...coreMatchedIds].filter(id => customMatchedIds.has(id)));
          } else if (coreMatchedIds !== null) {
            memberIds = coreMatchedIds;
          } else if (customMatchedIds !== null) {
            memberIds = customMatchedIds;
          }
        }

        if (orgConditions.length > 0) {
          const coreOrgConds = orgConditions.filter(c => c.field_type === 'core');
          const customOrgConds = orgConditions.filter(c => c.field_type === 'custom');

          let matchedOrgIds = null;

          if (coreOrgConds.length > 0) {
            let query = supabase
              .from('organization')
              .select('id')
              .eq('tenant_id', tenantId);

            for (const cond of coreOrgConds) {
              query = applyConditionToQuery(query, cond.field_key, cond.operator, cond.value, cond.data_type);
            }

            const allOrgIds = [];
            let offset = 0;
            const batchSize = 1000;
            let hasMore = true;
            while (hasMore) {
              const { data: batch, error } = await query.range(offset, offset + batchSize - 1);
              if (error) { console.error('[FieldFilter] core org query error:', error); break; }
              if (batch && batch.length > 0) {
                allOrgIds.push(...batch.map(r => r.id));
                offset += batch.length;
                hasMore = batch.length === batchSize;
              } else { hasMore = false; }
            }
            matchedOrgIds = new Set(allOrgIds);
          }

          for (const cond of customOrgConds) {
            const selectCols = (cond.data_type === 'number' || cond.data_type === 'decimal') && (cond.operator === 'greater_than' || cond.operator === 'less_than') ? 'organization_id, value' : 'organization_id';
            let query = supabase
              .from('organization_preference_value')
              .select(selectCols)
              .eq('field_id', cond.field_key);

            const { query: filteredQuery, postFilter } = applyPrefValueCondition(query, cond.operator, cond.value, cond.data_type);
            query = filteredQuery;

            const allRows = [];
            let offset = 0;
            const batchSize = 1000;
            let hasMore = true;
            while (hasMore) {
              const { data: batch, error } = await query.range(offset, offset + batchSize - 1);
              if (error) { console.error('[FieldFilter] custom org query error:', error); break; }
              if (batch && batch.length > 0) {
                allRows.push(...batch);
                offset += batch.length;
                hasMore = batch.length === batchSize;
              } else { hasMore = false; }
            }

            const filteredRows = postFilter ? postFilter(allRows) : allRows;
            const allOrgIds = filteredRows.map(r => r.organization_id);

            const condSet = new Set(allOrgIds);
            if (cond.operator === 'is_empty') {
              let allOrgsQuery = supabase
                .from('organization')
                .select('id')
                .eq('tenant_id', tenantId);
              const allOrgs = [];
              let oOffset = 0;
              let oHasMore = true;
              while (oHasMore) {
                const { data: oBatch } = await allOrgsQuery.range(oOffset, oOffset + batchSize - 1);
                if (oBatch && oBatch.length > 0) {
                  allOrgs.push(...oBatch.map(r => r.id));
                  oOffset += oBatch.length;
                  oHasMore = oBatch.length === batchSize;
                } else { oHasMore = false; }
              }
              const hasValueSet = new Set();
              let hvQuery = supabase
                .from('organization_preference_value')
                .select('organization_id')
                .eq('field_id', cond.field_key)
                .not('value', 'is', null)
                .neq('value', '')
                .neq('value', '[]');
              let hvOffset = 0;
              let hvHasMore = true;
              while (hvHasMore) {
                const { data: hvBatch } = await hvQuery.range(hvOffset, hvOffset + batchSize - 1);
                if (hvBatch && hvBatch.length > 0) {
                  hvBatch.forEach(r => hasValueSet.add(r.organization_id));
                  hvOffset += hvBatch.length;
                  hvHasMore = hvBatch.length === batchSize;
                } else { hvHasMore = false; }
              }
              const emptySet = new Set(allOrgs.filter(id => !hasValueSet.has(id)));
              matchedOrgIds = matchedOrgIds ? new Set([...matchedOrgIds].filter(id => emptySet.has(id))) : emptySet;
            } else {
              matchedOrgIds = matchedOrgIds ? new Set([...matchedOrgIds].filter(id => condSet.has(id))) : condSet;
            }
          }

          if (matchedOrgIds && matchedOrgIds.size > 0) {
            const orgIdArr = [...matchedOrgIds];
            const orgMemberIds = new Set();
            const idBatchSize = 500;
            for (let i = 0; i < orgIdArr.length; i += idBatchSize) {
              const idBatch = orgIdArr.slice(i, i + idBatchSize);
              const { data: members } = await supabase
                .from('member')
                .select('id')
                .eq('tenant_id', tenantId)
                .in('organization_id', idBatch)
                .not('email', 'ilike', 'deleted_%@deleted.local');
              if (members) members.forEach(m => orgMemberIds.add(m.id));
            }
            memberIds = memberIds ? new Set([...memberIds].filter(id => orgMemberIds.has(id))) : orgMemberIds;
          } else if (matchedOrgIds && matchedOrgIds.size === 0) {
            memberIds = new Set();
          }
        }

        if (eventConditions.length > 0) {
          let eventMatchedIds = null;
          let allTenantMemberIds = null;

          const fetchAllTenantMemberIds = async () => {
            if (allTenantMemberIds) return allTenantMemberIds;
            const ids = new Set();
            const pageSize = 1000;
            let offset = 0;
            let hasMore = true;
            while (hasMore) {
              const { data: batch, error } = await supabase
                .from('member')
                .select('id')
                .eq('tenant_id', tenantId)
                .not('email', 'ilike', 'deleted_%@deleted.local')
                .range(offset, offset + pageSize - 1);
              if (error) { console.error('[FieldFilter] all-members query error:', error); break; }
              if (batch && batch.length > 0) {
                batch.forEach(r => ids.add(r.id));
                offset += batch.length;
                hasMore = batch.length === pageSize;
              } else { hasMore = false; }
            }
            allTenantMemberIds = ids;
            return ids;
          };

          const collectAttendeeIds = async (eventIds) => {
            const ids = new Set();
            if (!Array.isArray(eventIds) || eventIds.length === 0) return ids;
            const attendeeEmails = new Map(); // emailKey -> original email
            const fallbackBookerIds = new Set();
            for (const table of ['booking', 'complex_event_booking']) {
              const idBatchSize = 200;
              for (let i = 0; i < eventIds.length; i += idBatchSize) {
                const idBatch = eventIds.slice(i, i + idBatchSize);
                let offset = 0;
                const pageSize = 1000;
                let hasMore = true;
                while (hasMore) {
                  const { data, error } = await supabase
                    .from(table)
                    .select('attendee_email, member_id')
                    .eq('tenant_id', tenantId)
                    .eq('status', 'confirmed')
                    .in('event_id', idBatch)
                    .range(offset, offset + pageSize - 1);
                  if (error) {
                    console.error(`[FieldFilter] ${table} event-attendee query error:`, error);
                    break;
                  }
                  if (data && data.length > 0) {
                    for (const row of data) {
                      const email = (row.attendee_email || '').trim();
                      if (email) {
                        attendeeEmails.set(email.toLowerCase(), email);
                      } else if (row.member_id) {
                        fallbackBookerIds.add(row.member_id);
                      }
                    }
                    offset += data.length;
                    hasMore = data.length === pageSize;
                  } else { hasMore = false; }
                }
              }
            }
            // Legacy rows with no attendee_email fall back to the booker member.
            for (const id of fallbackBookerIds) ids.add(id);
            // Resolve attendee emails to member IDs; guests with no member row are
            // naturally excluded (this filter operates in a member-scope context).
            const emailArr = [...attendeeEmails.values()];
            const emailBatchSize = 200;
            for (let i = 0; i < emailArr.length; i += emailBatchSize) {
              const batch = emailArr.slice(i, i + emailBatchSize);
              const { data: members, error } = await supabase
                .from('member')
                .select('id, email')
                .eq('tenant_id', tenantId)
                .or(buildEmailCaseInsensitiveOr(batch));
              if (error) {
                console.error('[FieldFilter] attendee-email member lookup error:', error);
                continue;
              }
              if (members) members.forEach((m) => ids.add(m.id));
            }
            return ids;
          };

          for (const cond of eventConditions) {
            const eventIds = Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : []);
            if (eventIds.length === 0) continue;
            const attendeeIds = await collectAttendeeIds(eventIds);
            let condSet;
            if (cond.operator === 'is_one_of') {
              condSet = attendeeIds;
            } else {
              const all = await fetchAllTenantMemberIds();
              condSet = new Set([...all].filter(id => !attendeeIds.has(id)));
            }
            eventMatchedIds = eventMatchedIds
              ? new Set([...eventMatchedIds].filter(id => condSet.has(id)))
              : condSet;
          }

          if (eventMatchedIds !== null) {
            memberIds = memberIds !== null
              ? new Set([...memberIds].filter(id => eventMatchedIds.has(id)))
              : eventMatchedIds;
          }
        }

        if (memberIds !== null) {
          groupMemberSets.push(memberIds);
        }
      }

      if (groupMemberSets.length > 0) {
        const unionIds = new Set();
        for (const s of groupMemberSets) {
          for (const id of s) unionIds.add(id);
        }

        if (unionIds.size > 0) {
          const idArr = [...unionIds];
          const idBatchSize = 500;
          for (let i = 0; i < idArr.length; i += idBatchSize) {
            const idBatch = idArr.slice(i, i + idBatchSize);
            const { data: members } = await supabase
              .from('member')
              .select('id, email, first_name, last_name, communications_opted_out_all')
              .eq('tenant_id', tenantId)
              .in('id', idBatch)
              .not('email', 'ilike', 'deleted_%@deleted.local');
            if (members) recipients.push(...members.filter(m => m.email));
          }
        }
      }
    }
  }

  return recipients;
}

// Builds a PostgREST `.or()` clause that matches the `email` column
// case-insensitively against an exact list of emails. Like-wildcards (% _ \)
// and or-reserved chars (\ ( ) , ") are escaped so each entry behaves as an
// exact (case-insensitive) equality rather than a pattern.
function buildEmailCaseInsensitiveOr(emails) {
  const escapeLike = (s) => String(s).replace(/([%_\\])/g, '\\$1');
  const escapeOr = (s) => String(s).replace(/([\\(),"])/g, '\\$1');
  return emails
    .map((e) => `email.ilike."${escapeOr(escapeLike(e))}"`)
    .join(',');
}

function applyConditionToQuery(query, fieldKey, operator, value, dataType) {
  switch (operator) {
    case 'equals':
      return query.eq(fieldKey, value);
    case 'not_equals':
      return query.neq(fieldKey, value);
    case 'contains':
      return query.ilike(fieldKey, `%${value}%`);
    case 'is_empty':
      return query.or(`${fieldKey}.is.null,${fieldKey}.eq.`);
    case 'is_not_empty':
      return query.not(fieldKey, 'is', null).neq(fieldKey, '');
    case 'is_true':
      return query.eq(fieldKey, true);
    case 'is_false':
      return query.eq(fieldKey, false);
    case 'greater_than':
      return query.gt(fieldKey, value);
    case 'less_than':
      return query.lt(fieldKey, value);
    case 'before':
      return query.lt(fieldKey, value);
    case 'after':
      return query.gt(fieldKey, value);
    case 'is_one_of':
      if (Array.isArray(value)) {
        return query.in(fieldKey, value);
      }
      return query.eq(fieldKey, value);
    default:
      return query.eq(fieldKey, value);
  }
}

function applyPrefValueCondition(query, operator, value, dataType) {
  const isNumericType = dataType === 'number' || dataType === 'decimal';
  const isMultiSelectType = dataType === 'list' || dataType === 'multiselect' || dataType === 'multi_select' || dataType === 'countries' || dataType === 'country';
  switch (operator) {
    case 'equals':
      return { query: query.eq('value', String(value)), postFilter: null };
    case 'not_equals':
      return { query: query.neq('value', String(value)), postFilter: null };
    case 'contains':
      if (isMultiSelectType && Array.isArray(value) && value.length > 0) {
        const escapeLike = (s) => String(s).replace(/([%_\\])/g, '\\$1');
        const escapeOr = (s) => String(s).replace(/([\\(),"])/g, '\\$1');
        const orClause = value
          .map(v => `value.ilike."%\\"${escapeOr(escapeLike(v))}\\"%"`)
          .join(',');
        return { query: query.or(orClause), postFilter: null };
      }
      if (isMultiSelectType && value) {
        const escapeLike = (s) => String(s).replace(/([%_\\])/g, '\\$1');
        return { query: query.ilike('value', `%"${escapeLike(value)}"%`), postFilter: null };
      }
      return { query: query.ilike('value', `%${value}%`), postFilter: null };
    case 'is_not_empty':
      return { query: query.not('value', 'is', null).neq('value', '').neq('value', '[]'), postFilter: null };
    case 'is_true':
      return { query: query.eq('value', 'true'), postFilter: null };
    case 'is_false':
      return { query: query.or('value.eq.false,value.eq.,value.is.null'), postFilter: null };
    case 'greater_than':
      if (isNumericType) {
        const numVal = Number(value);
        return { query: query.not('value', 'is', null).neq('value', ''), postFilter: (rows) => rows.filter(r => { const n = parseFloat(r.value); return !isNaN(n) && n > numVal; }) };
      }
      return { query: query.gt('value', String(value)), postFilter: null };
    case 'less_than':
      if (isNumericType) {
        const numVal = Number(value);
        return { query: query.not('value', 'is', null).neq('value', ''), postFilter: (rows) => rows.filter(r => { const n = parseFloat(r.value); return !isNaN(n) && n < numVal; }) };
      }
      return { query: query.lt('value', String(value)), postFilter: null };
    case 'before':
      return { query: query.lt('value', String(value)), postFilter: null };
    case 'after':
      return { query: query.gt('value', String(value)), postFilter: null };
    case 'is_one_of':
      if (Array.isArray(value)) {
        return { query: query.in('value', value.map(String)), postFilter: null };
      }
      return { query: query.eq('value', String(value)), postFilter: null };
    case 'is_empty':
      return { query, postFilter: null };
    default:
      return { query: query.eq('value', String(value)), postFilter: null };
  }
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
        const segRecipients = await getRecipientsForSegment(segment.type, segment.ids || [], tenantId, segment);
        allRecipients.push(...segRecipients);
      }
    } else {
      const segRecipients = await getRecipientsForSegment(campaign.target_type, campaign.target_ids || [], tenantId);
      allRecipients.push(...segRecipients);
    }

    const deletedPattern = /^deleted_.*@deleted\.local$/i;
    allRecipients = allRecipients.filter(r => !deletedPattern.test(r.email));

    // If the campaign / audience list is configured to ignore opt-outs, mark
    // every resolved recipient so the suppression steps below skip them.
    if (campaign.ignore_opt_outs === true) {
      for (const r of allRecipients) r.bypass_opt_out = true;
    }

    const totalAudience = allRecipients.length;
    const rawAudienceList = detailedLists ? allRecipients.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })) : null;

    // Step 1: Remove members with global opt-out (communications_opted_out_all flag)
    // Recipients carrying bypass_opt_out (from an "ignore opt-outs" audience list)
    // are exempt from every opt-out suppression step below.
    const beforeGlobal = allRecipients.length;
    const globalFlagRemoved = detailedLists ? allRecipients.filter(r => r.bypass_opt_out !== true && r.communications_opted_out_all === true) : [];
    allRecipients = allRecipients.filter(r => r.bypass_opt_out === true || r.communications_opted_out_all !== true);

    // Step 1b: Remove emails with global unsubscribe record
    const { data: globalUnsubscribes } = await supabase
      .from('email_unsubscribe')
      .select('email')
      .eq('tenant_id', tenantId)
      .eq('unsubscribe_type', 'all');

    const globalUnsubSet = new Set((globalUnsubscribes || []).map(u => u.email.toLowerCase()));
    const globalEmailRemoved = detailedLists ? allRecipients.filter(r => r.bypass_opt_out !== true && globalUnsubSet.has(r.email.toLowerCase())) : [];
    allRecipients = allRecipients.filter(r => r.bypass_opt_out === true || !globalUnsubSet.has(r.email.toLowerCase()));
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
            if (r.bypass_opt_out === true) return false;
            const memberId = resolveMemberId(r);
            return memberId && !subscribedMemberIds.has(memberId);
          });
          categoryOptOutList.push(...catMemberRemoved.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })));
        }

        allRecipients = allRecipients.filter(r => {
          if (r.bypass_opt_out === true) return true;
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
          const catEmailRemoved = allRecipients.filter(r => r.bypass_opt_out !== true && categoryUnsubSet.has(r.email.toLowerCase()));
          categoryOptOutList.push(...catEmailRemoved.map(r => ({ email: r.email, first_name: r.first_name, last_name: r.last_name })));
        }
        allRecipients = allRecipients.filter(r => r.bypass_opt_out === true || !categoryUnsubSet.has(r.email.toLowerCase()));
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

// Pure decision predicate for processSendingCampaigns(). Extracted so it can
// be unit-tested without a database. Returns true ONLY when it is safe to
// flip a 'sending' campaign to 'sent'. The race fix is the `anyRowCount === 0`
// branch: a campaign with no recipient rows at all is mid-insert, not done.
export function shouldMarkCampaignSent({ pendingCount, processingCount, anyRowCount }) {
  if ((pendingCount || 0) > 0) return false;
  if ((processingCount || 0) > 0) return false;
  if (!anyRowCount || anyRowCount === 0) return false;
  return true;
}

// Recovery for the interim 'preparing' status used by sendCampaign() to
// avoid the race with the cron worker. Normally a campaign sits in
// 'preparing' for only a few seconds (audience resolution + recipient row
// insert). If something interrupts that work (Vercel function timeout,
// hard crash, etc.), the campaign would otherwise be stuck. We sweep for
// 'preparing' campaigns older than the threshold and either:
//   - promote to 'sending' if recipient rows already exist (rows inserted
//     but the status flip never ran), or
//   - mark 'failed' if no rows exist (interrupted before insert).
async function recoverStuckPreparingCampaigns() {
  const STALE_PREPARING_MS = 5 * 60 * 1000; // 5 minutes
  const cutoffIso = new Date(Date.now() - STALE_PREPARING_MS).toISOString();

  const { data: stuck, error } = await supabase
    .from('email_campaign')
    .select('id, tenant_id, name, updated_at')
    .eq('status', 'preparing')
    .lt('updated_at', cutoffIso);

  if (error) {
    console.warn('[Campaign Service] recoverStuckPreparingCampaigns failed to fetch:', error.message);
    return;
  }

  if (!stuck || stuck.length === 0) return;

  for (const c of stuck) {
    const { count: rowCount } = await supabase
      .from('email_campaign_recipient')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', c.id);

    if (rowCount && rowCount > 0) {
      console.warn(`[Campaign Service] Recovering stuck 'preparing' campaign ${c.id} (${c.name}) — ${rowCount} recipient rows already inserted, promoting to 'sending'`);
      await updateCampaign(c.id, { status: 'sending' }, c.tenant_id).catch(err => {
        console.error(`[Campaign Service] Failed to promote stuck preparing campaign ${c.id}:`, err.message);
      });
    } else {
      console.warn(`[Campaign Service] Recovering stuck 'preparing' campaign ${c.id} (${c.name}) — no recipient rows, marking 'failed'`);
      await updateCampaign(c.id, { status: 'failed' }, c.tenant_id).catch(err => {
        console.error(`[Campaign Service] Failed to mark stuck preparing campaign ${c.id} as failed:`, err.message);
      });
    }
  }
}

// IMPORTANT — race-condition fix: this worker MUST NOT mark a campaign as
// 'sent' unless recipient rows actually exist for it. Without that guard, a
// campaign that has just been flipped to status='sending' but is still in
// the middle of resolving its audience (no recipient rows yet) would be
// prematurely marked 'sent', and only the first batch would be delivered.
// See sendCampaign() for the matching protection (interim 'preparing' status).
export async function processSendingCampaigns() {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    // Recovery sweep: any campaign stuck in the interim 'preparing' state
    // for too long without recipient rows is a victim of an interrupted
    // send (e.g. function timeout / hard crash). Mark it 'failed' so the
    // user can retry. If rows DO exist (insert succeeded but the status
    // update did not), promote it to 'sending' so this worker can finish.
    await recoverStuckPreparingCampaigns();

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
        // Race-condition guard: refuse to mark sent if NO recipient rows
        // exist at all for this campaign id. That state means another
        // worker (or sendCampaign itself) is still in the middle of
        // inserting recipients — completing here would orphan all of them.
        const { count: anyRowCount } = await supabase
          .from('email_campaign_recipient')
          .select('*', { count: 'exact', head: true })
          .eq('campaign_id', sc.id);

        if (!shouldMarkCampaignSent({
          pendingCount: pendingCount || 0,
          processingCount: processingCount || 0,
          anyRowCount: anyRowCount || 0,
        })) {
          console.warn(`[Campaign Service] Campaign ${sc.id} (${sc.name}) is in 'sending' but has zero recipient rows — skipping (likely mid-insert by another worker)`);
          results.push({ campaignId: sc.id, name: sc.name, status: 'skipped', reason: 'no_recipient_rows' });
          continue;
        }

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

// Replace Dynamic Text slot tokens ({{dynamic_N}}) with the single per-send
// values captured when the campaign was composed. Slot values are the same for
// every recipient (one value per send, not per-recipient). Missing values
// resolve to an empty string so no raw {{dynamic_N}} token leaks.
// Escape a plain-text slot value for safe injection into HTML, converting
// newlines to <br> so multi-line values keep their line breaks.
export function encodeSlotValueForHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

// Replace {{token}} placeholders with per-send slot values.
// Pass { html: true } when filling an HTML body: plain-text values are
// HTML-escaped and newlines become <br>. Leave it off for subjects/plain text
// (no tags injected).
// Pass { richSlots: [tokens...] } (from design_json.richSlots) to mark slots
// whose value is rich HTML from the TipTap slot editor: in html mode those are
// injected as sanitized HTML instead of being escaped; in subject/plain mode
// they are flattened to plain text so no markup ever reaches a subject.
export function applyDynamicSlotValues(html, slotValues, options = {}) {
  if (!html || !slotValues || typeof slotValues !== 'object') return html;
  const asHtml = !!options.html;
  const richSet = new Set(Array.isArray(options.richSlots) ? options.richSlots.filter((t) => typeof t === 'string') : []);
  let out = html;
  for (const [token, value] of Object.entries(slotValues)) {
    if (!token) continue;
    const re = new RegExp(`\\{\\{\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
    const raw = value == null ? '' : String(value);
    let replacement;
    if (richSet.has(token)) {
      replacement = asHtml ? sanitizeSlotHtml(raw) : htmlSlotToPlainText(raw);
    } else {
      replacement = asHtml ? encodeSlotValueForHtml(raw) : raw;
    }
    // Function replacer so '$' sequences in values are inserted literally.
    out = out.replace(re, () => replacement);
  }
  return out;
}

function parseCampaignDesign(campaign) {
  let skipFooter = false;
  let hasUnsubscribeBlock = false;
  let contentWidth = null;
  let slotValues = null;
  let hiddenSlots = null;
  let richSlots = null;
  if (campaign.design_json) {
    try {
      const designData = typeof campaign.design_json === 'string' ? JSON.parse(campaign.design_json) : campaign.design_json;
      if (designData?.globalStyles?.contentWidth) {
        contentWidth = designData.globalStyles.contentWidth;
      }
      if (designData?.slotValues && typeof designData.slotValues === 'object') {
        slotValues = designData.slotValues;
      }
      if (Array.isArray(designData?.hiddenSlots) && designData.hiddenSlots.length > 0) {
        hiddenSlots = designData.hiddenSlots.filter((t) => typeof t === 'string');
      }
      if (Array.isArray(designData?.richSlots) && designData.richSlots.length > 0) {
        richSlots = designData.richSlots.filter((t) => typeof t === 'string');
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
    // Skip the tenant footer only when the design already contains its own
    // unsubscribe/footer block — not just because design_json is present.
    // This ensures Visual Builder campaigns (including member-group campaigns,
    // which are required to use the builder) receive the tenant footer.
    skipFooter = hasUnsubscribeBlock;
  }
  return { skipFooter, hasUnsubscribeBlock, contentWidth, slotValues, hiddenSlots, richSlots };
}

const EVENT_QR_BLOCK_RE = /<!--\s*EVENT_QR_BLOCK:START\s*-->[\s\S]*?<!--\s*EVENT_QR_BLOCK:END\s*-->/gi;

// Matches a single DYN_BLOCK region for a specific token, including the markers.
function dynBlockRegionRe(token) {
  const safe = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!--\\s*DYN_BLOCK:START:${safe}\\s*-->[\\s\\S]*?<!--\\s*DYN_BLOCK:END:${safe}\\s*-->`, 'gi');
}

// Strip any DYN_BLOCK START/END marker comments left in the html (for the
// dynamic elements that were NOT hidden, the markers are just noise to remove).
const DYN_BLOCK_MARKER_RE = /<!--\s*DYN_BLOCK:(START|END):[^>]*?-->/gi;

// Remove the hidden dynamic regions entirely, then clean up the remaining
// (non-hidden) markers so they never appear in the delivered email.
export function stripHiddenDynamicRegions(html, hiddenSlots) {
  if (!html) return html;
  let out = html;
  if (Array.isArray(hiddenSlots)) {
    for (const token of hiddenSlots) {
      if (typeof token === 'string' && token) {
        out = out.replace(dynBlockRegionRe(token), '');
      }
    }
  }
  out = out.replace(DYN_BLOCK_MARKER_RE, '');
  return out;
}

function buildQrReqFromHost(requestHost) {
  if (!requestHost) return null;
  const host = String(requestHost).split(',')[0].trim();
  if (!host) return null;
  return { headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } };
}

// Resolve the event ids a campaign's QR block should be scoped to. Returns an
// array of event ids when the campaign targets event-attendees (directly or via
// an audience_list whose saved segments are event_attendees), or null when no
// event scope can be determined (fall back to all the recipient's bookings).
async function resolveCampaignEventScope(campaign, tenantId) {
  // Direct event-attendees targeting.
  if (campaign.target_type === 'event_attendees'
    && Array.isArray(campaign.target_ids) && campaign.target_ids.length > 0) {
    const ids = [...new Set(campaign.target_ids.filter(Boolean))];
    return ids.length > 0 ? ids : null;
  }

  // Audience list whose saved segments include event_attendees.
  if (campaign.target_type === 'audience_list'
    && Array.isArray(campaign.target_ids) && campaign.target_ids.length > 0) {
    try {
      const { data: lists } = await supabase
        .from('audience_list')
        .select('id, target_audiences')
        .eq('tenant_id', tenantId)
        .in('id', campaign.target_ids);
      const eventIds = new Set();
      for (const list of lists || []) {
        const segs = list.target_audiences;
        if (!Array.isArray(segs)) continue;
        for (const seg of segs) {
          if (seg?.type === 'event_attendees' && Array.isArray(seg.ids)) {
            for (const id of seg.ids) if (id) eventIds.add(id);
          }
        }
      }
      if (eventIds.size > 0) return [...eventIds];
    } catch (e) {
      console.warn('[Campaign QR] audience_list event scope failed:', e?.message);
    }
  }

  return null;
}

// Resolve the per-recipient entrance QR image URL for an Event QR block.
// Returns a hosted PNG URL for the first confirmed in-person booking the
// recipient holds, matched by the recipient's email against the booking's
// attendee_email (so the QR is the attendee's own entrance code, not the
// booker's), or null when there is no in-person booking (online events / no
// booking). Works for member and guest attendees alike — matching is driven
// by email, consistent with how the event-attendees audience list is built.
async function resolveEventQrImageUrl(recipient, campaign, tenantId, requestHost) {
  const email = (recipient?.email || '').trim();
  if (!email) return null;
  const escapeLike = (s) => String(s).replace(/([%_\\])/g, '\\$1');
  const emailLike = escapeLike(email);
  const eventIds = await resolveCampaignEventScope(campaign, tenantId);
  const req = buildQrReqFromHost(requestHost);

  // 1. Simple bookings — match by attendee email, one token per booking, skip
  //    online events.
  try {
    let q = supabase
      .from('booking')
      .select('id, event_id, status')
      .eq('tenant_id', tenantId)
      .ilike('attendee_email', emailLike)
      .eq('status', 'confirmed');
    if (eventIds) q = q.in('event_id', eventIds);
    const { data: bookings } = await q;
    if (bookings && bookings.length > 0) {
      const evIds = [...new Set(bookings.map(b => b.event_id).filter(Boolean))];
      const { data: events } = await supabase
        .from('event')
        .select('id, is_online')
        .in('id', evIds);
      const onlineMap = {};
      for (const e of events || []) onlineMap[e.id] = !!e.is_online;
      for (const b of bookings) {
        if (onlineMap[b.event_id]) continue;
        const token = await ensureBookingToken(b.id, tenantId);
        if (token) return buildQrImageUrl(token, req);
      }
    }
  } catch (e) {
    console.warn('[Campaign QR] simple booking lookup failed:', e?.message);
  }

  // 2. Complex bookings — match by attendee email, one token per in-person
  //    session; use the first.
  try {
    let q = supabase
      .from('complex_event_booking')
      .select('id, event_id, ticket_class_id, status, tenant_id')
      .eq('tenant_id', tenantId)
      .ilike('attendee_email', emailLike)
      .eq('status', 'confirmed');
    if (eventIds) q = q.in('event_id', eventIds);
    const { data: cbookings } = await q;
    for (const cb of cbookings || []) {
      const sessions = await ensureComplexSessionTokens(cb, tenantId);
      if (sessions && sessions.length > 0 && sessions[0].token) {
        return buildQrImageUrl(sessions[0].token, req);
      }
    }
  } catch (e) {
    console.warn('[Campaign QR] complex booking lookup failed:', e?.message);
  }

  return null;
}

// Resolve the event ids a campaign's booking tokens should be scoped to. Reuses
// the QR event-scope (event_attendees / audience_list event_attendees segments)
// and additionally resolves event_form targets (and event_form audience
// segments) to their related event, so a booking lookup can be pinned to the
// campaign's event rather than matching any of the recipient's bookings.
async function resolveCampaignBookingEventScope(campaign, tenantId) {
  const scope = await resolveCampaignEventScope(campaign, tenantId);
  if (scope && scope.length > 0) return scope;

  const formIds = new Set();
  if (campaign.target_type === 'event_form'
    && Array.isArray(campaign.target_ids) && campaign.target_ids.length > 0) {
    for (const id of campaign.target_ids) if (id) formIds.add(id);
  } else if (campaign.target_type === 'audience_list'
    && Array.isArray(campaign.target_ids) && campaign.target_ids.length > 0) {
    try {
      const { data: lists } = await supabase
        .from('audience_list')
        .select('id, target_audiences')
        .eq('tenant_id', tenantId)
        .in('id', campaign.target_ids);
      for (const list of lists || []) {
        const segs = list.target_audiences;
        if (!Array.isArray(segs)) continue;
        for (const seg of segs) {
          if (seg?.type === 'event_form' && Array.isArray(seg.ids)) {
            for (const id of seg.ids) if (id) formIds.add(id);
          }
        }
      }
    } catch (e) {
      console.warn('[Campaign Booking] audience_list event_form scope failed:', e?.message);
    }
  }

  if (formIds.size === 0) return null;
  try {
    const { data: forms } = await supabase
      .from('form')
      .select('id, related_event_id')
      .eq('tenant_id', tenantId)
      .in('id', [...formIds]);
    const eventIds = [...new Set((forms || []).map(f => f.related_event_id).filter(Boolean))];
    return eventIds.length > 0 ? eventIds : null;
  } catch (e) {
    console.warn('[Campaign Booking] form->event resolution failed:', e?.message);
    return null;
  }
}

// Resolve the recipient's OWN booking row (attendee-level, unique id) for
// [[booking.*]] token substitution in a campaign send. Matches by the
// recipient's email against attendee_email (so each colleague booked together
// gets their own row, not the booking-group reference), falling back to the
// booker member for legacy bookings with no attendee_email. Scoped to the
// campaign's event(s) when determinable. Returns a normalized booking object
// (the fields replaceBookingPlaceholders consumes) or null when none matches.
async function resolveRecipientBooking(recipient, campaign, tenantId) {
  const email = (recipient?.email || '').trim();
  const memberId = recipient?.member_id || null;
  if (!email && !memberId) return null;

  const escapeLike = (s) => String(s).replace(/([%_\\])/g, '\\$1');
  const eventIds = await resolveCampaignBookingEventScope(campaign, tenantId);

  const normalize = (row, totalKey) => ({
    id: row.id,
    booking_reference: row.booking_reference,
    ticket_class_name: row.ticket_class_name,
    ticket_price: row.ticket_price,
    total_cost: row[totalKey],
  });

  const lookup = async (table, totalKey) => {
    const sel = `id, booking_reference, ticket_class_name, ticket_price, ${totalKey}, attendee_email, member_id, created_at`;
    // Attendee-level match: the recipient is the attendee.
    if (email) {
      let q = supabase
        .from(table)
        .select(sel)
        .eq('tenant_id', tenantId)
        .ilike('attendee_email', escapeLike(email))
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(1);
      if (eventIds) q = q.in('event_id', eventIds);
      const { data } = await q;
      if (data && data.length > 0) return normalize(data[0], totalKey);
    }
    // Booker fallback: legacy booking with no attendee_email, keyed by booker.
    if (memberId) {
      let q = supabase
        .from(table)
        .select(sel)
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(50);
      if (eventIds) q = q.in('event_id', eventIds);
      const { data } = await q;
      const row = (data || []).find(r => !(r.attendee_email || '').trim());
      if (row) return normalize(row, totalKey);
    }
    return null;
  };

  try {
    const simple = await lookup('booking', 'total_cost');
    if (simple) return simple;
  } catch (e) {
    console.warn('[Campaign Booking] simple booking lookup failed:', e?.message);
  }
  try {
    const complex = await lookup('complex_event_booking', 'total_paid');
    if (complex) return complex;
  } catch (e) {
    console.warn('[Campaign Booking] complex booking lookup failed:', e?.message);
  }

  return null;
}

async function sendToRecipient(recipient, campaign, tenantId, tenantSlug, requestHost, designInfo) {
  try {
    let html = campaign.html_content || '';
    let subject = campaign.subject || '';

    // Hidden dynamic elements: remove their whole DYN_BLOCK region (and clean up
    // the remaining non-hidden markers) BEFORE filling in slot values, so a
    // hidden element never appears — and its tokens never resolve — in the send.
    html = stripHiddenDynamicRegions(html, designInfo?.hiddenSlots);

    // Dynamic Text slots: single per-send values, identical for every recipient.
    // Resolve before any per-recipient placeholder substitution.
    if (designInfo?.slotValues) {
      html = applyDynamicSlotValues(html, designInfo.slotValues, { html: true, richSlots: designInfo.richSlots });
      subject = applyDynamicSlotValues(subject, designInfo.slotValues, { richSlots: designInfo.richSlots });
    }

    const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || '';
    html = html.replace(/\{\{recipient_name\}\}/gi, recipientName);
    html = html.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');
    html = html.replace(/\{\{last_name\}\}/gi, recipient.last_name || '');
    html = html.replace(/\{\{email\}\}/gi, recipient.email || '');
    subject = subject.replace(/\{\{recipient_name\}\}/gi, recipientName);
    subject = subject.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');

    // Event QR block: resolve a per-recipient entrance QR image, or strip the
    // block entirely when the recipient has no in-person booking (online
    // events / no booking → nothing rendered).
    if (html.includes('EVENT_QR_BLOCK') || html.includes('{{event_qr_image_url}}')) {
      let qrUrl = null;
      try {
        qrUrl = await resolveEventQrImageUrl(recipient, campaign, tenantId, requestHost);
      } catch (qrErr) {
        console.warn('[Campaign QR] resolution failed for recipient', recipient.id, qrErr?.message);
      }
      if (qrUrl) {
        html = html.replace(/\{\{event_qr_image_url\}\}/gi, qrUrl);
        html = html.replace(/<!--\s*EVENT_QR_BLOCK:(START|END)\s*-->/gi, '');
      } else {
        html = html.replace(EVENT_QR_BLOCK_RE, '');
        html = html.replace(/<img[^>]*\{\{event_qr_image_url\}\}[^>]*>/gi, '');
        html = html.replace(/\{\{event_qr_image_url\}\}/gi, '');
      }
    }

    // Build the campaign-specific tracking token + preference/unsubscribe
    // links FIRST and substitute them BEFORE the generic placeholder helper
    // runs. The generic helper would otherwise resolve
    // {{communication_preferences_*}} via the per-member preference URL
    // (which lacks campaign tracking), losing the per-send tracking token.
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

    // Resolve [[member.*]] / [[organization.*]] tokens for this recipient.
    // {{set_password_url}} is intentionally not minted in bulk campaigns
    // (see docs/email-placeholder-audit.md caveats).
    let recipientOrg = null;
    if (recipient.member_id) {
      try {
        const { data: memberRow } = await supabase
          .from('member')
          .select('organization_id, organization:organization_id(id,name,phone,invoicing_email)')
          .eq('id', recipient.member_id)
          .maybeSingle();
        if (memberRow?.organization) recipientOrg = memberRow.organization;
      } catch (orgErr) {
        console.warn('[Campaign] organization enrichment failed for recipient', recipient.id, orgErr?.message);
      }
    }
    const memberLikeRecipient = {
      id: recipient.member_id || '',
      first_name: recipient.first_name || '',
      last_name: recipient.last_name || '',
      full_name: `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim(),
      email: recipient.email || '',
      organization_id: recipientOrg?.id || null,
      organization: recipientOrg || null,
    };
    const placeholderContext = {
      tenantId,
      memberId: recipient.member_id || null,
      organizationId: recipientOrg?.id || null,
      tenantBaseUrl,
    };
    html = replacePlaceholders(html, 'member', memberLikeRecipient, placeholderContext);
    subject = replacePlaceholders(subject, 'member', memberLikeRecipient, placeholderContext);
    if (recipientOrg) {
      html = replacePlaceholders(html, 'organization', recipientOrg, placeholderContext);
      subject = replacePlaceholders(subject, 'organization', recipientOrg, placeholderContext);
    }

    // Resolve [[booking.*]] tokens against the recipient's own booking row.
    // Must run BEFORE rewriteLinksForTracking so a resolved id ends up inside
    // the tracked URL. When the recipient has no matching booking the tokens
    // resolve to empty (an empty booking object), matching how other unmatched
    // placeholders behave rather than leaking the raw [[booking.id]] text.
    if (/\[\[booking\.|\{\{booking_/i.test(html) || /\[\[booking\.|\{\{booking_/i.test(subject)) {
      let booking = null;
      try {
        booking = await resolveRecipientBooking(recipient, campaign, tenantId);
      } catch (bookingErr) {
        console.warn('[Campaign] booking resolution failed for recipient', recipient.id, bookingErr?.message);
      }
      html = replaceBookingPlaceholders(html, booking || {});
      subject = replaceBookingPlaceholders(subject, booking || {});
    }

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

export async function sendBatch(campaignId, tenantId, campaign, tenantSlug, requestHost, batchSize = BATCH_SIZE) {
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

// IMPORTANT — race-condition fix history:
// Previously sendCampaign() flipped the campaign to status='sending' BEFORE
// resolving the audience and inserting recipient rows. For large audiences
// (e.g. 4k+ members) recipient resolution takes several seconds, leaving a
// window where the every-minute cron worker (processSendingCampaigns) would
// see status='sending' with zero pending/processing recipient rows and
// prematurely mark the campaign as 'sent'. Only the first batch of 100 was
// ever delivered. To prevent this we now:
//   1) Use an interim status='preparing' while resolving + inserting rows,
//      so the cron (which only looks at status='sending') cannot see the
//      campaign during the dangerous window.
//   2) Only flip 'preparing' → 'sending' AFTER recipient rows are inserted.
//   3) processSendingCampaigns() additionally refuses to mark a campaign
//      'sent' if no recipient rows exist at all for that campaign id.
// Do not undo either of these protections without replacing them with an
// equivalent guard.
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

    // Atomic claim into the interim 'preparing' status. This prevents
    // double-send (a second caller will fail the .in() filter) AND keeps
    // the campaign invisible to the cron until recipients are inserted.
    const { data: claimedCampaign, error: claimError } = await supabase
      .from('email_campaign')
      .update({
        status: 'preparing',
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

    // Plan quota enforcement (Task #1026). Centralised here so both
    // immediate sends AND scheduled sends executed by the cron go through
    // the same gate. Fails closed: if usage cannot be computed the helper
    // returns ok:false with a 503-shaped body and we abort the send.
    const quotaCheck = await checkEmailQuota(tenantId, { addingCount: recipients.length });
    if (!quotaCheck.ok) {
      await updateCampaign(campaignId, { status: 'draft' }, tenantId).catch(() => {});
      console.warn(`[Campaign Service] Plan quota blocked send for campaign ${campaignId}:`, quotaCheck.body?.code);
      return { success: false, error: quotaCheck.body?.error || 'Plan email quota exceeded', quota: quotaCheck.body?.quota };
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

    // Only NOW that recipient rows are durably inserted, flip from
    // 'preparing' to 'sending' so the cron worker can safely take over
    // if this request times out.
    await updateCampaign(campaignId, { status: 'sending' }, tenantId);

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

import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { loadMemberCommunicationCategoryEligibility } from '../_lib/communicationCategoryEligibility.js';

export default async function handler(req, res) {
  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  try {
    const sessionMember = await getSessionMember(req);
    if (!sessionMember?.id || !sessionMember?.tenant_id) {
      return res.status(401).json({ error: 'Member sign-in required' });
    }

    const eligibility = await loadMemberCommunicationCategoryEligibility(supabase, {
      tenantId: sessionMember.tenant_id,
      memberId: sessionMember.id,
    });
    if (!eligibility) {
      return res.status(401).json({ error: 'Member sign-in required' });
    }

    const { data: preferences, error: preferenceError } = await supabase
      .from('member_communication_preference')
      .select('id, category_id, is_subscribed')
      .eq('tenant_id', sessionMember.tenant_id)
      .eq('member_id', sessionMember.id);
    if (preferenceError) throw preferenceError;

    if (req.method === 'GET') {
      return res.json({
        optedOutAll: eligibility.member.communications_opted_out_all === true,
        categories: eligibility.eligibleCategories.map((category) => ({
          ...category,
          isSubscribed: preferences?.find((pref) => pref.category_id === category.id)?.is_subscribed === true,
        })),
      });
    }

    const { action, categoryId, isSubscribed, optOutAll } = req.body || {};
    if (action === 'toggle_all') {
      if (typeof optOutAll !== 'boolean') {
        return res.status(400).json({ error: 'An opt-out state is required' });
      }
      const { error: globalError } = await supabase.rpc('set_email_preference_global_state', {
        p_tenant_id: sessionMember.tenant_id,
        p_email: eligibility.member.email,
        p_member_id: sessionMember.id,
        p_opt_out_all: optOutAll,
        p_campaign_id: null,
        p_category_ids: eligibility.eligibleCategories.map((category) => category.id),
      });
      if (globalError) throw globalError;
      return res.json({ success: true, optedOutAll: optOutAll });
    }

    if (!categoryId || typeof isSubscribed !== 'boolean') {
      return res.status(400).json({ error: 'Category and subscription state are required' });
    }

    const categoryExists = eligibility.allCategories.some((category) => category.id === categoryId);
    if (!categoryExists) {
      return res.status(404).json({ error: 'Communication category not found' });
    }
    if (isSubscribed && !eligibility.eligibleCategoryIds.has(categoryId)) {
      return res.status(403).json({ error: 'This communication category is not available for your role' });
    }

    const existing = preferences?.find((pref) => pref.category_id === categoryId);
    if (!isSubscribed && !existing) {
      return res.json({ success: true, categoryId, isSubscribed: false });
    }

    const { error: updateError } = await supabase
      .from('member_communication_preference')
      .upsert({
        tenant_id: sessionMember.tenant_id,
        member_id: sessionMember.id,
        category_id: categoryId,
        is_subscribed: isSubscribed,
      }, { onConflict: 'member_id,category_id' });
    if (updateError) throw updateError;

    return res.json({ success: true, categoryId, isSubscribed });
  } catch (error) {
    console.error('[Member Communication Preferences] Error:', error);
    return res.status(500).json({ error: 'Failed to update communication preferences' });
  }
}
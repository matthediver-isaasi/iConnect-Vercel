import { supabase } from '../../../../_lib/database.js';
import { authorizeCommunicationPreferencesAdmin } from '../../../../_lib/adminCommunicationPreferences.js';
import { loadMemberCommunicationCategoryEligibility } from '../../../../_lib/communicationCategoryEligibility.js';

export async function handleAdminCommunicationPreferenceUpdate(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  const loadEligibility = dependencies.loadMemberCommunicationCategoryEligibility
    || loadMemberCommunicationCategoryEligibility;

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!database) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { memberId, categoryId } = req.query;

  try {
    const authorization = await authorizeCommunicationPreferencesAdmin(req, dependencies);
    if (authorization.error) {
      return res.status(authorization.status).json({ error: authorization.error });
    }
    const tenantId = authorization.context.tenantId;
    const eligibility = await loadEligibility(database, {
      tenantId,
      memberId,
      activeOnly: false,
    });
    if (!eligibility) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (!eligibility.allCategories.some((category) => category.id === categoryId)) {
      return res.status(404).json({ error: 'Communication category not found' });
    }

    const { is_subscribed } = req.body;

    if (typeof is_subscribed !== 'boolean') {
      return res.status(400).json({ error: 'is_subscribed must be a boolean' });
    }
    if (is_subscribed && !eligibility.eligibleCategoryIds.has(categoryId)) {
      return res.status(403).json({ error: 'This communication category is not available for the member role' });
    }

    const { data: existingPref } = await database
      .from('member_communication_preference')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('category_id', categoryId)
      .single();

    if (existingPref) {
      const { data, error: updateError } = await database
        .from('member_communication_preference')
        .update({ 
          is_subscribed,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingPref.id)
        .select()
        .single();

      if (updateError) {
        console.error('[Admin Update Comm Pref] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      return res.json(data);
    } else {
      const { data, error: insertError } = await database
        .from('member_communication_preference')
        .insert({
          member_id: memberId,
          category_id: categoryId,
          is_subscribed,
          tenant_id: tenantId
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Admin Create Comm Pref] Error:', insertError);
        return res.status(500).json({ error: insertError.message });
      }

      return res.json(data);
    }
  } catch (error) {
    console.error('[Admin Comm Pref] Error:', error);
    return res.status(500).json({ error: 'Failed to update communication preference' });
  }
}

export default function handler(req, res) {
  return handleAdminCommunicationPreferenceUpdate(req, res);
}

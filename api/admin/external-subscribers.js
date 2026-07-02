import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);

  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!tenantCtx.tenantId) {
    return res.status(400).json({ error: 'Tenant context not available' });
  }

  const tenantId = tenantCtx.tenantId;

  try {
    if (req.method === 'GET') {
      const { category_id, page = 1, per_page = 20 } = req.query;

      if (category_id) {
        const offset = (parseInt(page) - 1) * parseInt(per_page);
        const limit = parseInt(per_page);

        const { data: subscribers, error: subError } = await supabase
          .from('email_subscriber')
          .select('id, email, first_name, last_name, subscribed_at, opted_out, form_id')
          .eq('tenant_id', tenantId)
          .eq('communication_category_id', category_id)
          .eq('opted_out', false)
          .order('subscribed_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (subError) {
          console.error('[External Subscribers] Error fetching subscribers:', subError);
          return res.status(500).json({ error: 'Failed to fetch subscribers' });
        }

        const { count, error: countError } = await supabase
          .from('email_subscriber')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('communication_category_id', category_id)
          .eq('opted_out', false);

        return res.json({
          subscribers: subscribers || [],
          total: count || 0,
          page: parseInt(page),
          per_page: parseInt(per_page)
        });
      }

      const { data: counts, error: countsError } = await supabase
        .from('email_subscriber')
        .select('communication_category_id, id')
        .eq('tenant_id', tenantId)
        .eq('opted_out', false);

      if (countsError) {
        console.error('[External Subscribers] Error fetching counts:', countsError);
        return res.status(500).json({ error: 'Failed to fetch subscriber counts' });
      }

      const countsByCategory = {};
      (counts || []).forEach(sub => {
        const catId = sub.communication_category_id;
        if (catId) {
          countsByCategory[catId] = (countsByCategory[catId] || 0) + 1;
        }
      });

      return res.json({ counts: countsByCategory });

    } else if (req.method === 'DELETE') {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }

      const { subscriber_id } = body;

      if (!subscriber_id) {
        return res.status(400).json({ error: 'subscriber_id is required' });
      }

      const { data: subscriber } = await supabase
        .from('email_subscriber')
        .select('id, tenant_id')
        .eq('id', subscriber_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (!subscriber) {
        return res.status(404).json({ error: 'Subscriber not found' });
      }

      const { error: deleteError } = await supabase
        .from('email_subscriber')
        .delete()
        .eq('id', subscriber_id)
        .eq('tenant_id', tenantId);

      if (deleteError) {
        console.error('[External Subscribers] Error deleting subscriber:', deleteError);
        return res.status(500).json({ error: 'Failed to remove subscriber' });
      }

      return res.json({ success: true });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[External Subscribers] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

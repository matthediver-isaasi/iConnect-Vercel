import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  countExternalSubscribersByCategory,
  listExternalSubscribers,
} from '../_lib/externalSubscriberSearch.js';

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
      const { category_id, page = 1, per_page = 20, search = '' } = req.query;

      if (category_id) {
        try {
          const result = await listExternalSubscribers({
            database: supabase,
            tenantId,
            categoryId: category_id,
            search,
            page,
            perPage: per_page,
          });
          return res.json(result);
        } catch (error) {
          console.error('[External Subscribers] Error fetching subscribers:', error);
          return res.status(500).json({ error: 'Failed to fetch subscribers' });
        }
      }

      let countsByCategory;
      try {
        countsByCategory = await countExternalSubscribersByCategory({
          database: supabase,
          tenantId,
        });
      } catch (countsError) {
        console.error('[External Subscribers] Error fetching counts:', countsError);
        return res.status(500).json({ error: 'Failed to fetch subscriber counts' });
      }

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

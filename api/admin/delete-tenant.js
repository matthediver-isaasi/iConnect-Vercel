import { getSupabaseClient } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(403).json({ error: 'SaaS admin access required' });
  }

  try {
    const { tenantIdToDelete, tenantIdToKeep, reassignUnscoped = true } = req.body;
    
    if (!tenantIdToDelete || !tenantIdToKeep) {
      return res.status(400).json({ error: 'Both tenantIdToDelete and tenantIdToKeep are required' });
    }

    if (tenantIdToDelete === tenantIdToKeep) {
      return res.status(400).json({ error: 'Cannot delete and keep the same tenant' });
    }

    const { data: keepTenant } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', tenantIdToKeep)
      .single();

    if (!keepTenant) {
      return res.status(404).json({ error: 'Tenant to keep not found' });
    }

    const { data: deleteTenant } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', tenantIdToDelete)
      .single();

    if (!deleteTenant) {
      return res.status(404).json({ error: 'Tenant to delete not found' });
    }

    const results = {
      tenantToDelete: deleteTenant,
      tenantToKeep: keepTenant,
      reassigned: {},
      deleted: {}
    };

    const tablesWithTenantId = [
      'portal_navigation_item',
      'portal_menu',
      'navigation_item',
      'system_settings',
      'blog_post',
      'resource',
      'event',
      'role',
      'member',
      'organization',
      'speaker',
      'card_deck',
      'card',
      'page',
      'form',
      'workflow',
      'email_template',
      'voucher_code',
      'custom_field'
    ];

    if (reassignUnscoped) {
      for (const table of tablesWithTenantId) {
        try {
          const { data: nullRecords } = await supabase
            .from(table)
            .select('id')
            .is('tenant_id', null);

          if (nullRecords && nullRecords.length > 0) {
            const ids = nullRecords.map(r => r.id);
            await supabase
              .from(table)
              .update({ tenant_id: tenantIdToKeep })
              .in('id', ids);
            
            results.reassigned[table] = ids.length;
          }
        } catch (err) {
          console.log(`Table ${table} may not have tenant_id column, skipping reassign`);
        }
      }
    }

    const deletionOrder = [
      'member_note',
      'organization_note',
      'booking',
      'program_ticket',
      'team_member',
      'role_member_field_permission',
      'member_session',
      'member',
      'organization',
      'tenant_user_member_link',
      'tenant_user',
      'portal_navigation_item',
      'portal_menu',
      'navigation_item',
      'system_settings',
      'blog_post',
      'resource',
      'event',
      'role',
      'speaker',
      'card',
      'card_deck',
      'page',
      'form_submission',
      'form',
      'workflow',
      'email_template',
      'voucher_code',
      'custom_field',
      'xero_token'
    ];

    for (const table of deletionOrder) {
      try {
        const { data: records } = await supabase
          .from(table)
          .select('id')
          .eq('tenant_id', tenantIdToDelete);

        if (records && records.length > 0) {
          const ids = records.map(r => r.id);
          const { error } = await supabase
            .from(table)
            .delete()
            .in('id', ids);

          if (error) {
            console.error(`Error deleting from ${table}:`, error.message);
            results.deleted[table] = { error: error.message };
          } else {
            results.deleted[table] = ids.length;
          }
        } else {
          results.deleted[table] = 0;
        }
      } catch (err) {
        console.log(`Table ${table} deletion skipped:`, err.message);
      }
    }

    const { error: deleteTenantError } = await supabase
      .from('tenant')
      .delete()
      .eq('id', tenantIdToDelete);

    if (deleteTenantError) {
      results.tenantDeletion = { error: deleteTenantError.message };
    } else {
      results.tenantDeletion = 'success';
    }

    return res.status(200).json(results);

  } catch (error) {
    console.error('[Delete Tenant] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

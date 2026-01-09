import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(401).json({ error: 'Platform owner authentication required' });
  }

  try {
    const { tenantId, confirmSlug } = req.body;
    
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (!confirmSlug) {
      return res.status(400).json({ error: 'confirmSlug is required for safety confirmation' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (confirmSlug !== tenant.slug) {
      return res.status(400).json({ error: 'Confirmation slug does not match tenant slug' });
    }

    console.log(`[Platform Delete Tenant] Starting deletion of tenant: ${tenant.name} (${tenant.slug})`);

    const results = {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      deleted: {},
      errors: []
    };

    const deletionOrder = [
      { table: 'member_note', fkPath: 'member.organization.tenant_id' },
      { table: 'organization_note', fkPath: 'organization.tenant_id' },
      { table: 'booking', tenantVia: 'event' },
      { table: 'program_ticket', tenantVia: 'event' },
      { table: 'form_submission', tenantVia: 'form' },
      { table: 'team_member', tenantVia: 'member' },
      { table: 'role_member_field_permission', tenantVia: 'role' },
      { table: 'role_organization_field_permission', tenantVia: 'role' },
      { table: 'member_credentials', tenantDirect: true },
      { table: 'member_session', tenantVia: 'member' },
      { table: 'tenant_user_member_link', tenantDirect: true },
      { table: 'tenant_user_credentials', tenantVia: 'tenant_user' },
      { table: 'tenant_user', tenantDirect: true },
      { table: 'member', fkPath: 'organization.tenant_id' },
      { table: 'organization', tenantDirect: true },
      { table: 'portal_navigation_item', tenantDirect: true },
      { table: 'portal_menu', tenantDirect: true },
      { table: 'navigation_item', tenantDirect: true },
      { table: 'system_settings', tenantDirect: true },
      { table: 'blog_post', tenantDirect: true },
      { table: 'resource', tenantDirect: true },
      { table: 'event', tenantDirect: true },
      { table: 'role', tenantDirect: true },
      { table: 'speaker', tenantDirect: true },
      { table: 'card', tenantVia: 'card_deck' },
      { table: 'card_deck', tenantDirect: true },
      { table: 'page', tenantDirect: true },
      { table: 'form', tenantDirect: true },
      { table: 'workflow', tenantDirect: true },
      { table: 'email_template', tenantDirect: true },
      { table: 'voucher_code', tenantDirect: true },
      { table: 'custom_field', tenantDirect: true },
      { table: 'xero_token', tenantKey: 'app_tenant_id' }
    ];

    for (const { table, tenantDirect, tenantVia, tenantKey, fkPath } of deletionOrder) {
      try {
        let recordIds = [];

        if (tenantDirect) {
          const { data } = await supabase
            .from(table)
            .select('id')
            .eq('tenant_id', tenantId);
          recordIds = (data || []).map(r => r.id);
        } else if (tenantKey) {
          const { data } = await supabase
            .from(table)
            .select('id')
            .eq(tenantKey, tenantId);
          recordIds = (data || []).map(r => r.id);
        } else if (tenantVia) {
          if (tenantVia === 'event') {
            const { data: events } = await supabase.from('event').select('id').eq('tenant_id', tenantId);
            const eventIds = (events || []).map(e => e.id);
            if (eventIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('event_id', eventIds);
              recordIds = (data || []).map(r => r.id);
            }
          } else if (tenantVia === 'form') {
            const { data: forms } = await supabase.from('form').select('id').eq('tenant_id', tenantId);
            const formIds = (forms || []).map(f => f.id);
            if (formIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('form_id', formIds);
              recordIds = (data || []).map(r => r.id);
            }
          } else if (tenantVia === 'role') {
            const { data: roles } = await supabase.from('role').select('id').eq('tenant_id', tenantId);
            const roleIds = (roles || []).map(r => r.id);
            if (roleIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('role_id', roleIds);
              recordIds = (data || []).map(r => r.id);
            }
          } else if (tenantVia === 'member') {
            const { data: orgs } = await supabase.from('organization').select('id').eq('tenant_id', tenantId);
            const orgIds = (orgs || []).map(o => o.id);
            if (orgIds.length > 0) {
              const { data: members } = await supabase.from('member').select('id').in('organization_id', orgIds);
              const memberIds = (members || []).map(m => m.id);
              if (memberIds.length > 0) {
                const { data } = await supabase.from(table).select('id').in('member_id', memberIds);
                recordIds = (data || []).map(r => r.id);
              }
            }
          } else if (tenantVia === 'card_deck') {
            const { data: decks } = await supabase.from('card_deck').select('id').eq('tenant_id', tenantId);
            const deckIds = (decks || []).map(d => d.id);
            if (deckIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('deck_id', deckIds);
              recordIds = (data || []).map(r => r.id);
            }
          } else if (tenantVia === 'tenant_user') {
            const { data: users } = await supabase.from('tenant_user').select('id').eq('tenant_id', tenantId);
            const userIds = (users || []).map(u => u.id);
            if (userIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('tenant_user_id', userIds);
              recordIds = (data || []).map(r => r.id);
            }
          }
        } else if (fkPath) {
          if (fkPath === 'member.organization.tenant_id') {
            const { data: orgs } = await supabase.from('organization').select('id').eq('tenant_id', tenantId);
            const orgIds = (orgs || []).map(o => o.id);
            if (orgIds.length > 0) {
              const { data: members } = await supabase.from('member').select('id').in('organization_id', orgIds);
              const memberIds = (members || []).map(m => m.id);
              if (memberIds.length > 0) {
                const { data } = await supabase.from(table).select('id').in('member_id', memberIds);
                recordIds = (data || []).map(r => r.id);
              }
            }
          } else if (fkPath === 'organization.tenant_id') {
            const { data: orgs } = await supabase.from('organization').select('id').eq('tenant_id', tenantId);
            const orgIds = (orgs || []).map(o => o.id);
            if (orgIds.length > 0) {
              const { data } = await supabase.from(table).select('id').in('organization_id', orgIds);
              recordIds = (data || []).map(r => r.id);
            }
          }
        }

        if (recordIds.length > 0) {
          let deleteError = null;
          
          // Special handling for role table - use RPC to bypass system role trigger
          if (table === 'role') {
            const { data: deletedCount, error: rpcError } = await supabase.rpc('delete_tenant_roles', {
              p_tenant_id: tenantId
            });
            if (rpcError) {
              deleteError = rpcError;
            } else {
              console.log(`[Platform Delete Tenant] Deleted ${deletedCount} roles via RPC`);
            }
          } else {
            const { error } = await supabase
              .from(table)
              .delete()
              .in('id', recordIds);
            deleteError = error;
          }

          if (deleteError) {
            console.error(`[Platform Delete Tenant] Error deleting from ${table}:`, deleteError.message);
            results.errors.push({ table, error: deleteError.message });
            results.deleted[table] = { attempted: recordIds.length, error: deleteError.message };
          } else {
            results.deleted[table] = recordIds.length;
            console.log(`[Platform Delete Tenant] Deleted ${recordIds.length} records from ${table}`);
          }
        } else {
          results.deleted[table] = 0;
        }
      } catch (err) {
        console.log(`[Platform Delete Tenant] Table ${table} deletion skipped:`, err.message);
        results.errors.push({ table, error: err.message });
      }
    }

    const { error: deleteTenantError } = await supabase
      .from('tenant')
      .delete()
      .eq('id', tenantId);

    if (deleteTenantError) {
      console.error('[Platform Delete Tenant] Error deleting tenant record:', deleteTenantError.message);
      results.tenantDeletion = { error: deleteTenantError.message };
      results.errors.push({ table: 'tenant', error: deleteTenantError.message });
    } else {
      results.tenantDeletion = 'success';
      console.log(`[Platform Delete Tenant] Successfully deleted tenant: ${tenant.name} (${tenant.slug})`);
    }

    return res.status(200).json(results);

  } catch (error) {
    console.error('[Platform Delete Tenant] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

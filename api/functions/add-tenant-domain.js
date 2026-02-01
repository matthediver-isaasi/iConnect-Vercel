import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

async function isAdministrator(ctx, req) {
  if (ctx.isSuperAdmin) return true;
  
  // For tenant_user sessions, check their role
  if (ctx.tenantUserId) {
    const tenantUser = await getSessionTenantUser(req);
    if (tenantUser) {
      // Allow owner, admin, or no role set (legacy accounts)
      return tenantUser.role === 'owner' || tenantUser.role === 'admin' || !tenantUser.role;
    }
  }
  
  // For member sessions, check role permissions
  if (!ctx.roleId) return false;
  
  const { data: role } = await supabase
    .from('role')
    .select('name, excluded_features')
    .eq('id', ctx.roleId)
    .single();
  
  if (!role) return false;
  
  if (role.name === 'Administrator') return true;
  
  const excludedFeatures = role.excluded_features || [];
  return !excludedFeatures.some(f => f === 'admin.*' || f === 'admin.settings' || f === 'admin.settings.domains');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  const cleanDomain = domain.toLowerCase().trim().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');

  if (!cleanDomain.includes('.') || cleanDomain.includes(' ')) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAdmin = await isAdministrator(ctx, req);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Administrator access required to manage domains' });
    }

    const tenantId = ctx.tenantId;
    if (!tenantId) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: existingTenant } = await supabase
      .from('tenant')
      .select('id')
      .eq('domain', cleanDomain)
      .neq('id', tenantId)
      .single();

    if (existingTenant) {
      return res.status(400).json({ error: 'This domain is already in use by another workspace' });
    }

    let vercelResponse = null;
    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelUrl = VERCEL_TEAM_ID 
          ? `https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_TEAM_ID}`
          : `https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/domains`;
        
        const response = await fetch(vercelUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: cleanDomain }),
        });

        vercelResponse = await response.json();

        if (!response.ok && vercelResponse.error?.code !== 'domain_already_exists') {
          console.error('[Add Domain] Vercel API error:', vercelResponse);
          return res.status(400).json({ 
            error: vercelResponse.error?.message || 'Failed to add domain to Vercel' 
          });
        }
      } catch (vercelErr) {
        console.error('[Add Domain] Vercel API error:', vercelErr);
      }
    } else {
      console.log('[Add Domain] Vercel API not configured, skipping domain registration');
    }

    const { error: updateError } = await supabase
      .from('tenant')
      .update({ domain: cleanDomain })
      .eq('id', tenantId);

    if (updateError) {
      console.error('[Add Domain] Error updating tenant:', updateError);
      return res.status(500).json({ error: 'Failed to save domain' });
    }

    return res.status(200).json({
      success: true,
      domain: cleanDomain,
      vercelConfigured: !!(VERCEL_TOKEN && VERCEL_PROJECT_ID),
      dnsInstructions: {
        aRecord: {
          type: 'A',
          name: '@',
          value: '76.76.21.21'
        },
        cname: {
          type: 'CNAME',
          name: 'www',
          value: 'cname.vercel-dns.com'
        }
      }
    });

  } catch (err) {
    console.error('[Add Domain] Error:', err);
    return res.status(500).json({ error: 'Failed to add domain' });
  }
}

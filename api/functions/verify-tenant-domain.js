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

    const { data: tenant } = await supabase
      .from('tenant')
      .select('domain')
      .eq('id', tenantId)
      .single();

    if (!tenant || tenant.domain !== domain) {
      return res.status(404).json({ error: 'Domain not found for this workspace' });
    }

    let verified = false;
    let vercelData = null;

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const vercelUrl = VERCEL_TEAM_ID 
          ? `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}?teamId=${VERCEL_TEAM_ID}`
          : `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${domain}`;
        
        const response = await fetch(vercelUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
          },
        });

        if (response.ok) {
          vercelData = await response.json();
          verified = vercelData.verified === true;
        }
      } catch (vercelErr) {
        console.error('[Verify Domain] Vercel API error:', vercelErr);
      }
    } else {
      verified = true;
    }

    return res.status(200).json({
      success: true,
      domain,
      verified,
      vercelData: vercelData ? {
        verified: vercelData.verified,
        verification: vercelData.verification,
        configuredBy: vercelData.configuredBy,
      } : null
    });

  } catch (err) {
    console.error('[Verify Domain] Error:', err);
    return res.status(500).json({ error: 'Failed to verify domain' });
  }
}

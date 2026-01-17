import { supabase } from '../../_lib/database.js';
import { getSessionPlatformOwner } from '../../_lib/platformSession.js';
import {
  validateProvisionInput,
  checkSlugAvailability,
  checkExistingIdentity,
  provisionTenant,
  getBaseDomain,
  getTenantPortalUrl
} from '../../_lib/provisionTenantService.js';

export default async function handler(req, res) {
  console.log('[Platform Provision] Handler invoked');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const platformOwner = await getSessionPlatformOwner(req);
  if (!platformOwner) {
    return res.status(401).json({ error: 'Unauthorized - Platform owner access required' });
  }

  const { tenantName, slug, adminEmail, adminFirstName, adminLastName } = req.body;
  console.log('[Platform Provision] Request body:', { tenantName, slug, adminEmail });

  const validationErrors = await validateProvisionInput({
    tenantName,
    slug,
    adminEmail,
    adminFirstName,
    adminLastName,
    isPlatformProvision: true
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({ error: validationErrors.join('. ') });
  }

  try {
    const slugAvailable = await checkSlugAvailability(slug);
    if (!slugAvailable) {
      return res.status(400).json({ error: 'This subdomain is already taken' });
    }

    const existingIdentity = await checkExistingIdentity(adminEmail.toLowerCase());
    if (existingIdentity) {
      return res.status(409).json({ 
        error: 'An account with this email already exists',
        existingAccount: true,
        message: 'This email is already associated with an account. The user needs to create the tenant from their own account, or use a different email address.'
      });
    }

    const result = await provisionTenant({
      tenantName,
      slug,
      adminEmail,
      adminFirstName,
      adminLastName,
      isPlatformProvision: true,
      generateSetupToken: true
    });

    const baseDomain = getBaseDomain();
    const setupUrl = `https://${baseDomain}/admin/login?setup=${result.setupToken}&email=${encodeURIComponent(adminEmail)}`;

    return res.status(201).json({
      success: true,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        portalUrl: result.tenant.portalUrl
      },
      admin: {
        email: adminEmail,
        setupUrl: setupUrl
      },
      message: `Tenant created successfully. Send the setup URL to the admin to complete their account setup.`
    });

  } catch (error) {
    console.error('[Platform Provision] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

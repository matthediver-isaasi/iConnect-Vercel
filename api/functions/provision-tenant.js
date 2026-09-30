import {
  validateProvisionInput,
  checkSlugAvailability,
  checkExistingIdentity,
  checkLegacyAccount,
  provisionTenant,
  getMailDomain
} from '../_lib/provisionTenantService.js';

export default async function handler(req, res) {
  console.log('[Provision Tenant] Handler invoked - version: multi-tenant-v3');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenantName, slug, adminEmail, adminFirstName, adminLastName, password, googleId, linkExistingAccount } = req.body;
  console.log('[Provision Tenant] Request body:', { tenantName, slug, adminEmail, googleId: !!googleId, linkExistingAccount });

  const validationErrors = await validateProvisionInput({
    tenantName,
    slug,
    adminEmail,
    adminFirstName,
    adminLastName,
    password,
    googleId,
    linkExistingAccount,
    isPlatformProvision: false
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({ error: validationErrors.join('. ') });
  }

  try {
    const slugAvailable = await checkSlugAvailability(slug);
    if (!slugAvailable) {
      return res.status(400).json({ error: 'This subdomain is already taken' });
    }

    let existingIdentity = await checkExistingIdentity(adminEmail.toLowerCase(), googleId);

    if (existingIdentity && !linkExistingAccount) {
      return res.status(409).json({ 
        error: 'An account with this email already exists',
        existingAccount: true,
        canLinkAccount: true,
        message: 'You already have an account with this email. Would you like to add this new workspace to your existing account?'
      });
    }

    if (!existingIdentity) {
      const legacyCheck = await checkLegacyAccount(adminEmail.toLowerCase(), googleId);
      if (legacyCheck.exists) {
        if (legacyCheck.type === 'google') {
          return res.status(400).json({ error: 'This Google account is already linked to another tenant' });
        }
        return res.status(400).json({ 
          error: 'An account with this email already exists. Please run the database migration to enable multi-tenant support.',
          needsMigration: true
        });
      }
    }

    const result = await provisionTenant({
      tenantName,
      slug,
      adminEmail,
      adminFirstName,
      adminLastName,
      password,
      googleId,
      linkExistingAccount,
      isPlatformProvision: false,
      generateSetupToken: false,
      existingIdentity
    });

    return res.status(200).json({
      success: true,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug
      },
      tenantUser: {
        id: result.tenantUser.id,
        email: result.tenantUser.email,
        role: result.tenantUser.role
      },
      member: {
        id: result.member.id,
        email: result.member.email
      },
      emailDomain: result.emailDomain,
      message: 'Workspace created successfully'
    });

  } catch (err) {
    console.error('[Provision Tenant] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'An unexpected error occurred' });
  }
}

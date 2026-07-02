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
import { sendTenantEmail } from '../../_lib/tenantEmailService.js';

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

    const result = await provisionTenant({
      tenantName,
      slug,
      adminEmail,
      adminFirstName,
      adminLastName,
      isPlatformProvision: true,
      generateSetupToken: !existingIdentity,
      existingIdentity: existingIdentity || null
    });

    const baseDomain = getBaseDomain();
    const portalUrl = getTenantPortalUrl(slug);
    
    if (existingIdentity) {
      // Send notification email to existing user about their new tenant access
      // IMPORTANT: Link to root domain login for SSO compatibility (Google OAuth only supports root domain)
      const loginUrl = `https://${baseDomain}/admin/login`;
      
      try {
        await sendTenantEmail({
          tenantId: null,
          to: adminEmail,
          subject: `You now have access to ${tenantName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">You have access to a new workspace!</h2>
              <p>You've been added as an owner of <strong>${tenantName}</strong>.</p>
              <p>Since you already have an account, you can access this workspace immediately using your existing login credentials.</p>
              <p style="text-align: center; margin: 30px 0;">
                <a href="${loginUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Login to Access ${tenantName}
                </a>
              </p>
              <p style="color: #666; font-size: 14px;">
                After logging in, use the tenant switcher to access your new workspace.
              </p>
            </div>
          `,
          text: `You have access to a new workspace!\n\nYou've been added as an owner of ${tenantName}. Login at: ${loginUrl} and use the tenant switcher to access your new workspace.`
        });
        console.log(`[Platform Provision] New tenant notification email sent to ${adminEmail}`);
      } catch (emailErr) {
        console.error(`[Platform Provision] Failed to send notification email:`, emailErr.message);
      }

      return res.status(201).json({
        success: true,
        tenant: {
          id: result.tenant.id,
          name: result.tenant.name,
          slug: result.tenant.slug,
          portalUrl: portalUrl
        },
        admin: {
          email: adminEmail,
          existingAccount: true
        },
        message: `Tenant created successfully. A notification email has been sent to ${adminEmail}.`
      });
    }

    const setupUrl = `https://${baseDomain}/admin/setup-password?token=${result.setupToken}&email=${encodeURIComponent(adminEmail)}`;

    // Send welcome email with setup link
    try {
      await sendTenantEmail({
        tenantId: null, // Use platform default email domain
        to: adminEmail,
        subject: `Welcome to ${tenantName} - Complete Your Account Setup`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Welcome to ${tenantName}!</h2>
            <p>Your workspace has been created and is ready for you to get started.</p>
            <p>Click the button below to set your password and complete your account setup:</p>
            <p style="text-align: center; margin: 30px 0;">
              <a href="${setupUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Complete Account Setup
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">
              Or copy and paste this link into your browser:<br/>
              <a href="${setupUrl}" style="color: #2563eb;">${setupUrl}</a>
            </p>
            <p style="color: #666; font-size: 14px;">This link will expire in 7 days.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
            <p style="color: #999; font-size: 12px;">
              If you didn't request this account, you can safely ignore this email.
            </p>
          </div>
        `,
        text: `Welcome to ${tenantName}!\n\nYour workspace has been created. Complete your account setup by visiting:\n${setupUrl}\n\nThis link will expire in 7 days.`
      });
      console.log(`[Platform Provision] Welcome email sent to ${adminEmail}`);
    } catch (emailErr) {
      console.error(`[Platform Provision] Failed to send welcome email:`, emailErr.message);
      // Don't fail the whole provisioning if email fails
    }

    return res.status(201).json({
      success: true,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        portalUrl: portalUrl
      },
      admin: {
        email: adminEmail,
        setupUrl: setupUrl
      },
      message: `Tenant created successfully. A setup email has been sent to ${adminEmail}.`
    });

  } catch (error) {
    console.error('[Platform Provision] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

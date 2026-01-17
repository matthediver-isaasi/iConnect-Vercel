import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
const ROOT_DOMAIN = 'iconn.app';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('[Provision Mailgun Domain] Handler invoked');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate request - must be a tenant owner/admin
  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check if user has owner/admin role
  if (tenantUser.role !== 'owner' && tenantUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
  }

  // Use authenticated tenant's context - get tenant ID from session only
  const tenantId = tenantUser.tenant_id;

  if (!MAILGUN_API_KEY) {
    return res.status(500).json({ error: 'MAILGUN_API_KEY not configured' });
  }

  if (!VERCEL_API_TOKEN) {
    return res.status(500).json({ error: 'VERCEL_API_TOKEN not configured' });
  }

  try {
    // Get tenant from DB using authenticated tenant ID - NEVER trust request body for tenant identity
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, slug, name, settings')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Use slug from database, not from request
    const tenantSlug = tenant.slug;
    const mailgunDomain = `mail.${tenantSlug}.${ROOT_DOMAIN}`;

    console.log(`[Provision Mailgun Domain] Creating domain ${mailgunDomain} for tenant ${tenantSlug}`);

    // Step 1: Create Mailgun domain
    const mailgun = new Mailgun(formData);
    const mailgunConfig = {
      username: 'api',
      key: MAILGUN_API_KEY,
    };
    if (MAILGUN_REGION === 'eu') {
      mailgunConfig.url = 'https://api.eu.mailgun.net';
    }
    const mg = mailgun.client(mailgunConfig);

    let mailgunDomainData;
    try {
      mailgunDomainData = await mg.domains.create({
        name: mailgunDomain,
        web_scheme: 'https',
        spam_action: 'disabled',
        wildcard: false,
      });
      console.log('[Provision Mailgun Domain] Mailgun domain created:', mailgunDomainData);
    } catch (mgError) {
      // Domain might already exist
      if (mgError.message?.includes('already exists') || mgError.status === 400) {
        console.log('[Provision Mailgun Domain] Domain already exists, fetching info...');
        mailgunDomainData = await mg.domains.get(mailgunDomain);
      } else {
        throw mgError;
      }
    }

    // Step 2: Get DNS records required by Mailgun
    const dnsRecords = mailgunDomainData.sending_dns_records || mailgunDomainData.receiving_dns_records || [];
    console.log('[Provision Mailgun Domain] DNS records needed:', JSON.stringify(dnsRecords, null, 2));

    // Step 3: Create DNS records in Vercel
    const createdDnsRecords = [];
    for (const record of dnsRecords) {
      try {
        const vercelRecord = await createVercelDnsRecord(record, tenantSlug);
        if (vercelRecord) {
          createdDnsRecords.push(vercelRecord);
        }
      } catch (dnsError) {
        console.error(`[Provision Mailgun Domain] DNS record creation failed:`, dnsError.message);
        // Continue with other records
      }
    }

    // Step 4: Also add SPF record if not in the list
    const hasSPF = dnsRecords.some(r => r.record_type === 'TXT' && r.value?.includes('spf'));
    if (!hasSPF) {
      try {
        await createVercelDnsRecord({
          record_type: 'TXT',
          name: `mail.${tenantSlug}`,
          value: 'v=spf1 include:mailgun.org ~all'
        }, tenantSlug);
      } catch (spfError) {
        console.log('[Provision Mailgun Domain] SPF record may already exist');
      }
    }

    // Step 5: Attempt to verify the domain
    let verificationResult = null;
    try {
      // Wait a moment for DNS propagation
      await new Promise(resolve => setTimeout(resolve, 2000));
      verificationResult = await mg.domains.verify(mailgunDomain);
      console.log('[Provision Mailgun Domain] Verification result:', verificationResult);
    } catch (verifyError) {
      console.log('[Provision Mailgun Domain] Initial verification pending:', verifyError.message);
    }

    // Step 6: Update tenant settings with email domain configuration
    const currentSettings = tenant.settings || {};
    const updatedSettings = {
      ...currentSettings,
      email_domain: {
        domain: mailgunDomain,
        status: verificationResult?.state === 'active' ? 'verified' : 'pending',
        created_at: new Date().toISOString(),
        from_email: `noreply@${mailgunDomain}`,
        from_name: tenant.name || 'ICONN',
        dns_records_created: createdDnsRecords.length,
      }
    };

    const { error: updateError } = await supabase
      .from('tenant')
      .update({ settings: updatedSettings })
      .eq('id', tenantId);

    if (updateError) {
      console.error('[Provision Mailgun Domain] Failed to update tenant settings:', updateError);
    }

    return res.status(200).json({
      success: true,
      domain: mailgunDomain,
      status: updatedSettings.email_domain.status,
      dns_records_created: createdDnsRecords.length,
      message: updatedSettings.email_domain.status === 'verified' 
        ? 'Email domain configured and verified successfully'
        : 'Email domain created. DNS records added. Verification pending - may take up to 48 hours.',
    });

  } catch (error) {
    console.error('[Provision Mailgun Domain] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to provision email domain',
      details: error.message 
    });
  }
}

async function createVercelDnsRecord(mailgunRecord, tenantSlug) {
  const recordType = mailgunRecord.record_type?.toUpperCase() || mailgunRecord.type?.toUpperCase();
  let name = mailgunRecord.name || '';
  let value = mailgunRecord.value || '';

  // Convert Mailgun record format to Vercel format
  // Mailgun returns full domain names, Vercel expects relative names
  name = name.replace(`.${ROOT_DOMAIN}`, '');
  
  // Handle CNAME records - Mailgun uses 'hostname' 
  if (recordType === 'CNAME' && mailgunRecord.hostname) {
    value = mailgunRecord.hostname;
  }

  // Skip records that don't apply to sending
  if (recordType === 'MX') {
    console.log('[Provision Mailgun Domain] Skipping MX record (not needed for sending only)');
    return null;
  }

  const body = {
    name: name,
    type: recordType,
    value: value,
    ttl: 300,
  };

  console.log(`[Provision Mailgun Domain] Creating Vercel DNS record:`, body);

  const response = await fetch(`https://api.vercel.com/v4/domains/${ROOT_DOMAIN}/records`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    // Check if record already exists
    if (data.error?.code === 'duplicate_record' || data.error?.message?.includes('already exists')) {
      console.log(`[Provision Mailgun Domain] DNS record already exists: ${name}`);
      return { name, type: recordType, status: 'exists' };
    }
    throw new Error(`Vercel DNS API error: ${JSON.stringify(data)}`);
  }

  console.log(`[Provision Mailgun Domain] DNS record created: ${data.uid}`);
  return { name, type: recordType, uid: data.uid, status: 'created' };
}

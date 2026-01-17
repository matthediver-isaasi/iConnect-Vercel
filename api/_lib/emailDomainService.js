import { supabase } from './database.js';
import { getBaseDomain, getMailDomain } from './provisionTenantService.js';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;

/**
 * Delete a Vercel DNS record by ID
 */
async function deleteVercelDnsRecord(recordId) {
  const rootDomain = getRootDomain();
  
  const response = await fetch(`https://api.vercel.com/v4/domains/${rootDomain}/records/${recordId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(`Vercel DNS delete error: ${JSON.stringify(data)}`);
  }

  console.log(`[Email Domain] Deleted Vercel DNS record: ${recordId}`);
  return { success: true, recordId };
}

/**
 * Find and delete all Vercel DNS records for a tenant subdomain
 */
async function deleteVercelDnsRecordsForTenant(tenantSlug) {
  const rootDomain = getRootDomain();
  
  // Fetch all DNS records for the domain
  const response = await fetch(`https://api.vercel.com/v4/domains/${rootDomain}/records`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(`Failed to fetch DNS records: ${JSON.stringify(data)}`);
  }

  const data = await response.json();
  const records = data.records || [];
  
  // Find records that match tenant subdomain patterns
  const tenantRecords = records.filter(r => {
    const name = r.name || '';
    // Match tenant slug directly or any subdomain of it (e.g., pic._domainkey.tenant)
    return name === tenantSlug || 
           name.endsWith(`.${tenantSlug}`) ||
           name.startsWith(`${tenantSlug}.`);
  });

  console.log(`[Email Domain] Found ${tenantRecords.length} DNS records to delete for tenant ${tenantSlug}`);
  
  const results = [];
  for (const record of tenantRecords) {
    try {
      await deleteVercelDnsRecord(record.id);
      results.push({ id: record.id, name: record.name, type: record.type, status: 'deleted' });
    } catch (err) {
      console.error(`[Email Domain] Failed to delete DNS record ${record.id}:`, err.message);
      results.push({ id: record.id, name: record.name, type: record.type, status: 'error', error: err.message });
    }
  }
  
  return results;
}

function getRootDomain() {
  return getBaseDomain();
}

async function createVercelDnsRecord(mailgunRecord, tenantSlug) {
  const rootDomain = getRootDomain();
  const recordType = mailgunRecord.record_type?.toUpperCase() || mailgunRecord.type?.toUpperCase();
  let name = mailgunRecord.name || '';
  let value = mailgunRecord.value || '';

  // Strip the root domain suffix from the name
  name = name.replace(`.${rootDomain}`, '');
  
  // If name is empty after stripping (common for MX records), default to tenant slug
  if (!name || name === rootDomain) {
    name = tenantSlug;
  }
  
  if (recordType === 'CNAME' && mailgunRecord.hostname) {
    value = mailgunRecord.hostname;
  }

  // For MX records, ensure we have the correct value format
  if (recordType === 'MX') {
    // Mailgun MX records might have the value in different formats
    // Ensure we're using the mail server address
    if (!value && mailgunRecord.hostname) {
      value = mailgunRecord.hostname;
    }
    // Ensure the MX value ends with a dot for proper DNS format
    if (value && !value.endsWith('.')) {
      value = value + '.';
    }
  }

  const body = {
    name: name,
    type: recordType,
    value: value,
    ttl: 300,
  };

  // MX records require a priority field (must be a number)
  if (recordType === 'MX') {
    const priority = parseInt(mailgunRecord.priority, 10);
    body.mxPriority = isNaN(priority) ? 10 : priority;
  }

  console.log(`[Email Domain] Creating Vercel DNS record:`, body);

  const response = await fetch(`https://api.vercel.com/v4/domains/${rootDomain}/records`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    if (data.error?.code === 'duplicate_record' || data.error?.message?.includes('already exists')) {
      console.log(`[Email Domain] DNS record already exists: ${name}`);
      return { name, type: recordType, status: 'exists' };
    }
    throw new Error(`Vercel DNS API error: ${JSON.stringify(data)}`);
  }

  console.log(`[Email Domain] DNS record created: ${data.uid}`);
  return { name, type: recordType, uid: data.uid, status: 'created' };
}

export async function provisionEmailDomain(tenantId, tenantSlug, tenantName, currentSettings = {}) {
  if (!MAILGUN_API_KEY) {
    console.log('[Email Domain] MAILGUN_API_KEY not configured - skipping email domain provisioning');
    return { success: false, error: 'MAILGUN_API_KEY not configured' };
  }

  if (!VERCEL_API_TOKEN) {
    console.log('[Email Domain] VERCEL_API_TOKEN not configured - skipping email domain provisioning');
    return { success: false, error: 'VERCEL_API_TOKEN not configured' };
  }

  const rootDomain = getRootDomain();
  const mailgunDomain = `${tenantSlug}.${rootDomain}`;

  console.log(`[Email Domain] Provisioning domain ${mailgunDomain} for tenant ${tenantSlug}`);

  try {
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
      console.log('[Email Domain] Mailgun domain created:', mailgunDomainData);
    } catch (mgError) {
      if (mgError.message?.includes('already exists') || mgError.status === 400) {
        console.log('[Email Domain] Domain already exists, fetching info...');
        mailgunDomainData = await mg.domains.get(mailgunDomain);
      } else {
        throw mgError;
      }
    }

    // Collect both sending (SPF, DKIM) and receiving (MX) DNS records
    const sendingRecords = mailgunDomainData.sending_dns_records || [];
    const receivingRecords = mailgunDomainData.receiving_dns_records || [];
    const dnsRecords = [...sendingRecords, ...receivingRecords];
    console.log('[Email Domain] Sending DNS records count:', sendingRecords.length);
    console.log('[Email Domain] Receiving DNS records (MX) count:', receivingRecords.length);
    console.log('[Email Domain] Receiving DNS records details:', JSON.stringify(receivingRecords, null, 2));
    
    // Log each MX record for debugging
    receivingRecords.forEach((r, i) => {
      console.log(`[Email Domain] MX Record ${i}:`, {
        record_type: r.record_type,
        name: r.name,
        value: r.value,
        priority: r.priority,
        hostname: r.hostname
      });
    });

    const createdDnsRecords = [];
    for (const record of dnsRecords) {
      try {
        const vercelRecord = await createVercelDnsRecord(record, tenantSlug);
        if (vercelRecord) {
          createdDnsRecords.push(vercelRecord);
        }
      } catch (dnsError) {
        console.error(`[Email Domain] DNS record creation failed:`, dnsError.message);
      }
    }

    const hasSPF = dnsRecords.some(r => r.record_type === 'TXT' && r.value?.includes('spf'));
    if (!hasSPF) {
      try {
        await createVercelDnsRecord({
          record_type: 'TXT',
          name: tenantSlug,
          value: 'v=spf1 include:mailgun.org ~all'
        }, tenantSlug);
      } catch (spfError) {
        console.log('[Email Domain] SPF record may already exist');
      }
    }

    // Add DMARC record for email authentication
    // This is critical for deliverability - helps prevent emails from being marked as spam
    // DMARC policy: p=none (monitor only), with reporting to Mailgun
    try {
      const dmarcRecordName = `_dmarc.${tenantSlug}`;
      const dmarcValue = 'v=DMARC1; p=none; pct=100; fo=1; ri=3600; rua=mailto:fd56106c@dmarc.mailgun.org,mailto:980db2c4@inbox.ondmarc.com; ruf=mailto:fd56106c@dmarc.mailgun.org,mailto:980db2c4@inbox.ondmarc.com;';
      
      const dmarcRecord = await createVercelDnsRecord({
        record_type: 'TXT',
        name: dmarcRecordName,
        value: dmarcValue
      }, tenantSlug);
      
      if (dmarcRecord) {
        createdDnsRecords.push(dmarcRecord);
        console.log(`[Email Domain] Created DMARC record for ${tenantSlug}`);
      }
    } catch (dmarcError) {
      console.log('[Email Domain] DMARC record may already exist:', dmarcError.message);
    }

    // Add A and AAAA records for web traffic - this is critical!
    // When we add explicit DNS records for the tenant subdomain (TXT, MX),
    // it breaks the wildcard *.iconn.app resolution. We must add A/AAAA records
    // pointing to Vercel's edge IPs so web traffic still works.
    // Note: We use A/AAAA instead of CNAME/ALIAS because those cannot coexist with
    // other record types (MX, TXT) at the same name - this is a DNS limitation.
    // Vercel edge IP: 76.76.21.21 (IPv4)
    try {
      const vercelARecord = await createVercelDnsRecord({
        record_type: 'A',
        name: tenantSlug,
        value: '76.76.21.21'
      }, tenantSlug);
      if (vercelARecord) {
        createdDnsRecords.push(vercelARecord);
        console.log(`[Email Domain] Created A record for web traffic: ${tenantSlug} -> 76.76.21.21`);
      }
    } catch (aError) {
      console.log('[Email Domain] A record may already exist:', aError.message);
    }

    let verificationResult = null;
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      verificationResult = await mg.domains.verify(mailgunDomain);
      console.log('[Email Domain] Verification result:', verificationResult);
    } catch (verifyError) {
      console.log('[Email Domain] Initial verification pending:', verifyError.message);
    }

    const emailDomainStatus = verificationResult?.state === 'active' ? 'verified' : 'pending';
    const updatedSettings = {
      ...currentSettings,
      email_domain: {
        domain: mailgunDomain,
        status: emailDomainStatus,
        created_at: new Date().toISOString(),
        from_email: `noreply@${mailgunDomain}`,
        from_name: tenantName || 'ICONN',
        dns_records_created: createdDnsRecords.length,
      }
    };

    const { error: updateError } = await supabase
      .from('tenant')
      .update({ settings: updatedSettings })
      .eq('id', tenantId);

    if (updateError) {
      console.error('[Email Domain] Failed to update tenant settings:', updateError);
    }

    console.log(`[Email Domain] Successfully provisioned domain ${mailgunDomain} with status ${emailDomainStatus}`);

    return {
      success: true,
      domain: mailgunDomain,
      status: emailDomainStatus,
      dns_records_created: createdDnsRecords.length,
      message: emailDomainStatus === 'verified' 
        ? 'Email domain configured and verified successfully'
        : 'Email domain created. DNS records added. Verification pending - may take up to 48 hours.',
    };

  } catch (error) {
    console.error('[Email Domain] Error:', error);
    
    const updatedSettings = {
      ...currentSettings,
      email_domain: {
        domain: mailgunDomain,
        status: 'error',
        error: error.message,
        created_at: new Date().toISOString(),
        from_email: `noreply@${mailgunDomain}`,
        from_name: tenantName || 'ICONN',
      }
    };

    await supabase
      .from('tenant')
      .update({ settings: updatedSettings })
      .eq('id', tenantId);

    return {
      success: false,
      domain: mailgunDomain,
      status: 'error',
      error: error.message
    };
  }
}

export async function verifyEmailDomain(tenantId) {
  if (!MAILGUN_API_KEY) {
    return { success: false, error: 'MAILGUN_API_KEY not configured' };
  }

  const { data: tenant, error: tenantError } = await supabase
    .from('tenant')
    .select('slug, settings')
    .eq('id', tenantId)
    .single();

  if (tenantError || !tenant) {
    return { success: false, error: 'Tenant not found' };
  }

  const emailDomain = tenant.settings?.email_domain;
  if (!emailDomain?.domain) {
    return { success: false, error: 'No email domain configured' };
  }

  try {
    const mailgun = new Mailgun(formData);
    const mailgunConfig = {
      username: 'api',
      key: MAILGUN_API_KEY,
    };
    if (MAILGUN_REGION === 'eu') {
      mailgunConfig.url = 'https://api.eu.mailgun.net';
    }
    const mg = mailgun.client(mailgunConfig);

    const domainInfo = await mg.domains.get(emailDomain.domain);
    console.log('[Email Domain] Domain info:', domainInfo);

    let verificationResult;
    try {
      verificationResult = await mg.domains.verify(emailDomain.domain);
      console.log('[Email Domain] Verification result:', verificationResult);
    } catch (verifyError) {
      console.log('[Email Domain] Verification check:', verifyError.message);
      verificationResult = domainInfo;
    }

    const isVerified = domainInfo.state === 'active' || verificationResult?.state === 'active';
    const status = isVerified ? 'verified' : 'pending';

    // Include both sending and receiving DNS record status
    const sendingDnsStatus = (domainInfo.sending_dns_records || []).map(r => ({
      name: r.name,
      type: r.record_type,
      valid: r.valid,
      purpose: 'sending'
    }));
    const receivingDnsStatus = (domainInfo.receiving_dns_records || []).map(r => ({
      name: r.name,
      type: r.record_type,
      valid: r.valid,
      purpose: 'receiving'
    }));
    const dnsStatus = [...sendingDnsStatus, ...receivingDnsStatus];

    const updatedSettings = {
      ...tenant.settings,
      email_domain: {
        ...emailDomain,
        status: status,
        last_verified_at: new Date().toISOString(),
        dns_status: dnsStatus,
        verified_at: status === 'verified' ? new Date().toISOString() : emailDomain.verified_at
      }
    };

    await supabase
      .from('tenant')
      .update({ settings: updatedSettings })
      .eq('id', tenantId);

    return {
      success: true,
      domain: emailDomain.domain,
      status: status,
      dns_records: dnsStatus,
      message: status === 'verified' 
        ? 'Email domain is verified and active'
        : 'Email domain verification is still pending'
    };

  } catch (error) {
    console.error('[Email Domain] Verification error:', error);
    return {
      success: false,
      domain: emailDomain.domain,
      status: 'error',
      error: error.message
    };
  }
}

/**
 * Clean up email domain resources when a tenant is deleted
 * Removes Mailgun domain and Vercel DNS records
 */
export async function cleanupEmailDomain(tenantSlug, emailDomainConfig = null) {
  const results = {
    mailgun: { success: false },
    vercelDns: { success: false, records: [] }
  };

  const rootDomain = getRootDomain();
  const mailgunDomain = emailDomainConfig?.domain || `${tenantSlug}.${rootDomain}`;

  console.log(`[Email Domain Cleanup] Starting cleanup for tenant ${tenantSlug}, domain ${mailgunDomain}`);

  // 1. Delete Mailgun domain
  if (MAILGUN_API_KEY) {
    try {
      const mailgun = new Mailgun(formData);
      const mailgunConfig = {
        username: 'api',
        key: MAILGUN_API_KEY,
      };
      if (MAILGUN_REGION === 'eu') {
        mailgunConfig.url = 'https://api.eu.mailgun.net';
      }
      const mg = mailgun.client(mailgunConfig);

      await mg.domains.destroy(mailgunDomain);
      console.log(`[Email Domain Cleanup] Deleted Mailgun domain: ${mailgunDomain}`);
      results.mailgun = { success: true, domain: mailgunDomain };
    } catch (mgError) {
      if (mgError.status === 404 || mgError.message?.includes('not found')) {
        console.log(`[Email Domain Cleanup] Mailgun domain not found (already deleted): ${mailgunDomain}`);
        results.mailgun = { success: true, domain: mailgunDomain, note: 'already deleted' };
      } else {
        console.error(`[Email Domain Cleanup] Failed to delete Mailgun domain:`, mgError.message);
        results.mailgun = { success: false, error: mgError.message };
      }
    }
  } else {
    console.log('[Email Domain Cleanup] MAILGUN_API_KEY not configured, skipping Mailgun cleanup');
    results.mailgun = { success: true, note: 'skipped - no API key' };
  }

  // 2. Delete Vercel DNS records
  if (VERCEL_API_TOKEN) {
    try {
      const dnsResults = await deleteVercelDnsRecordsForTenant(tenantSlug);
      results.vercelDns = { 
        success: true, 
        records: dnsResults,
        deleted: dnsResults.filter(r => r.status === 'deleted').length
      };
      console.log(`[Email Domain Cleanup] Deleted ${results.vercelDns.deleted} Vercel DNS records`);
    } catch (dnsError) {
      console.error(`[Email Domain Cleanup] Failed to delete Vercel DNS records:`, dnsError.message);
      results.vercelDns = { success: false, error: dnsError.message };
    }
  } else {
    console.log('[Email Domain Cleanup] VERCEL_API_TOKEN not configured, skipping Vercel DNS cleanup');
    results.vercelDns = { success: true, note: 'skipped - no API token' };
  }

  return results;
}

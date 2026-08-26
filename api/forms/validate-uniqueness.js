import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Helper to resolve tenant_id from hostname or form
async function resolveTenantId(req, form_id, supabaseClient = supabase) {
  // First try: resolve from hostname (subdomain)
  const tenantFromHost = await resolveTenantFromRequest(req);
  if (tenantFromHost?.id) {
    console.log(`[Form Uniqueness] Resolved tenant_id ${tenantFromHost.id} from hostname`);
    return tenantFromHost.id;
  }
  
  // Fallback: derive from the form's tenant_id
  if (form_id && supabaseClient) {
    const { data: form } = await supabaseClient
      .from('form')
      .select('tenant_id')
      .eq('id', form_id)
      .single();
    if (form?.tenant_id) {
      console.log(`[Form Uniqueness] Resolved tenant_id ${form.tenant_id} from form ${form_id}`);
      return form.tenant_id;
    }
  }
  
  return null;
}

// Helper to extract domain from email or URL
// Returns lowercase domain or null if extraction fails
const extractDomain = (value) => {
  if (!value || typeof value !== 'string') return null;
  
  const trimmed = value.trim().toLowerCase();
  
  // Check if it's an email address (contains @)
  if (trimmed.includes('@')) {
    const parts = trimmed.split('@');
    if (parts.length === 2 && parts[1]) {
      return parts[1];
    }
    return null;
  }
  
  // Try to extract domain from URL
  try {
    let urlStr = trimmed;
    // Add protocol if missing for URL parsing
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = 'https://' + urlStr;
    }
    const url = new URL(urlStr);
    let hostname = url.hostname;
    // Remove www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    return hostname || null;
  } catch (e) {
    // If URL parsing fails, try simple extraction
    let cleaned = trimmed
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split('?')[0];
    return cleaned || null;
  }
};

// Valid target fields whitelist for uniqueness checks
const VALID_UNIQUENESS_TARGETS = {
  member: ['email', 'full_name', 'phone'],
  organization: ['name', 'invoicing_email', 'phone', 'website_url']
};

export default async function handler(req, res, {
  supabaseClient = supabase,
  resolveTenantIdFn = (req, formId) => resolveTenantId(req, formId, supabaseClient),
} = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseClient) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { application_level, uniqueness_checks, form_values, fields, form_id } = req.body;

    if (!Array.isArray(uniqueness_checks) || uniqueness_checks.length === 0) {
      return res.json({ valid: true, conflicts: [] });
    }
    
    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'Invalid form_values' });
    }
    
    if (!Array.isArray(fields)) {
      return res.status(400).json({ error: 'Invalid fields array' });
    }

    // SECURITY: Resolve tenant_id for proper multi-tenant isolation
    const tenantId = await resolveTenantIdFn(req, form_id);
    if (!tenantId) {
      console.error('[Form Uniqueness] SECURITY: Unable to resolve tenant context');
      return res.status(403).json({ error: 'Unable to determine tenant context for uniqueness check' });
    }
    console.log(`[Form Uniqueness] Using tenant_id ${tenantId} for uniqueness checks`);

    const conflicts = [];
    
    const validFieldIds = new Set(fields.filter(f => f && f.id).map(f => f.id));
    const sanitizedChecks = uniqueness_checks.filter(
      c => c && typeof c === 'object' && c.field_id && validFieldIds.has(c.field_id)
    );

    for (const check of sanitizedChecks) {
      const { field_id, target_field, comparison_mode, error_message } = check;
      
      const field = fields.find(f => f && f.id === field_id);
      if (!field) continue;

      const value = form_values[field_id];
      if (!value) continue;

      // Parse target_field (e.g., "member.email" or "organization.name")
      if (!target_field || !target_field.includes('.')) {
        console.log(`[Form Uniqueness] Skipping check for ${field_id}: invalid target_field`, target_field);
        continue;
      }

      const [targetEntity, targetColumn] = target_field.split('.');
      const tableName = targetEntity === 'organization' ? 'organization' : 'member';
      
      // Validate target column against whitelist
      const validColumns = VALID_UNIQUENESS_TARGETS[tableName];
      if (!validColumns || !validColumns.includes(targetColumn)) {
        console.log(`[Form Uniqueness] Skipping check for ${field_id}: invalid column ${targetColumn} for ${tableName}`);
        continue;
      }
      
      // Validate domain_equals is only used with email or URL columns
      const emailColumns = ['email', 'invoicing_email'];
      const urlColumns = ['website_url'];
      if (comparison_mode === 'domain_equals' && !emailColumns.includes(targetColumn) && !urlColumns.includes(targetColumn)) {
        console.log(`[Form Uniqueness] Skipping domain_equals for non-email/non-url column ${targetColumn}`);
        continue;
      }
      
      let searchValue = String(value).trim();
      const mode = comparison_mode || 'equals_lowercase';

      // Apply comparison logic
      let query;
      switch (mode) {
        case 'equals':
          // Exact match
          query = supabaseClient
            .from(tableName)
            .select('id')
            .eq(targetColumn, searchValue)
            .limit(1);
          break;
          
        case 'equals_lowercase':
          // Case insensitive match
          query = supabaseClient
            .from(tableName)
            .select('id')
            .ilike(targetColumn, searchValue)
            .limit(1);
          break;
          
        case 'contains':
          // Contains match
          query = supabaseClient
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `%${searchValue}%`)
            .limit(1);
          break;
          
        case 'starts_with':
          // Starts with match
          query = supabaseClient
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `${searchValue}%`)
            .limit(1);
          break;
          
        case 'ends_with':
          // Ends with match
          query = supabaseClient
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `%${searchValue}`)
            .limit(1);
          break;
          
        case 'domain_equals':
          // Extract domain from email or URL and match
          const extractedDomain = extractDomain(searchValue);
          if (extractedDomain) {
            if (urlColumns.includes(targetColumn)) {
              // For URL columns, match the domain anywhere in the stored URL
              query = supabaseClient
                .from(tableName)
                .select('id')
                .ilike(targetColumn, `%${extractedDomain}%`)
                .limit(1);
            } else {
              // For email columns, match @domain suffix
              query = supabaseClient
                .from(tableName)
                .select('id')
                .ilike(targetColumn, `%@${extractedDomain}`)
                .limit(1);
            }
          } else {
            // If domain extraction fails, skip this check
            continue;
          }
          break;
        
        case 'url_equals': {
          // Normalise the URL and check multiple format variations
          const normalisedUrl = extractDomain(searchValue);
          if (normalisedUrl) {
            // Build OR filter covering common stored URL formats
            const patterns = [
              `${targetColumn}.ilike.${normalisedUrl}`,
              `${targetColumn}.ilike.http://${normalisedUrl}`,
              `${targetColumn}.ilike.https://${normalisedUrl}`,
              `${targetColumn}.ilike.http://www.${normalisedUrl}`,
              `${targetColumn}.ilike.https://www.${normalisedUrl}`,
              `${targetColumn}.ilike.www.${normalisedUrl}`,
              `${targetColumn}.ilike.${normalisedUrl}/`,
              `${targetColumn}.ilike.http://${normalisedUrl}/`,
              `${targetColumn}.ilike.https://${normalisedUrl}/`,
              `${targetColumn}.ilike.http://www.${normalisedUrl}/`,
              `${targetColumn}.ilike.https://www.${normalisedUrl}/`,
              `${targetColumn}.ilike.www.${normalisedUrl}/`,
            ];
            query = supabaseClient
              .from(tableName)
              .select('id')
              .or(patterns.join(','))
              .limit(1);
          } else {
            // Fallback to case-insensitive exact match
            query = supabaseClient
              .from(tableName)
              .select('id')
              .ilike(targetColumn, searchValue)
              .limit(1);
          }
          break;
        }
          
        default:
          // Default to case insensitive
          query = supabaseClient
            .from(tableName)
            .select('id')
            .ilike(targetColumn, searchValue)
            .limit(1);
      }

      // SECURITY: Add tenant_id filtering to ensure multi-tenant isolation
      query = query.eq('tenant_id', tenantId);

      const { data, error } = await query;

      if (error) {
        console.error(`[Form Uniqueness] Error checking ${field_id} in ${tableName}.${targetColumn}:`, error);
      } else if (data && data.length > 0) {
        // Use custom error message if provided, otherwise fall back to default
        const defaultMessage = (() => {
          const entityLabel = tableName === 'organization' ? 'an organisation' : 'a member';
          const modeLabel = mode === 'domain_equals' ? 'email domain' : 'value';
          return `We already have ${entityLabel} registered with this ${modeLabel}. Please contact us if you believe this is an error.`;
        })();
        conflicts.push({
          field_id,
          field_label: field.label || field_id,
          message: error_message && error_message.trim() ? error_message.trim() : defaultMessage
        });
        continue;
      }

    }

    return res.json({
      valid: conflicts.length === 0,
      conflicts
    });
  } catch (error) {
    console.error('[Form Uniqueness] Validation error:', error);
    res.status(500).json({ error: 'Failed to validate uniqueness' });
  }
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
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

    const conflicts = [];
    
    const validFieldIds = new Set(fields.filter(f => f && f.id).map(f => f.id));
    const sanitizedChecks = uniqueness_checks.filter(
      c => c && typeof c === 'object' && c.field_id && validFieldIds.has(c.field_id)
    );

    for (const check of sanitizedChecks) {
      const { field_id, target_field, comparison_mode } = check;
      
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
      
      // Validate domain_equals is only used with email columns
      const emailColumns = ['email', 'invoicing_email'];
      if (comparison_mode === 'domain_equals' && !emailColumns.includes(targetColumn)) {
        console.log(`[Form Uniqueness] Skipping domain_equals for non-email column ${targetColumn}`);
        continue;
      }
      
      let searchValue = String(value).trim();
      const mode = comparison_mode || 'equals_lowercase';

      // Apply comparison logic
      let query;
      switch (mode) {
        case 'equals':
          // Exact match
          query = supabase
            .from(tableName)
            .select('id')
            .eq(targetColumn, searchValue)
            .limit(1);
          break;
          
        case 'equals_lowercase':
          // Case insensitive match
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(targetColumn, searchValue)
            .limit(1);
          break;
          
        case 'contains':
          // Contains match
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `%${searchValue}%`)
            .limit(1);
          break;
          
        case 'starts_with':
          // Starts with match
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `${searchValue}%`)
            .limit(1);
          break;
          
        case 'ends_with':
          // Ends with match
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(targetColumn, `%${searchValue}`)
            .limit(1);
          break;
          
        case 'domain_equals':
          // Extract domain from email or URL and match
          const extractedDomain = extractDomain(searchValue);
          if (extractedDomain) {
            query = supabase
              .from(tableName)
              .select('id')
              .ilike(targetColumn, `%@${extractedDomain}`)
              .limit(1);
          } else {
            // If domain extraction fails, skip this check
            continue;
          }
          break;
          
        default:
          // Default to case insensitive
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(targetColumn, searchValue)
            .limit(1);
      }

      const { data, error } = await query;

      if (error) {
        console.error(`[Form Uniqueness] Error checking ${field_id} in ${tableName}.${targetColumn}:`, error);
      } else if (data && data.length > 0) {
        const entityLabel = tableName === 'organization' ? 'an organisation' : 'a member';
        const modeLabel = mode === 'domain_equals' ? 'email domain' : 'value';
        conflicts.push({
          field_id,
          field_label: field.label || field_id,
          message: `We already have ${entityLabel} registered with this ${modeLabel}. Please contact us if you believe this is an error.`
        });
        continue;
      }

      // Also check previous form submissions
      if (form_id) {
        const originalValue = String(form_values[field_id]).trim();
        
        const { data: submissions, error: subError } = await supabase
          .from('form_submission')
          .select('id, submission_data')
          .eq('form_id', form_id)
          .not('submission_data', 'is', null)
          .limit(100);

        if (subError) {
          console.error(`[Form Uniqueness] Error checking form_submission:`, subError);
        } else if (submissions && submissions.length > 0) {
          let foundConflict = false;
          
          for (const sub of submissions) {
            if (foundConflict) break;
            
            const subData = sub.submission_data || {};
            const subValue = subData[field_id];
            if (!subValue) continue;
            
            let subValueStr = String(subValue).trim();
            let compareValue = originalValue;
            
            // Apply comparison logic for submission check
            let matches = false;
            switch (mode) {
              case 'equals':
                matches = subValueStr === compareValue;
                break;
              case 'equals_lowercase':
                matches = subValueStr.toLowerCase() === compareValue.toLowerCase();
                break;
              case 'contains':
                matches = subValueStr.toLowerCase().includes(compareValue.toLowerCase());
                break;
              case 'starts_with':
                matches = subValueStr.toLowerCase().startsWith(compareValue.toLowerCase());
                break;
              case 'ends_with':
                matches = subValueStr.toLowerCase().endsWith(compareValue.toLowerCase());
                break;
              case 'domain_equals':
                const subDomain = extractDomain(subValueStr);
                const compareDomain = extractDomain(compareValue);
                matches = !!(subDomain && compareDomain && subDomain === compareDomain);
                break;
              default:
                matches = subValueStr.toLowerCase() === compareValue.toLowerCase();
            }
            
            if (matches) {
              conflicts.push({
                field_id,
                field_label: field.label || field_id,
                message: 'This value has already been submitted in a previous application'
              });
              foundConflict = true;
            }
          }
        }
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

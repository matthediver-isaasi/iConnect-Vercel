import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

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

    const normalizedLevel = application_level === 'organisation' ? 'organization' : (application_level || 'member');
    if (!['member', 'organization'].includes(normalizedLevel)) {
      return res.status(400).json({ error: 'Invalid application_level' });
    }

    const conflicts = [];
    const tableName = normalizedLevel === 'organization' ? 'organization' : 'member';
    
    const validFieldIds = new Set(fields.filter(f => f && f.id).map(f => f.id));
    const sanitizedChecks = uniqueness_checks.filter(
      c => c && typeof c === 'object' && c.field_id && validFieldIds.has(c.field_id)
    );

    for (const check of sanitizedChecks) {
      const { field_id, check_mode } = check;
      
      const field = fields.find(f => f && f.id === field_id);
      if (!field) continue;

      const value = form_values[field_id];
      if (!value) continue;

      const isEmailField = field.type === 'email' || field.type === 'user_email';
      let searchValue = String(value).toLowerCase().trim();
      let columnToCheck = 'email';
      
      const effectiveCheckMode = normalizedLevel === 'organization' && isEmailField 
        ? 'domain_only' 
        : (check_mode || 'full');

      if (isEmailField && effectiveCheckMode === 'domain_only' && searchValue.includes('@')) {
        searchValue = searchValue.split('@')[1];
      }

      if (!isEmailField) {
        if (normalizedLevel === 'organization') {
          columnToCheck = 'name';
        } else {
          if (field.type === 'text' && field.label?.toLowerCase().includes('name')) {
            columnToCheck = 'full_name';
          } else {
            columnToCheck = '';
          }
        }
      }

      if (columnToCheck) {
        let query;
        if (isEmailField && effectiveCheckMode === 'domain_only') {
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(columnToCheck, `%@${searchValue}`)
            .limit(1);
        } else {
          query = supabase
            .from(tableName)
            .select('id')
            .ilike(columnToCheck, searchValue)
            .limit(1);
        }

        const { data, error } = await query;

        if (error) {
          console.error(`[Form Uniqueness] Error checking ${field_id} in ${tableName}:`, error);
        } else if (data && data.length > 0) {
          const entityLabel = normalizedLevel === 'organization' ? 'an organisation' : 'a member';
          const matchType = effectiveCheckMode === 'domain_only' ? 'email domain' : 'value';
          conflicts.push({
            field_id,
            field_label: field.label || field_id,
            message: `We already have ${entityLabel} registered with this ${matchType}. Please contact us if you believe this is an error.`
          });
          continue;
        }
      }

      if (form_id) {
        const originalValue = String(form_values[field_id]).toLowerCase().trim();
        
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
            
            let subValueStr = String(subValue).toLowerCase().trim();
            let compareValue = originalValue;
            
            if (isEmailField && effectiveCheckMode === 'domain_only') {
              if (subValueStr.includes('@')) subValueStr = subValueStr.split('@')[1];
              if (compareValue.includes('@')) compareValue = compareValue.split('@')[1];
            }
            
            if (subValueStr === compareValue) {
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

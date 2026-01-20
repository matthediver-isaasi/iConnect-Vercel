import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Generate a secure random token
function generateResumeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Hash the token for storage (never store raw tokens)
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Default draft expiry: 30 days
const DEFAULT_EXPIRY_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Helper to resolve tenant from request
  async function resolveTenant(tenantSlug) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const subdomain = host.split('.')[0];
    const tenantIdentifier = tenantSlug || subdomain;

    if (!tenantIdentifier || tenantIdentifier === 'www' || tenantIdentifier === 'iconn') {
      return null;
    }

    let tenantResult = await supabase
      .from('tenant')
      .select('id')
      .eq('slug', tenantIdentifier)
      .eq('status', 'active')
      .single();

    if (tenantResult.error || !tenantResult.data) {
      tenantResult = await supabase
        .from('tenant')
        .select('id')
        .eq('subdomain', tenantIdentifier)
        .single();
    }

    return tenantResult.data;
  }

  try {
    // POST: Save or update a draft
    if (req.method === 'POST') {
      const { 
        form_slug, 
        form_id,
        draft_data, 
        current_page_index,
        contact_email,
        resume_token, // If provided, update existing draft
        tenant: tenantSlug,
        form_updated_at
      } = req.body;

      if (!form_slug && !form_id) {
        return res.status(400).json({ error: 'Form slug or ID is required' });
      }

      if (!draft_data || typeof draft_data !== 'object') {
        return res.status(400).json({ error: 'Draft data is required' });
      }

      const tenantData = await resolveTenant(tenantSlug);
      console.log('[Form Draft] Tenant resolution:', { 
        tenantSlug, 
        tenantData,
        host: req.headers['x-forwarded-host'] || req.headers.host 
      });
      
      if (!tenantData) {
        return res.status(400).json({ error: 'Invalid tenant context' });
      }

      // Get form to verify it exists
      let formQuery = supabase
        .from('form')
        .select('id, tenant_id')
        .eq('tenant_id', tenantData.id)
        .eq('is_active', true);

      if (form_id) {
        formQuery = formQuery.eq('id', form_id);
      } else {
        formQuery = formQuery.eq('slug', form_slug);
      }

      console.log('[Form Draft] Form query params:', { 
        form_id, 
        form_slug, 
        tenant_id: tenantData.id 
      });

      const { data: form, error: formError } = await formQuery.single();

      console.log('[Form Draft] Form lookup result:', { 
        form: form ? { id: form.id, tenant_id: form.tenant_id } : null, 
        error: formError?.message,
        code: formError?.code 
      });

      if (formError || !form) {
        return res.status(404).json({ 
          error: 'Form not found',
          debug: { form_id, form_slug, tenant_id: tenantData.id, dbError: formError?.message }
        });
      }

      // Calculate expiry date (always use default since settings column doesn't exist)
      const expiryDays = DEFAULT_EXPIRY_DAYS;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiryDays);

      // If resume_token provided, update existing draft
      if (resume_token) {
        const tokenHash = hashToken(resume_token);
        
        const { data: existingDraft, error: findError } = await supabase
          .from('form_draft_submission')
          .select('id')
          .eq('resume_token_hash', tokenHash)
          .eq('tenant_id', tenantData.id)
          .single();

        if (findError || !existingDraft) {
          return res.status(404).json({ error: 'Draft not found or expired' });
        }

        // Update existing draft
        const { error: updateError } = await supabase
          .from('form_draft_submission')
          .update({
            draft_data,
            current_page_index: current_page_index || 0,
            contact_email: contact_email || null,
            form_updated_at: form_updated_at || null,
            expires_at: expiresAt.toISOString(),
            last_saved_at: new Date().toISOString()
          })
          .eq('id', existingDraft.id);

        if (updateError) {
          console.error('[Form Draft] Update error:', updateError);
          return res.status(500).json({ error: 'Failed to update draft' });
        }

        return res.status(200).json({
          success: true,
          resume_token: resume_token, // Return same token
          expires_at: expiresAt.toISOString(),
          message: 'Draft updated successfully'
        });
      }

      // Create new draft with new token
      const newToken = generateResumeToken();
      const tokenHash = hashToken(newToken);

      const { error: insertError } = await supabase
        .from('form_draft_submission')
        .insert({
          tenant_id: tenantData.id,
          form_id: form.id,
          resume_token_hash: tokenHash,
          draft_data,
          current_page_index: current_page_index || 0,
          contact_email: contact_email || null,
          form_updated_at: form_updated_at || null,
          expires_at: expiresAt.toISOString()
        });

      if (insertError) {
        console.error('[Form Draft] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to save draft' });
      }

      return res.status(201).json({
        success: true,
        resume_token: newToken, // Return raw token to user (only time it's exposed)
        expires_at: expiresAt.toISOString(),
        message: 'Draft saved successfully'
      });
    }

    // GET: Fetch draft by resume token
    if (req.method === 'GET') {
      const { token, tenant: tenantSlug } = req.query;

      if (!token) {
        return res.status(400).json({ error: 'Resume token is required' });
      }

      const tenantData = await resolveTenant(tenantSlug);
      if (!tenantData) {
        return res.status(400).json({ error: 'Invalid tenant context' });
      }

      const tokenHash = hashToken(token);

      const { data: draft, error: findError } = await supabase
        .from('form_draft_submission')
        .select('*')
        .eq('resume_token_hash', tokenHash)
        .eq('tenant_id', tenantData.id)
        .single();

      if (findError || !draft) {
        return res.status(404).json({ error: 'Draft not found or expired' });
      }

      // Check if expired
      if (new Date(draft.expires_at) < new Date()) {
        // Clean up expired draft
        await supabase
          .from('form_draft_submission')
          .delete()
          .eq('id', draft.id);
        
        return res.status(410).json({ error: 'Draft has expired' });
      }

      // Get current form to check for schema changes
      // Must include tenant_id filter for Supabase RLS policies
      const { data: form, error: formError } = await supabase
        .from('form')
        .select('id, slug, name, updated_at, fields')
        .eq('id', draft.form_id)
        .eq('tenant_id', tenantData.id)
        .eq('is_active', true)
        .single();

      if (formError || !form) {
        console.error('[Form Draft] Form lookup error:', { formError, formId: draft.form_id, tenantId: tenantData.id });
        return res.status(404).json({ error: 'Form no longer exists' });
      }

      // Detect schema drift
      const schemaChanged = draft.form_updated_at && 
        new Date(form.updated_at).getTime() !== new Date(draft.form_updated_at).getTime();

      return res.status(200).json({
        success: true,
        draft: {
          draft_data: draft.draft_data,
          current_page_index: draft.current_page_index,
          contact_email: draft.contact_email,
          last_saved_at: draft.last_saved_at,
          expires_at: draft.expires_at
        },
        form: {
          id: form.id,
          slug: form.slug,
          name: form.name
        },
        schema_changed: schemaChanged,
        message: schemaChanged 
          ? 'Form has been updated since you last saved. Some fields may have changed.'
          : null
      });
    }

    // DELETE: Abandon/delete a draft
    if (req.method === 'DELETE') {
      const { token, tenant: tenantSlug } = req.query;

      if (!token) {
        return res.status(400).json({ error: 'Resume token is required' });
      }

      const tenantData = await resolveTenant(tenantSlug);
      if (!tenantData) {
        return res.status(400).json({ error: 'Invalid tenant context' });
      }

      const tokenHash = hashToken(token);

      const { error: deleteError } = await supabase
        .from('form_draft_submission')
        .delete()
        .eq('resume_token_hash', tokenHash)
        .eq('tenant_id', tenantData.id);

      if (deleteError) {
        console.error('[Form Draft] Delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete draft' });
      }

      return res.status(200).json({
        success: true,
        message: 'Draft deleted successfully'
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('[Form Draft] Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

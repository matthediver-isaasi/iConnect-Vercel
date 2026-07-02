import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS * 5);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Service not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const { email, first_name, last_name, category_id, tenant: tenantParam, tenant_id: tenantIdParam } = body;

    if (!email || !category_id) {
      return res.status(400).json({ error: 'Email and category_id are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    let tenantId = null;

    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }

    if (!tenantId && tenantIdParam) {
      const { data: tenantById } = await supabase
        .from('tenant')
        .select('id')
        .eq('id', tenantIdParam)
        .eq('status', 'active')
        .single();

      if (tenantById) {
        tenantId = tenantById.id;
      }
    }

    if (!tenantId && tenantParam) {
      const { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();

      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      }
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'Unable to determine tenant context' });
    }

    const { data: category, error: catError } = await supabase
      .from('communication_category')
      .select('id, name, is_public, is_active')
      .eq('id', category_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!category || catError) {
      return res.status(404).json({ error: 'Communication category not found' });
    }

    if (!category.is_active) {
      return res.status(400).json({ error: 'This communication list is no longer active' });
    }

    if (!category.is_public) {
      return res.status(403).json({ error: 'This communication list is not available for public subscription' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const { data: existingMember } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingMember) {
      await supabase
        .from('member_communication_preference')
        .upsert({
          member_id: existingMember.id,
          category_id: category_id,
          is_subscribed: true
        }, {
          onConflict: 'member_id,category_id'
        });

      console.log(`[Public Subscribe] Member ${existingMember.id} subscribed to category ${category_id}`);
    } else {
      await supabase
        .from('email_subscriber')
        .upsert({
          tenant_id: tenantId,
          email: normalizedEmail,
          first_name: first_name || null,
          last_name: last_name || null,
          communication_category_id: category_id,
          opted_out: false,
          subscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'tenant_id,email,communication_category_id'
        });

      console.log(`[Public Subscribe] External subscriber ${normalizedEmail} subscribed to category ${category_id}`);
    }

    return res.json({
      success: true,
      message: `Successfully subscribed to ${category.name}`
    });

  } catch (error) {
    console.error('[Public Subscribe] Error:', error);
    return res.status(500).json({ error: 'Failed to process subscription' });
  }
}

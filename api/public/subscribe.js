import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { loadMemberCommunicationCategoryEligibility } from '../_lib/communicationCategoryEligibility.js';

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

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS * 5);
rateLimitCleanupTimer.unref?.();

export async function applyPublicCommunicationSubscription({
  database,
  tenantId,
  email,
  firstName = null,
  lastName = null,
  categoryId,
  eligibilityLoader = loadMemberCommunicationCategoryEligibility,
}) {
  const { data: category, error: categoryError } = await database
    .from('communication_category')
    .select('id, name, is_public, is_active, member_enabled')
    .eq('id', categoryId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!category || categoryError) {
    return { status: 404, payload: { error: 'Communication category not found' } };
  }
  if (!category.is_active) {
    return { status: 400, payload: { error: 'This communication list is no longer active' } };
  }
  if (!category.is_public) {
    return {
      status: 403,
      payload: { error: 'This communication list is not available for public subscription' },
    };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const { data: existingMember, error: memberError } = await database
    .from('member')
    .select('id, tenant_id, role_id')
    .eq('tenant_id', tenantId)
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (memberError) throw memberError;

  if (existingMember) {
    const eligibility = await eligibilityLoader(database, {
      tenantId,
      memberId: existingMember.id,
    });
    if (!eligibility?.eligibleCategoryIds.has(categoryId)) {
      return {
        status: 403,
        payload: { error: 'This communication list is not available for your member role' },
      };
    }

    const { error: preferenceError } = await database
      .from('member_communication_preference')
      .upsert({
        tenant_id: tenantId,
        member_id: existingMember.id,
        category_id: categoryId,
        is_subscribed: true,
      }, {
        onConflict: 'member_id,category_id',
      });
    if (preferenceError) throw preferenceError;
  } else {
    const { error: externalSubscriberError } = await database
      .from('email_subscriber')
      .upsert({
        tenant_id: tenantId,
        email: normalizedEmail,
        first_name: firstName || null,
        last_name: lastName || null,
        communication_category_id: categoryId,
        opted_out: false,
        subscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'tenant_id,email,communication_category_id',
      });
    if (externalSubscriberError) throw externalSubscriberError;
  }

  return {
    status: 200,
    payload: {
      success: true,
      message: `Successfully subscribed to ${category.name}`,
    },
    subscriberType: existingMember ? 'member' : 'external',
  };
}

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

    const result = await applyPublicCommunicationSubscription({
      database: supabase,
      tenantId,
      email,
      firstName: first_name,
      lastName: last_name,
      categoryId: category_id,
    });
    return res.status(result.status).json(result.payload);

  } catch (error) {
    console.error('[Public Subscribe] Error:', error);
    return res.status(500).json({ error: 'Failed to process subscription' });
  }
}

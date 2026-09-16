import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getCallerGroupMembershipIds } from '../_lib/memberGroupEventsAccess.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import {
  consumeEventClickRateLimit,
  deriveEventClickVisitorHash,
  isUuid,
  trustedEventClickClientKey,
} from '../_lib/eventClickTracking.js';
import { isEventCardClickVisible } from '../_lib/eventClickAccess.js';

const EVENT_TYPES = new Set(['simple', 'complex']);

function getFirstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isSameOriginRequest(req) {
  const origin = getFirstHeader(req.headers?.origin);
  if (!origin) return true;

  try {
    const requestOrigin = new URL(origin);
    const forwardedProtocol = getFirstHeader(req.headers?.['x-forwarded-proto'])
      ?.split(',')[0]
      ?.trim();
    const forwardedHost = getFirstHeader(req.headers?.['x-forwarded-host'])
      ?.split(',')[0]
      ?.trim();
    const host = forwardedHost || getFirstHeader(req.headers?.host)?.trim();
    if (!host) return false;

    // Vercel supplies x-forwarded-proto. HTTPS is the production default
    // when a direct request does not provide it; local development may use
    // either protocol.
    const isLocalHost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host);
    const protocol = (forwardedProtocol || (isLocalHost ? requestOrigin.protocol.slice(0, -1) : 'https'))
      .toLowerCase();
    return requestOrigin.protocol === `${protocol}:`
      && requestOrigin.host === host.toLowerCase();
  } catch {
    return false;
  }
}

async function loadEvent(req, tenantId, eventType, eventId) {
  const table = eventType === 'simple' ? 'event' : 'complex_event';
  const { data, error } = await supabase
    .from(table)
    .select('id,tenant_id,status,event_state,member_group_id,group_event_public,pricing_config')
    .eq('tenant_id', tenantId)
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export default async function handler(req, res) {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({
      error: 'Cross-origin event click requests are not allowed',
      code: 'CROSS_ORIGIN_EVENT_CLICK',
    });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId.trim().toLowerCase() : null;
  const eventType = typeof req.body?.eventType === 'string' ? req.body.eventType.trim().toLowerCase() : null;
  const visitorId = typeof req.body?.visitorId === 'string' ? req.body.visitorId.trim().toLowerCase() : null;
  if (!isUuid(eventId) || !EVENT_TYPES.has(eventType) || !isUuid(visitorId)) {
    return res.status(400).json({
      error: 'eventId, eventType, and visitorId are required',
      code: 'INVALID_EVENT_CLICK',
    });
  }

  let context;
  try {
    context = await getTenantContext(req);
  } catch (error) {
    console.error('[Event click] Tenant resolution failed:', error);
    return res.status(503).json({ error: 'Unable to resolve tenant' });
  }
  if (context?.tenantMismatch) {
    return res.status(409).json({ error: 'Session tenant changed — please reload.' });
  }

  let tenantId = context?.tenantId || context?.tenantFromHost?.id;
  if (!tenantId) {
    try {
      tenantId = (await resolveTenantFromRequest(req))?.id || null;
    } catch (error) {
      console.error('[Event click] Public tenant resolution failed:', error);
      return res.status(503).json({ error: 'Unable to resolve tenant' });
    }
  }
  if (!tenantId) return res.status(404).json({ error: 'Tenant not found' });

  const limit = consumeEventClickRateLimit(`${tenantId}:${trustedEventClickClientKey(req)}`);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many event click requests' });
  }

  try {
    const [event, isTenantAdmin, membership] = await Promise.all([
      loadEvent(req, tenantId, eventType, eventId),
      context.isAuthenticated ? hasAdminAccess(context) : false,
      context.isAuthenticated
        ? getCallerGroupMembershipIds(req)
        : Promise.resolve({ groupIds: new Set() }),
    ]);

    // Return 404 for both unknown and inaccessible events. This prevents the
    // public write endpoint from becoming an event/group membership oracle.
    if (!isEventCardClickVisible(event, {
      eventType,
      tenantId,
      isAuthenticated: context.isAuthenticated === true,
      isTenantAdmin,
      groupIds: membership.groupIds,
    })) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const visitorHash = deriveEventClickVisitorHash(tenantId, visitorId);
    if (!visitorHash) {
      return res.status(503).json({ error: 'Event click tracking is unavailable' });
    }

    const { data, error } = await supabase.rpc('record_event_card_click', {
      p_tenant_id: tenantId,
      p_event_id: eventId,
      p_event_type: eventType,
      p_visitor_key_hash: visitorHash,
    });
    if (error) {
      console.error('[Event click] Record failed:', error);
      return res.status(503).json({ error: 'Event click tracking is unavailable' });
    }

    return res.status(200).json({ recorded: data === true });
  } catch (error) {
    console.error('[Event click] Request failed:', error);
    return res.status(500).json({ error: 'Failed to record event click' });
  }
}
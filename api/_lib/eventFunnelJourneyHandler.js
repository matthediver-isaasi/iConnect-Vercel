import { createHash, randomBytes } from 'node:crypto';
import { createEventFunnelJourneyService } from './eventFunnelJourney.js';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { FunnelGraphError } from '../../shared/eventFunnelGraph.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieName = id => `__Host-event-reservation-${id.toLowerCase()}`;
const fail = (message, code, status = 400) => { throw new FunnelJourneyError(message, code, status); };
const unavailable = () => fail('This reservation is not available.', 'JOURNEY_NOT_FOUND', 404);

// For the future gated create-session boundary. Not a bearer API token, not
// returned in JSON or a URL; only its digest is stored in the private session.
export function createFunnelGuestCapability(id) {
  if (!uuid(id)) throw new Error('A reservation ID is required');
  const token = randomBytes(32).toString('base64url');
  return {
    hash: digest(token),
    cookie: `${cookieName(id)}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
  };
}
export function readCapability(req, id) {
  const cookie = req.headers?.cookie;
  if (cookie == null) return null;
  if (typeof cookie !== 'string' || cookie.length > 16384) unavailable();
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName(id)}=`));
  if (!matches.length) return null;
  if (matches.length !== 1) unavailable();
  const token = matches[0].slice(cookieName(id).length + 1);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) unavailable();
  return digest(token);
}
export function requireSameOriginJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] || '')
    || req.headers?.['sec-fetch-site'] === 'cross-site') fail('Same-origin JSON request required.', 'INVALID_ORIGIN', 403);
  if (req.headers?.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail('Invalid request origin.', 'INVALID_ORIGIN', 403); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) {
      fail('Same-origin request required.', 'INVALID_ORIGIN', 403);
    }
  }
}

export function publicFunnelSnapshot(snapshot) {
  return {
    ...snapshot,
    purchaser: snapshot.holds.find(hold => hold.node_id === snapshot.graph.entry)?.price_snapshot?.purchaser || null,
    holds: snapshot.holds.map(hold => {
      const price = hold.price_snapshot || {};
      return { ...hold, price_snapshot: Object.fromEntries([
        'version', 'unitMinor', 'unitAmount', 'currency', 'eventId', 'eventKind', 'eventTitle', 'eventReference',
        'ticketId', 'ticketName', 'groupSize', 'rules', 'tax', 'paymentMethods', 'purchaserKind',
      ].filter(key => Object.hasOwn(price, key)).map(key => [key, price[key]])) };
    }),
  };
}

export async function requireFunnelTenant({ req, res, db, resolveTenant }) {
  const tenant = await resolveTenant(req);
  if (!uuid(tenant?.id)) unavailable();
  const ip = String(req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 100);
  const limit = await db.rpc('event_funnel_consume_limit', {
    p_tenant: tenant.id, p_actor: `journey-client:${digest(ip)}`,
  });
  if (limit.error || typeof limit.data !== 'boolean') fail('Reservation access is temporarily unavailable.', 'JOURNEY_UNAVAILABLE', 503);
  if (!limit.data) {
    res.setHeader('Retry-After', '60'); fail('Too many requests. Try again shortly.', 'RATE_LIMITED', 429);
  }
  return tenant;
}

export async function requireFunnelOwner({ req, res, db, resolveTenant, loadViewer, sessionId }) {
  requireSameOriginJson(req);
  if (!uuid(sessionId)) unavailable();
  const tenant = await requireFunnelTenant({ req, res, db, resolveTenant });
  const capabilityHash = readCapability(req, sessionId);
  let memberId = null;
  if (!capabilityHash) {
    const viewer = await loadViewer(req, tenant.id, db);
    if (viewer?.tenantId !== tenant.id || !uuid(viewer?.memberId)) unavailable();
    memberId = viewer.memberId;
  }
  return { tenantId: tenant.id, sessionId: sessionId.toLowerCase(), memberId, capabilityHash };
}

/**
 * No session creation or payment endpoint is exposed here. Published entry
 * discovery, eligibility/pricing and provider recovery must be wired before
 * the separate start boundary can issue a capability and create a session.
 */
export function createEventFunnelJourneyHandler({ db, resolveTenant, loadViewer, resolveSelection, validateLines }) {
  const service = createEventFunnelJourneyService({ db, resolveSelection, validateLines });
  return async function handler(req, res) {
    for (const [key, value] of Object.entries({
      'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive', Vary: 'Cookie',
    })) res.setHeader(key, value);
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail('Method not allowed.', 'METHOD_NOT_ALLOWED', 405); }
      requireSameOriginJson(req);
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 80000
        || !uuid(body.sessionId) || !['read', 'change', 'answers'].includes(body.action)) fail('Invalid reservation request.', 'INVALID_REQUEST');
      const allowed = body.action === 'read' ? ['action', 'sessionId'] : body.action === 'change'
        ? ['action', 'sessionId', 'command'] : ['action', 'sessionId', 'nodeId', 'expectedRevision', 'answers'];
      if (Object.keys(body).some(key => !allowed.includes(key))) fail('Unexpected reservation details.', 'INVALID_REQUEST');
      const owner = await requireFunnelOwner({ req, res, db, resolveTenant, loadViewer, sessionId: body.sessionId });
      if (body.action === 'read') return res.status(200).json(publicFunnelSnapshot(await service.read(owner)));
      if (body.action === 'change') return res.status(200).json(publicFunnelSnapshot(await service.change(owner, body.command)));
      const snapshot = await service.read(owner);
      const node = snapshot.graph.nodes.find(n => n.id === body.nodeId);
      if (!node?.event || !snapshot.route.route.includes(node.id)
        || !node.requires.every(id => snapshot.route.retainedNodeIds.includes(id))
        || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== snapshot.session.revision) {
        fail('Your selection changed. Reload before editing attendee information.', 'REVISION_CONFLICT', 409);
      }
      if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)
        || JSON.stringify(body.answers).length > 65536) fail('Invalid attendee answers.', 'INVALID_REQUEST');
      const saved = await db.rpc('event_funnel_save_answers', {
        p_tenant: owner.tenantId, p_id: owner.sessionId, p_member: owner.memberId, p_capability_hash: owner.capabilityHash,
        p_expected_revision: body.expectedRevision, p_node: body.nodeId, p_answers: body.answers,
      });
      if (saved.error) {
        if (saved.error.code === 'PT404') unavailable();
        if (saved.error.code === 'PT409') fail('Your selection changed. Reload before editing.', 'REVISION_CONFLICT', 409);
        fail('Your attendee information could not be saved.', 'JOURNEY_UNAVAILABLE', 503);
      }
      return res.status(200).json(publicFunnelSnapshot(await service.read(owner)));
    } catch (error) {
      const known = error instanceof FunnelJourneyError || error instanceof FunnelGraphError;
      return res.status(known ? error.status || 400 : 503).json({
        error: known ? error.message : 'Reservation access is temporarily unavailable.',
        code: known ? error.code || 'INVALID_SELECTION' : 'JOURNEY_UNAVAILABLE',
      });
    }
  };
}

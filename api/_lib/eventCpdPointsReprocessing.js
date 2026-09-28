import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isReplayUuid = value => typeof value === 'string' && UUID.test(value);
function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function normalizeReplayScope(scope) {
  if (scope?.mode === 'all_event') {
    if (!isReplayUuid(scope.event_id) || !['simple', 'complex'].includes(scope.event_type)) {
      throw invalid('Choose a saved event and event type');
    }
    return { mode: 'all_event', event_id: scope.event_id.toLowerCase(), event_type: scope.event_type };
  }
  if (scope?.mode !== 'selected' || !Array.isArray(scope.registrations)
    || !scope.registrations.length || scope.registrations.length > 1000) {
    throw invalid('Select between 1 and 1000 registrations, or choose all registrations for one event');
  }
  const identities = new Map();
  for (const row of scope.registrations) {
    if (!isReplayUuid(row?.booking_id) || !isReplayUuid(row?.event_id)
      || !['standard', 'complex'].includes(row?.booking_source)) {
      throw invalid('Every registration requires its saved event, booking ID and booking source');
    }
    const identity = {
      booking_id: row.booking_id.toLowerCase(), booking_source: row.booking_source,
      event_id: row.event_id.toLowerCase(),
    };
    const key = `${identity.booking_source}:${identity.booking_id}`;
    if (identities.has(key) && identities.get(key).event_id !== identity.event_id) {
      throw invalid('A registration cannot belong to two events');
    }
    identities.set(key, identity);
  }
  return { mode: 'selected', registrations: [...identities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) };
}

// Signed stateless preview continuations do not create attempts, outbox jobs,
// preview tables, certificates, attendance updates, or ledger entries.
export function replayTokenCodec(secret) {
  if (!secret) throw invalid('CPD preview signing is not configured', 503);
  const sign = text => crypto.createHmac('sha256', secret).update(`cpd-points-preview-v1:${text}`).digest('base64url');
  return {
    encode(payload) {
      const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${text}.${sign(text)}`;
    },
    decode(token, tenant, actor) {
      if (typeof token !== 'string' || token.length > 400000) throw invalid('Invalid preview token');
      const [text, signature, extra] = token.split('.');
      const expected = sign(text || '');
      if (extra || !signature || Buffer.byteLength(signature) !== Buffer.byteLength(expected)
        || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        throw invalid('Invalid preview token');
      }
      let value;
      try { value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); }
      catch { throw invalid('Invalid preview token'); }
      if (value.tenant !== tenant || value.actor !== actor) throw invalid('Preview belongs to another administrator or tenant', 403);
      if (!Number.isFinite(value.expires) || value.expires < Date.now()) {
        throw invalid('Preview expired. Review registrations again.', 409);
      }
      return value;
    },
  };
}

export function makeCpdPointsReplayHandler({ db, getContext, hasAdminAccess, hasFeatureAccess, signingSecret }) {
  return async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.tenantId || !context.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
      if (context.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
      if (!(await hasAdminAccess(context)) || (context.roleId
        && !(await hasFeatureAccess(context.roleId, 'events.event-report', context.memberExcludedFeatures)))) {
        return res.status(403).json({ error: 'Event Registration Report administrator permission is required' });
      }
      const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}`
        : context.memberId ? `member:${context.memberId}` : null;
      if (!actor) return res.status(403).json({ error: 'An identifiable administrator is required' });
      const tenant = context.tenantId;
      const rpc = async (name, args) => {
        const { data, error } = await db.rpc(name, args);
        if (error) {
          const message = error.message || '';
          if (/preview stale|request identity conflict/.test(message)) throw invalid(message, 409);
          if (/not found/.test(message)) throw invalid('Requested registrations or replay were not found', 404);
          if (/invalid |no eligible|reason and request/.test(message)) throw invalid(message);
          throw invalid('CPD evaluation could not be completed. No successful preview or award is implied. Please retry.', 503);
        }
        return data;
      };
      if (req.method === 'GET') {
        if (!req.query?.replay_id) {
          const { data, error } = await db.from('event_cpd_points_reprocessing_run')
            .select('id,reason,created_at,enqueued_count').eq('tenant_id', tenant)
            .order('created_at', { ascending: false }).order('id').limit(50);
          if (error) throw invalid('Could not load reprocessing history', 503);
          return res.status(200).json({ replays: (data || []).map(({ id, ...run }) => ({ replay_id: id, ...run })) });
        }
        if (!isReplayUuid(req.query.replay_id)) throw invalid('Invalid replay ID');
        const page = Number(req.query.page || 1);
        const pageSize = Number(req.query.page_size || 50);
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
          || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw invalid('Invalid results page');
        return res.status(200).json(await rpc('event_cpd_points_reprocessing_results', {
          p_tenant_id: tenant, p_replay_id: req.query.replay_id, p_page: page, p_page_size: pageSize,
        }));
      }
      const codec = replayTokenCodec(typeof signingSecret === 'function' ? signingSecret() : signingSecret);
      if (req.body?.action === 'preview') {
        const scope = normalizeReplayScope(req.body.scope);
        const cursor = req.body.cursor ? codec.decode(req.body.cursor, tenant, actor) : null;
        if (cursor && (cursor.complete || JSON.stringify(cursor.scope) !== JSON.stringify(scope))) {
          throw invalid('Preview scope changed. Start a new preview.', 409);
        }
        const result = await rpc('preview_event_cpd_points_reprocessing', {
          p_tenant_id: tenant, p_scope: scope, p_after: cursor?.after || null,
          p_digest: cursor?.digest || '', p_count: cursor?.totals.registrations || 0,
          p_eligible: cursor?.totals.eligible || 0, p_points: cursor?.totals.proposed_points || '0',
        });
        if (!result || !Array.isArray(result.rows) || typeof result.complete !== 'boolean'
          || !result.totals) {
          throw invalid('Preview evaluation is incomplete. No reprocessing has been queued.', 503);
        }
        if (result.evaluation_failed || result.rows.some(row => row.outcome === 'evaluation_error')) {
          return res.status(200).json({
            rows: result.rows, totals: result.totals, complete: false,
            evaluation_failed: true, cursor: null, preview_token: null,
            error: 'A registration could not be evaluated. Resolve the unavailable data and start a new preview. No reprocessing has been queued.',
          });
        }
        const token = codec.encode({
          tenant, actor, scope, expires: cursor?.expires || Date.now() + 60 * 60 * 1000,
          after: result.after, digest: result.digest, totals: result.totals, complete: result.complete,
        });
        return res.status(200).json({
          rows: result.rows, totals: result.totals, complete: result.complete,
          cursor: result.complete ? null : token,
          preview_token: result.complete && result.totals.eligible > 0 ? token : null,
        });
      }
      if (req.body?.action !== 'confirm') throw invalid('Use a read-only preview before confirming reprocessing');
      if (req.body.confirmed !== true || !isReplayUuid(req.body.request_id)) throw invalid('Explicit confirmation and a stable request ID are required');
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason || reason.length > 500) throw invalid('A reason of at most 500 characters is required');
      const preview = codec.decode(req.body.preview_token, tenant, actor);
      if (!preview.complete || !(preview.totals?.eligible > 0)) throw invalid('A complete eligible preview is required');
      return res.status(202).json(await rpc('confirm_event_cpd_points_reprocessing', {
        p_tenant_id: tenant, p_actor: actor, p_scope: preview.scope,
        p_digest: preview.digest, p_reason: reason, p_request_id: req.body.request_id,
      }));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'CPD reprocessing request failed. Please retry.' });
    }
  };
}
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const grantFields = 'id, voucher_id, speaker_id, speaker_name, event_type, event_id';
// Only the verified legacy-schema error permits dropping snapshot metadata.
const missingAgendaSnapshot = error => error?.code === '42703'
  && /^column (?:speaker_award_grant\.agenda_snapshot|"speaker_award_grant"\."agenda_snapshot") does not exist$/.test(error.message || '');
const safeCode = error => typeof error?.code === 'string'
  && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(error.code) ? error.code : 'UNKNOWN';

// This endpoint only reads existing voucher links. Codes/descriptions are never
// provenance, and redemption transactions describe a different event.
export function createVoucherAwardOriginsHandler({
  db = supabase, tenantContext = getTenantContext, adminAccess = hasAdminAccess,
  diagnostic = context => console.warn('[voucher-award-origins]', context),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    let stage = 'authorization';
    try {
      const ctx = await tenantContext(req);
      if (ctx?.tenantMismatch) return res.status(409).json({ code: 'TENANT_CONTEXT_CHANGED', error: 'Tenant context changed' });
      if (!ctx?.isAuthenticated || !ctx.tenantId || !await adminAccess(ctx)) {
        return res.status(403).json({ error: 'Tenant administrator access required' });
      }
      const requested = req.body?.voucher_ids;
      if (!Array.isArray(requested) || !requested.length || requested.length > 100 || requested.some(id => !uuid(id))) {
        return res.status(400).json({ error: 'Provide between 1 and 100 valid voucher identifiers' });
      }
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      const read = async (lookupStage, query) => {
        stage = lookupStage;
        const { data, error } = await query;
        if (error) throw error;
        if (!Array.isArray(data)) throw new Error('Origin lookup failed');
        return data;
      };
      const vouchers = await read('voucher', db.from('voucher').select('id, organization_id, member_id')
        .eq('tenant_id', ctx.tenantId).in('id', [...new Set(requested)]));
      const eligible = vouchers.filter(v => v.organization_id && !v.member_id);
      const origins = {};
      if (!eligible.length) return res.status(200).json({ origins });
      const grants = [];
      let useSnapshot = true;
      const grantPage = offset => read(useSnapshot ? 'grants_snapshot' : 'grants_legacy',
        db.from('speaker_award_grant')
          .select(`${grantFields}${useSnapshot ? ', agenda_snapshot' : ''}`)
          .eq('tenant_id', ctx.tenantId).in('voucher_id', eligible.map(v => v.id))
          .order('id', { ascending: true }).range(offset, offset + 199));
      for (let offset = 0; ; offset += 200) {
        let rows;
        try {
          rows = await grantPage(offset);
        } catch (error) {
          if (!useSnapshot || !missingAgendaSnapshot(error)) throw error;
          diagnostic({ stage, code: safeCode(error), outcome: 'legacy_fallback' });
          useSnapshot = false;
          rows = await grantPage(offset);
        }
        grants.push(...rows);
        if (rows.length < 200) break;
      }
      const speakers = new Map();
      const speakerIds = [...new Set(grants.filter(g => !text(g.speaker_name)).map(g => g.speaker_id).filter(Boolean))];
      if (speakerIds.length) {
        for (let i = 0; i < speakerIds.length; i += 100) {
          const rows = await read('speaker', db.from('speaker').select('id, full_name')
            .eq('tenant_id', ctx.tenantId).in('id', speakerIds.slice(i, i + 100)));
          rows.forEach(s => speakers.set(s.id, text(s.full_name)));
        }
      }
      const events = new Map();
      for (const type of ['event', 'complex_event']) {
        const eventIds = [...new Set(grants.filter(g => g.event_type === type).map(g => g.event_id).filter(Boolean))];
        for (let i = 0; i < eventIds.length; i += 100) {
          const rows = await read(type, db.from(type).select('id, title, internal_reference')
            .eq('tenant_id', ctx.tenantId).in('id', eventIds.slice(i, i + 100)));
          rows.forEach(e => events.set(`${type}:${e.id}`, e));
        }
      }
      for (const grant of grants) {
        // Keep all actual links rather than arbitrarily inventing a single
        // origin if historical data happens to link a voucher more than once.
        const event = events.get(`${grant.event_type}:${grant.event_id}`);
        const origin = {
          speaker: text(grant.speaker_name) || speakers.get(grant.speaker_id) || null,
          event: text(grant.agenda_snapshot?.event_title) || text(event?.title),
          event_internal_reference: text(event?.internal_reference),
        };
        (origins[grant.voucher_id] ||= []).push(origin);
      }
      return res.status(200).json({ origins });
    } catch (error) {
      // No IDs, messages, details, hints, stacks or request data in diagnostics.
      diagnostic({ stage, code: safeCode(error), outcome: 'failed' });
      return res.status(503).json({ error: 'Unable to load speaker award origins. Please retry.' });
    }
  };
}

export default createVoucherAwardOriginsHandler();

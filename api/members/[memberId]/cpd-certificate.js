import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { makeFeatureAccessChecker, resolveMemberExclusions } from '../../_lib/memberFeatureAccess.js';
import { resolveMember } from '../../_lib/eventCpdBadgeService.js';
import { resolveAttendeeCertificate, renderAttendeeCertificate } from '../../_lib/attendeeCpdCertificate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sources = { booking: 'standard', complex_event_booking: 'complex' };
const unavailable = reason => ({ available: false, reason, retryable: false, filename: null });

async function one(db, table, tenantId, id) {
  const { data, error } = await db.from(table).select('*')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function eligibility(db, tenantId, memberId, entryId) {
  const row = await one(db, 'member_cpd_points_ledger', tenantId, entryId);
  if (!row || String(row.member_id) !== String(memberId) || row.entry_kind !== 'event_award'
    || !(Number(row.points_value) > 0) || !sources[row.booking_type]
    || row.event_type !== (row.booking_type === 'booking' ? 'event' : 'complex_event')
    || !row.event_id || !row.booking_id) {
    return null;
  }
  const { data: reversals, error } = await db.from('member_cpd_points_ledger').select('id')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('reversal_of', entryId).limit(1);
  if (error) throw error;
  if (reversals?.length) return null;
  const booking = await one(db, row.booking_type, tenantId, row.booking_id);
  if (!booking || String(booking.event_id) !== String(row.event_id)
    || booking.status !== 'confirmed'
    || String(await resolveMember(db, tenantId, booking)) !== String(memberId)) return null;
  const event = await one(db, row.event_type, tenantId, row.event_id);
  if (!event) return null;
  return row;
}

export function createMemberCpdCertificateHandler(deps = {}) {
  const db = deps.db || supabase;
  const sessionMember = deps.getSessionMember || getSessionMember;
  const tenantContext = deps.getTenantContext || getTenantContext;
  const adminAccess = deps.hasAdminAccess || hasAdminAccess;
  const resolveExclusions = deps.resolveMemberExclusions || resolveMemberExclusions;
  const resolveCertificate = deps.resolveAttendeeCertificate || resolveAttendeeCertificate;
  const render = deps.renderAttendeeCertificate || renderAttendeeCertificate;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const memberId = req.query?.memberId;
      let tenantId = null;
      const ownMember = await sessionMember(req).catch(() => null);
      if (ownMember?.id && String(ownMember.id) === String(memberId) && ownMember.role_id) {
        try {
          const exclusions = await resolveExclusions({
            roleId: ownMember.role_id, memberExcludedFeatures: ownMember.member_excluded_features,
          }, db, { requireRole: true });
          if (makeFeatureAccessChecker(exclusions).canAccessFeature('cpd.member_cpd')) {
            tenantId = ownMember.tenant_id || ownMember.organization?.tenant_id || null;
          }
        } catch {
          // Self-service role resolution may fail; administration is independent.
        }
      }
      // History administration is independent of both self-service feature access
      // and CPD correction permissions. Never use the caller's member identity
      // or a request-supplied tenant to resolve the selected member's award.
      if (!tenantId) {
        const context = await tenantContext(req).catch(() => null);
        if (context?.tenantId && !context.tenantMismatch && await adminAccess(context)) {
          tenantId = context.tenantId;
        }
      }
      if (!tenantId || !memberId) return res.status(403).json({ error: 'Forbidden' });
      const { ledger_entry_id: singleId, ledger_entry_ids: batchIds, format } = req.query || {};
      if (batchIds !== undefined && singleId !== undefined) {
        return res.status(400).json({ error: 'Choose a single or batch certificate request' });
      }
      if (batchIds !== undefined) {
        if (typeof batchIds !== 'string' || format !== undefined) {
          return res.status(400).json({ error: 'Invalid certificate request' });
        }
        const ids = batchIds.split(',');
        if (!ids.length || ids.length > 20 || ids.some(id => !UUID.test(id)) || new Set(ids).size !== ids.length) {
          return res.status(400).json({ error: 'Provide 1–20 distinct ledger entry IDs' });
        }
        const certificates = {};
        for (const id of ids) {
          try {
            const row = await eligibility(db, tenantId, memberId, id);
            if (!row) { certificates[id] = unavailable('Certificate unavailable for this award.'); continue; }
            const resolved = await resolveCertificate(db, {
              tenantId, bookingId: row.booking_id, bookingSource: sources[row.booking_type],
              memberCertificateId: memberId,
            });
            certificates[id] = resolved.available
              ? { available: true, reason: null, retryable: false, filename: `cpd-certificate-${id}.pdf` }
              : unavailable(resolved.reason || 'Certificate unavailable for this award.');
          } catch {
            certificates[id] = { ...unavailable('Certificate could not be prepared. Try again.'), retryable: true };
          }
        }
        return res.status(200).json({ certificates });
      }
      if (typeof singleId !== 'string' || !UUID.test(singleId) || format !== 'pdf') {
        return res.status(400).json({ error: 'A valid ledger_entry_id and format=pdf are required' });
      }
      const row = await eligibility(db, tenantId, memberId, singleId);
      if (!row) return res.status(404).json({ error: 'Certificate unavailable for this award.' });
      const input = { tenantId, bookingId: row.booking_id, bookingSource: sources[row.booking_type],
        memberCertificateId: memberId };
      const resolved = await resolveCertificate(db, input);
      if (!resolved.available) return res.status(409).json({ error: resolved.reason || 'Certificate unavailable.' });
      const pdf = await render(db, resolved);
      const currentRow = await eligibility(db, tenantId, memberId, singleId);
      if (!currentRow || ['booking_id', 'booking_type', 'event_id', 'points_value']
        .some(key => String(currentRow[key]) !== String(row[key]))) {
        return res.status(409).json({ error: 'Award changed. Reload before downloading.' });
      }
      const current = await resolveCertificate(db, input);
      if (!current.available || current.fingerprint !== resolved.fingerprint) {
        return res.status(409).json({ error: 'Certificate changed. Reload before downloading.' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cpd-certificate-${singleId}.pdf"`);
      return res.status(200).send(pdf);
    } catch {
      return res.status(503).json({ error: 'Certificate could not be prepared. Try again.' });
    }
  };
}

export default createMemberCpdCertificateHandler();
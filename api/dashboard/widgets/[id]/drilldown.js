import { supabase } from '../../../_lib/database.js';
import { getDashboardActor, tenantFilter } from '../../_lib/permissions.js';
import { runWidgetConfig, MAX_LIST_GROUPS } from '../../_lib/aggregation.js';
import { getSourceDef } from '../../_lib/sources.js';

// Hard cap on the number of record ids returned to the client. Buckets
// bigger than this are truncated (flagged in the response) — the CRM list
// filter uses an id IN-list, which cannot grow unbounded.
const MAX_DRILLDOWN_IDS = 2000;

// Sources whose base rows are directly openable in a CRM list page.
const DRILLABLE = {
  organization: 'organization',
  member: 'member',
};

/**
 * POST /api/dashboard/widgets/:id/drilldown  { key: "<bucket key>" }
 *
 * Re-runs the widget's aggregation with row-id collection enabled and
 * returns the ids of the base records behind ONE grouped bucket, so the
 * client can open /organisations or /members filtered to exactly those
 * records. Only organisation / member sourced widgets with a group-by
 * are drillable.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const actor = await getDashboardActor(req);
  if (!actor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!actor.permissions.view) {
    return res.status(403).json({ error: 'Dashboard not available for this role' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { id } = req.query || {};
  if (!id) return res.status(400).json({ error: 'Widget id is required' });
  const key = typeof req.body?.key === 'string' ? req.body.key : null;
  if (key === null) {
    return res.status(400).json({ error: 'Bucket key is required' });
  }

  let query = supabase.from('dashboard_widget').select('*').eq('id', id);
  query = tenantFilter(query, actor.tenantId);
  const { data: widget, error } = await query.single();
  if (error || !widget) {
    return res.status(404).json({ error: 'Widget not found' });
  }
  if (widget.scope === 'personal' && widget.owner_member_id !== actor.memberId) {
    return res.status(404).json({ error: 'Widget not found' });
  }

  const config = widget.config || {};
  const sourceDef = getSourceDef(config.source);
  // Event Bookings widgets drill to the ORGANISATIONS behind a bucket
  // (bookings have no CRM list page): both the participation split
  // (Booked / Not booked org lists) and booking group-bys (distinct
  // organisations with a booking in the bucket) return organisation ids.
  const isBooking = !!sourceDef?.isBooking;
  const entity = isBooking ? 'organization' : (sourceDef ? DRILLABLE[sourceDef.table] : null);
  const hasDrillableShape = isBooking
    ? (!!config.groupBy || config.participation === true)
    : !!config.groupBy;
  if (!entity || !hasDrillableShape || config.clickThrough !== true) {
    return res.status(400).json({ error: 'This widget does not support click-through' });
  }

  try {
    const result = await runWidgetConfig(config, actor.tenantId, {
      maxGroups: widget.widget_type === 'list' ? MAX_LIST_GROUPS : undefined,
      collectRowIds: true,
    });
    const row = (result.rows || []).find(r => r.key === key);
    if (!row) {
      return res.status(404).json({ error: 'No records found for this group' });
    }
    const allIds = Array.isArray(row.rowIds) ? row.rowIds : [];
    const ids = allIds.slice(0, MAX_DRILLDOWN_IDS);
    return res.status(200).json({
      entity,
      key,
      ids,
      total: allIds.length,
      truncated: allIds.length > ids.length,
    });
  } catch (err) {
    console.error('[Dashboard Widgets] Drilldown failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to run drilldown' });
  }
}

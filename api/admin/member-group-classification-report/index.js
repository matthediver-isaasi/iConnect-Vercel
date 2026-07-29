// Task #3223: Member Group Classification activity report (tenant-admin only).
//
//   GET ?classification_id=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns one row per member group in the classification with:
//   - date-independent counts: total members, leadership team members
//     (assignments whose group_role is in the group's leadership_roles) and
//     co-convenors (group_role name matches "Co-Convenor", case/hyphen
//     tolerant),
//   - date-ranged counts: group-scoped email campaigns by sent_at, vacancies
//     by created_at, group-scoped resources by created_at, and events held
//     (standard + complex, linked to the group, start_date in range, drafts
//     excluded).
//
// Admin RBAC via getTenantContext + hasAdminAccess (never
// getTenantIdFromSession — membership alone is not enough), plus the
// membership.member-group-classification-report feature key for member
// sessions so Role Management exclusions are enforced server-side.
//
// All reads page through PostgREST explicitly (ordered .range windows) so
// tenants with >1000 rows are never silently capped.

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';

const FEATURE_KEY = 'membership.member-group-classification-report';
const PAGE_SIZE = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Co-Convenor" / "co convenor" / "CoConvenor" all match.
function isCoConvenorRole(roleName) {
  if (!roleName || typeof roleName !== 'string') return false;
  return roleName.toLowerCase().replace(/[^a-z0-9]/g, '') === 'coconvenor';
}

// Fetch every row of a query, paging explicitly past PostgREST's row cap.
// buildQuery must return a fresh query each call (filters + select applied);
// ordering by id keeps pages stable (see postgrest-pagination-order).
async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery()
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

// Chunk .in() lists so very large classifications never overflow the URL.
function chunk(arr, size = 150) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAllRowsForGroups(groupIds, buildQuery) {
  const rows = [];
  for (const ids of chunk(groupIds)) {
    const part = await fetchAllRows(() => buildQuery(ids));
    rows.push(...part);
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  let ctx;
  try {
    ctx = await getTenantContext(req);
  } catch {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!ctx?.isAuthenticated || !ctx?.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  // Member-based admins must also hold the report's feature key so Role
  // Management exclusions bite. Tenant-user sessions bypass role checks.
  if (!ctx.tenantUserId && ctx.roleId) {
    const allowed = await hasFeatureAccess(ctx.roleId, FEATURE_KEY);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this report.' });
    }
  }

  const tenantId = ctx.tenantId;
  const { classification_id: classificationId, from, to } = req.query || {};

  if (!classificationId) {
    return res.status(400).json({ error: 'classification_id is required' });
  }
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'to must not be before from' });
  }

  // Inclusive range: [from 00:00, to end-of-day). Timestamp columns compare
  // against toExclusive; date-only columns compare against to directly.
  const fromTs = `${from}T00:00:00.000Z`;
  const toExclusive = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000)
    .toISOString();

  try {
    // Classification must belong to this tenant.
    const { data: classification, error: clErr } = await supabase
      .from('member_group_classification')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('id', classificationId)
      .maybeSingle();
    if (clErr) throw new Error(clErr.message);
    if (!classification) {
      return res.status(404).json({ error: 'Classification not found' });
    }

    const groups = await fetchAllRows(() =>
      supabase
        .from('member_group')
        .select('id, name, is_active, leadership_roles')
        .eq('tenant_id', tenantId)
        .eq('classification_id', classificationId)
    );

    const groupIds = groups.map((g) => g.id);
    const rowByGroupId = {};
    for (const g of groups) {
      rowByGroupId[g.id] = {
        group_id: g.id,
        group_name: g.name || '',
        is_active: g.is_active !== false,
        total_members: 0,
        leadership_members: 0,
        co_convenors: 0,
        emails_sent: 0,
        vacancies_posted: 0,
        resources_uploaded: 0,
        events_held: 0,
      };
    }

    if (groupIds.length > 0) {
      const leadershipByGroup = {};
      for (const g of groups) {
        leadershipByGroup[g.id] = new Set(
          Array.isArray(g.leadership_roles) ? g.leadership_roles : []
        );
      }

      // --- Assignments: total / leadership / co-convenor (date independent) ---
      const assignments = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('member_group_assignment')
          .select('id, group_id, group_role')
          .eq('tenant_id', tenantId)
          .in('group_id', ids)
      );
      for (const a of assignments) {
        const row = rowByGroupId[a.group_id];
        if (!row) continue;
        row.total_members += 1;
        if (a.group_role && leadershipByGroup[a.group_id]?.has(a.group_role)) {
          row.leadership_members += 1;
        }
        if (isCoConvenorRole(a.group_role)) {
          row.co_convenors += 1;
        }
      }

      // --- Emails sent: group-scoped campaigns by sent date ---
      const campaigns = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('email_campaign')
          .select('id, member_group_id')
          .eq('tenant_id', tenantId)
          .in('member_group_id', ids)
          .not('sent_at', 'is', null)
          .gte('sent_at', fromTs)
          .lt('sent_at', toExclusive)
      );
      for (const c of campaigns) {
        const row = rowByGroupId[c.member_group_id];
        if (row) row.emails_sent += 1;
      }

      // --- Volunteer roles posted: vacancies by created date ---
      const vacancies = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('vacancy')
          .select('id, member_group_id')
          .eq('tenant_id', tenantId)
          .in('member_group_id', ids)
          .gte('created_at', fromTs)
          .lt('created_at', toExclusive)
      );
      for (const v of vacancies) {
        const row = rowByGroupId[v.member_group_id];
        if (row) row.vacancies_posted += 1;
      }

      // --- Resources uploaded: group-scoped resources by date ---
      // The resource table has no created_at column in DEST; release_date is
      // the only creation-adjacent timestamp (defaulted to upload time by the
      // editors), so the range filter uses it.
      const resources = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('resource')
          .select('id, member_group_id')
          .eq('tenant_id', tenantId)
          .in('member_group_id', ids)
          .gte('release_date', fromTs)
          .lt('release_date', toExclusive)
      );
      for (const r of resources) {
        const row = rowByGroupId[r.member_group_id];
        if (row) row.resources_uploaded += 1;
      }

      // --- Events held ---
      // Draft detection mirrors the Events page: `status` stores timing
      // (published/tbc/draft on legacy rows), `event_state` stores visibility.
      // A row is draft when event_state === 'draft', or when event_state is
      // unset and the legacy status === 'draft'. This must run in JS — a
      // PostgREST .neq('event_state','draft') would also silently drop rows
      // whose event_state is NULL.
      const isDraftEvent = (row) =>
        row.event_state === 'draft' || (!row.event_state && row.status === 'draft');

      // Standard events with a start date in range.
      const events = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('event')
          .select('id, member_group_id, is_complex, status, event_state')
          .eq('tenant_id', tenantId)
          .in('member_group_id', ids)
          .not('start_date', 'is', null)
          .gte('start_date', fromTs)
          .lt('start_date', toExclusive)
      );
      for (const ev of events) {
        // Complex events live in complex_event; never count via the event row.
        if (ev.is_complex) continue;
        if (isDraftEvent(ev)) continue;
        const row = rowByGroupId[ev.member_group_id];
        if (row) row.events_held += 1;
      }

      // Complex events linked to the group. These carry two independent
      // draft signals (status AND event_state) — exclude either.
      const complexEvents = await fetchAllRowsForGroups(groupIds, (ids) =>
        supabase
          .from('complex_event')
          .select('id, member_group_id, status, event_state')
          .eq('tenant_id', tenantId)
          .in('member_group_id', ids)
          .not('start_date', 'is', null)
          .gte('start_date', fromTs)
          .lt('start_date', toExclusive)
      );
      for (const ce of complexEvents) {
        if (ce.event_state === 'draft' || ce.status === 'draft') continue;
        const row = rowByGroupId[ce.member_group_id];
        if (row) row.events_held += 1;
      }
    }

    const rows = groups
      .map((g) => rowByGroupId[g.id])
      .sort((a, b) => (a.group_name || '').localeCompare(b.group_name || ''));

    const totals = {
      total_members: 0,
      leadership_members: 0,
      co_convenors: 0,
      emails_sent: 0,
      vacancies_posted: 0,
      resources_uploaded: 0,
      events_held: 0,
    };
    for (const r of rows) {
      for (const key of Object.keys(totals)) totals[key] += r[key];
    }

    return res.json({
      success: true,
      classification: { id: classification.id, name: classification.name },
      from,
      to,
      groupCount: rows.length,
      rows,
      totals,
    });
  } catch (err) {
    console.error('[member-group-classification-report] error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to build the classification report' });
  }
}

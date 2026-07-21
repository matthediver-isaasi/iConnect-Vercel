// Task #2969: Form Conversion Report.
//
// Standalone admin report reusing the dashboard form-conversion widget's
// semantics (api/dashboard/_lib/aggregation.js): distinct entities
// (organisations, or members keyed by lowercased submitter email) that
// submitted BOTH a source form and a target form. Unlike the widget, this
// endpoint also returns the entity rows themselves with submission dates and
// a conversion status, filtered by a `comparison` param.
//
// Date-range semantics mirror the widget exactly: dateFrom/dateTo scope the
// TARGET form's submissions only — a conversion counts when the target
// submission falls inside the range, regardless of when the source happened.
//
// RBAC: gated by the `forms.conversion-report` feature key. Admins bypass;
// members whose effective exclusions include the key get 403.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getSessionMember } from '../_lib/session.js';
import {
  resolveMemberExclusions,
  makeFeatureAccessChecker,
} from '../_lib/memberFeatureAccess.js';
import { escapeCsvCell, CSV_BOM, CSV_ROW_SEPARATOR } from '../_lib/csvCell.js';

const PAGE_SIZE = 1000;
const MAX_TOTAL_ROWS = 50000;
const FEATURE_KEY = 'forms.conversion-report';

// Paginate every submission of a single form for a tenant past PostgREST's
// 1000-row page cap. Optional created_date range (whole days, inclusive).
async function fetchFormSubmissions(formId, tenantId, { dateFrom, dateTo } = {}) {
  const rows = [];
  for (let from = 0; from < MAX_TOTAL_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_TOTAL_ROWS - 1);
    let query = supabase
      .from('form_submission')
      .select('id, organization_id, submitted_by_email, created_date')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      // Stable ordering is required for .range() pagination.
      .order('id', { ascending: true });
    if (dateFrom) {
      query = query.gte('created_date', new Date(dateFrom + 'T00:00:00.000Z').toISOString());
    }
    if (dateTo) {
      const toDate = new Date(dateTo + 'T00:00:00.000Z');
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      query = query.lt('created_date', toDate.toISOString());
    }
    const { data: page, error } = await query.range(from, to);
    if (error) {
      throw new Error(`Failed to fetch form submissions: ${error.message}`);
    }
    rows.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
    if (rows.length >= MAX_TOTAL_ROWS) {
      throw new Error(
        `Report would scan more than ${MAX_TOTAL_ROWS} rows. Add a date range to narrow the dataset.`
      );
    }
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId || !ctx.isAuthenticated) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { tenantId } = ctx;

    // RBAC: admins bypass; members are checked against their effective
    // (role + per-member) feature exclusions. Fail closed on resolver errors.
    const isAdmin = await hasAdminAccess(ctx);
    if (!isAdmin) {
      const member = await getSessionMember(req);
      if (!member) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const exclusions = await resolveMemberExclusions(
        {
          roleId: member.role_id,
          memberExcludedFeatures: member.member_excluded_features,
        },
        supabase
      );
      const access = makeFeatureAccessChecker(exclusions);
      if (!access.canAccessFeature(FEATURE_KEY)) {
        return res.status(403).json({
          error: 'You do not have access to the Form Conversion Report.',
          code: 'feature_excluded',
        });
      }
    }

    const {
      sourceFormId,
      targetFormId,
      matchBy,
      comparison = 'all',
      dateFrom,
      dateTo,
      page = '1',
      pageSize = '25',
      export: exportMode,
    } = req.query;

    if (!sourceFormId || !targetFormId) {
      return res.status(400).json({ error: 'Choose both a source form and a target form' });
    }
    if (sourceFormId === targetFormId) {
      return res.status(400).json({ error: 'Source and target forms must be different' });
    }
    if (matchBy !== 'organization' && matchBy !== 'member') {
      return res.status(400).json({ error: 'Match by must be organization or member' });
    }
    if (!['all', 'converted', 'not_converted'].includes(comparison)) {
      return res.status(400).json({ error: 'Invalid comparison filter' });
    }

    // Both forms must belong to this tenant.
    const { data: forms, error: formErr } = await supabase
      .from('form')
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', [sourceFormId, targetFormId]);
    if (formErr) {
      console.error('[Form Conversion Report] Failed to verify forms:', formErr);
      return res.status(500).json({ error: 'Failed to verify forms' });
    }
    const foundIds = new Set((forms || []).map((f) => f.id));
    if (!foundIds.has(sourceFormId) || !foundIds.has(targetFormId)) {
      return res.status(400).json({ error: 'One or both selected forms no longer exist' });
    }

    const [sourceRows, targetRows] = await Promise.all([
      fetchFormSubmissions(sourceFormId, tenantId),
      fetchFormSubmissions(targetFormId, tenantId, { dateFrom, dateTo }),
    ]);

    // Rows without a usable match key (no organisation / blank email) can
    // never convert, so they're skipped when building the key maps — but
    // they still count toward the raw submission totals.
    const keyOf = (row) => {
      if (matchBy === 'organization') return row.organization_id || null;
      const email =
        typeof row.submitted_by_email === 'string'
          ? row.submitted_by_email.trim().toLowerCase()
          : '';
      return email || null;
    };

    // key -> sorted submission dates (source & target separately)
    const sourceDates = new Map();
    for (const row of sourceRows) {
      const key = keyOf(row);
      if (!key) continue;
      if (!sourceDates.has(key)) sourceDates.set(key, []);
      if (row.created_date) sourceDates.get(key).push(row.created_date);
    }
    const targetDates = new Map();
    for (const row of targetRows) {
      const key = keyOf(row);
      if (!key) continue;
      if (!targetDates.has(key)) targetDates.set(key, []);
      if (row.created_date) targetDates.get(key).push(row.created_date);
    }

    let convertedCount = 0;
    for (const key of sourceDates.keys()) {
      if (targetDates.has(key)) convertedCount += 1;
    }
    const sourceEntityCount = sourceDates.size;
    const conversionRate =
      sourceEntityCount > 0 ? (convertedCount / sourceEntityCount) * 100 : null;

    // Build the full entity row list from SOURCE entities (the funnel's
    // population), applying the comparison filter.
    let allRows = [];
    for (const [key, dates] of sourceDates) {
      const converted = targetDates.has(key);
      if (comparison === 'converted' && !converted) continue;
      if (comparison === 'not_converted' && converted) continue;
      allRows.push({
        key,
        converted,
        sourceDates: [...dates].sort(),
        targetDates: converted ? [...targetDates.get(key)].sort() : [],
      });
    }

    // Resolve organisation names for org mode; sort rows by display name.
    if (matchBy === 'organization') {
      const orgIds = allRows.map((r) => r.key);
      const nameById = new Map();
      for (let i = 0; i < orgIds.length; i += 200) {
        const chunk = orgIds.slice(i, i + 200);
        const { data: orgs, error: orgErr } = await supabase
          .from('organization')
          .select('id, name')
          .eq('tenant_id', tenantId)
          .in('id', chunk);
        if (orgErr) {
          console.error('[Form Conversion Report] Failed to fetch organisations:', orgErr);
          break;
        }
        for (const o of orgs || []) nameById.set(o.id, o.name);
      }
      for (const r of allRows) {
        r.name = nameById.get(r.key) || '(Unknown organisation)';
      }
      allRows.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // Resolve member ids so the client can link each email to the member
      // record. Emails are stored lowercased (row keys already are); lookup is
      // tenant-scoped and chunked to dodge long IN lists / the 1000-row cap.
      const emails = allRows.map((r) => r.key);
      const memberIdByEmail = new Map();
      for (let i = 0; i < emails.length; i += 200) {
        const chunk = emails.slice(i, i + 200);
        const { data: members, error: memberErr } = await supabase
          .from('member')
          .select('id, email')
          .eq('tenant_id', tenantId)
          .in('email', chunk);
        if (memberErr) {
          console.error('[Form Conversion Report] Failed to fetch members:', memberErr);
          break;
        }
        for (const m of members || []) {
          if (typeof m.email === 'string') {
            const key = m.email.trim().toLowerCase();
            if (!memberIdByEmail.has(key)) memberIdByEmail.set(key, m.id);
          }
        }
      }
      for (const r of allRows) {
        r.name = r.key;
        r.memberId = memberIdByEmail.get(r.key) || null;
      }
      allRows.sort((a, b) => a.name.localeCompare(b.name));
    }

    // CSV export: stream ALL matching rows (no pagination) with the same
    // filters/RBAC as the on-screen report.
    if (exportMode === '1' || exportMode === 'csv') {
      const header = [
        matchBy === 'organization' ? 'Organisation' : 'Email',
        ...(matchBy === 'organization' ? ['Organisation ID'] : []),
        'Status',
        'Source submitted',
        'Target submitted',
      ];
      const lines = [header.map(escapeCsvCell).join(',')];
      for (const r of allRows) {
        const cols = [
          r.name,
          ...(matchBy === 'organization' ? [r.key] : []),
          r.converted ? 'Converted' : 'Not converted',
          r.sourceDates.join('; '),
          r.targetDates.join('; '),
        ];
        lines.push(cols.map(escapeCsvCell).join(','));
      }
      const filename = `form-conversion-report-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // BOM so Excel opens UTF-8 correctly.
      return res
        .status(200)
        .send(CSV_BOM + lines.join(CSV_ROW_SEPARATOR) + CSV_ROW_SEPARATOR);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sizeNum = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 25));
    const totalRows = allRows.length;
    const start = (pageNum - 1) * sizeNum;
    const pagedRows = allRows.slice(start, start + sizeNum);

    return res.status(200).json({
      stats: {
        sourceSubmissionCount: sourceRows.length,
        targetSubmissionCount: targetRows.length,
        sourceEntityCount,
        targetEntityCount: targetDates.size,
        convertedCount,
        notConvertedCount: sourceEntityCount - convertedCount,
        conversionRate,
      },
      matchBy,
      comparison,
      rows: pagedRows,
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / sizeNum)),
      },
    });
  } catch (error) {
    console.error('[Form Conversion Report] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

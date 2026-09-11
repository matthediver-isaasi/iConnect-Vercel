import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';

const HISTORY_PERMISSION = 'commerce.history';

const PERSONAL_COLUMNS = [
  'id',
  'tenant_id',
  'member_id',
  'membership_year',
  'tier_label',
  'band_id',
  'annual_cost',
  'prorata_cost',
  'free_period_discount',
  'rollover_discount',
  'custom_discount_total',
  'final_cost',
  'currency',
  'xero_invoice_id',
  'xero_invoice_number',
  'accounting_provider',
  'accounting_invoice_id',
  'accounting_invoice_number',
  'purchase_order_number',
  'payment_method',
  'stripe_payment_intent_id',
  'status',
  'created_at',
  'vat_rate_percent',
  'vat_amount',
  'total_with_vat',
].join(', ');

const ORGANISATION_COLUMNS = [
  'id',
  'tenant_id',
  'organization_id',
  'membership_year',
  'tier_label',
  'band_id',
  'annual_cost',
  'prorata_cost',
  'free_period_discount',
  'rollover_discount',
  'custom_discount_total',
  'final_cost',
  'vat_rate',
  'currency',
  'xero_invoice_id',
  'xero_invoice_number',
  'accounting_provider',
  'accounting_invoice_id',
  'accounting_invoice_number',
  'purchase_order_number',
  'payment_method',
  'stripe_payment_intent_id',
  'status',
  'created_at',
].join(', ');

/**
 * Membership years are normally strings such as "2025/2026". Sorting by the
 * first year keeps those values in chronological order without depending on
 * the database's string collation. The remaining sort keys are deliberately
 * applied in JavaScript after combining the two ledgers so that the response
 * order is stable even when either query returns rows in a different order.
 */
function membershipYearValue(value) {
  const match = String(value ?? '').trim().match(/^(-?\d+)/);
  if (!match) return Number.NEGATIVE_INFINITY;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function timestampValue(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareDescending(a, b) {
  if (a === b) return 0;
  if (a === Number.NEGATIVE_INFINITY) return 1;
  if (b === Number.NEGATIVE_INFINITY) return -1;
  return b - a;
}

export function compareMembershipHistory(a, b) {
  const yearDifference = compareDescending(
    membershipYearValue(a.membership_year),
    membershipYearValue(b.membership_year),
  );
  if (yearDifference !== 0) return yearDifference;

  const createdDifference = compareDescending(
    timestampValue(a.created_at),
    timestampValue(b.created_at),
  );
  if (createdDifference !== 0) return createdDifference;

  const sourceOrder = { personal: 0, organisation: 1 };
  const sourceDifference = (sourceOrder[a.membership_source] ?? 99)
    - (sourceOrder[b.membership_source] ?? 99);
  if (sourceDifference !== 0) return sourceDifference;

  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

async function fetchHistory(db, table, columns, tenantId, filterColumn, filterValue) {
  return db
    .from(table)
    .select(columns)
    .eq('tenant_id', tenantId)
    .eq(filterColumn, filterValue);
}

/**
 * Dependency injection keeps the endpoint executable in mocked endpoint tests
 * while the default export below remains the Vercel handler.
 */
export function createMemberHistoryHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;

  return async function handler(req, res) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    let sessionMember;
    let tenantContext;
    try {
      [sessionMember, tenantContext] = await Promise.all([
        getMember(req),
        getContext(req),
      ]);
    } catch (error) {
      console.error('[member-history] Error resolving authentication:', error);
      return res.status(500).json({ error: 'Failed to authenticate membership history request' });
    }

    if (!sessionMember && !tenantContext?.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (tenantContext?.tenantMismatch) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    const memberTenantId = sessionMember?.tenant_id
      || sessionMember?.organization?.tenant_id
      || null;
    if (memberTenantId && tenantContext?.tenantId
        && memberTenantId !== tenantContext.tenantId) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    const tenantId = memberTenantId || tenantContext?.tenantId;
    const organizationId = sessionMember?.organization_id || tenantContext?.organizationId;
    const memberId = sessionMember?.id || tenantContext?.memberId;
    if (!tenantId || !memberId) {
      return res.status(403).json({ error: 'Membership context required for history access' });
    }

    try {
      const adminCheckContext = sessionMember && !tenantContext?.tenantUserId
        ? {
          ...tenantContext,
          tenantId,
          memberId: sessionMember.id,
          roleId: sessionMember.role_id || null,
        }
        : tenantContext;
      const isAdmin = await checkAdmin(adminCheckContext);
      if (!isAdmin) {
        const roleId = sessionMember ? sessionMember.role_id : tenantContext?.roleId;
        const memberExcludedFeatures = sessionMember
          ? sessionMember.member_excluded_features
          : tenantContext?.memberExcludedFeatures;
        const canAccessHistory = !!roleId
          && await checkFeature(
            roleId,
            HISTORY_PERMISSION,
            memberExcludedFeatures,
          );
        if (!canAccessHistory) {
          return res.status(403).json({ error: 'Membership history access permission required' });
        }
      }

      const queries = [
        fetchHistory(
          db,
          'member_membership_history',
          PERSONAL_COLUMNS,
          tenantId,
          'member_id',
          memberId,
        ),
      ];

      // An organisation ledger is only relevant when this member is currently
      // assigned to an organisation. Personal history is always queried,
      // including for organisation-linked members.
      if (organizationId) {
        queries.push(fetchHistory(
          db,
          'organisation_membership_history',
          ORGANISATION_COLUMNS,
          tenantId,
          'organization_id',
          organizationId,
        ));
      }

      const results = await Promise.all(queries);
      for (const result of results) {
        if (result?.error) throw result.error;
      }

      const personalRows = (results[0]?.data || []).map((record) => ({
        ...record,
        membership_source: 'personal',
      }));
      const organisationRows = organizationId
        ? (results[1]?.data || []).map((record) => ({
          ...record,
          membership_source: 'organisation',
        }))
        : [];
      const records = [...personalRows, ...organisationRows];

      const bandIds = [...new Set(records.map((record) => record.band_id).filter(Boolean))];
      const bandMap = {};
      if (bandIds.length > 0) {
        const bandResult = await db
          .from('membership_tier_band')
          .select('id, label')
          .eq('tenant_id', tenantId)
          .in('id', bandIds);
        if (bandResult?.error) throw bandResult.error;
        for (const band of bandResult?.data || []) {
          bandMap[band.id] = band.label;
        }
      }

      const enriched = records
        .map((record) => ({
          ...record,
          band_label: record.band_id ? (bandMap[record.band_id] || null) : null,
        }))
        .sort(compareMembershipHistory);

      return res.json(enriched);
    } catch (error) {
      console.error('[member-history] Error fetching or enriching history:', error);
      return res.status(500).json({ error: 'Failed to fetch membership history' });
    }
  };
}

export default createMemberHistoryHandler();

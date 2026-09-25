import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { PAYMENT_REPORT_METHODS, projectMembershipPaymentReport, isEligiblePaymentReportMember } from '../../_lib/membershipPaymentReport.js';
import { resolvePaymentReportSchedules } from '../../_lib/membershipPaymentReportSchedules.js';
import { membershipPaymentReportCsv } from '../../_lib/membershipPaymentReportCsv.js';

const FEATURE = 'commerce.membership-payment-report';
const BATCH = 1000;

export async function fetchPaymentReportRows(db, table, columns, tenantId, refine = query => query) {
  const rows = [];
  for (let offset = 0; ; offset += BATCH) {
    const { data, error } = await refine(db.from(table).select(columns).eq('tenant_id', tenantId))
      .order('id', { ascending: true }).range(offset, offset + BATCH - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < BATCH) return rows;
  }
}

function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

// Preference values have no tenant_id. Both sides of this join must be scoped
// before fetching them; enrich only validated results for the projection contract.
export async function fetchPaymentReportPreferences(db, tenantId, members, configs, fields) {
  const memberIds = [...new Set(members.filter(row => isEligiblePaymentReportMember(row, tenantId)).map(row => row.id))];
  const ownedFields = new Set(fields.filter(row => row.tenant_id === tenantId).map(row => row.id));
  const fieldIds = [...new Set(configs.filter(row => row.tenant_id === tenantId
    && row.structure_scope_type === 'member' && ownedFields.has(row.structure_field_id))
    .map(row => row.structure_field_id))];
  const rows = [];
  // Small IN batches avoid oversized PostgREST URLs; each batch is independently paginated.
  for (let m = 0; m < memberIds.length && fieldIds.length; m += 100) {
    for (let f = 0; f < fieldIds.length; f += 100) {
      const owners = memberIds.slice(m, m + 100);
      const selectors = fieldIds.slice(f, f + 100);
      for (let offset = 0; ; offset += BATCH) {
        const { data, error } = await db.from('member_preference_value')
          .select('id,member_id,field_id,value').in('member_id', owners).in('field_id', selectors)
          .order('id', { ascending: true }).range(offset, offset + BATCH - 1);
        if (error) throw error;
        rows.push(...(data || []).filter(row => owners.includes(row.member_id) && selectors.includes(row.field_id))
          .map(row => ({ ...row, tenant_id: tenantId })));
        if (!data || data.length < BATCH) break;
      }
    }
  }
  return rows;
}

export function createMembershipPaymentReportHandler(deps = {}) {
  const db = deps.db === undefined ? supabase : deps.db;
  const getContext = deps.getTenantContext || getTenantContext;
  const checkAdmin = deps.hasAdminAccess || hasAdminAccess;
  const checkFeature = deps.hasFeatureAccess || hasFeatureAccess;
  return async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const ctx = await getContext(req);
      if (!ctx?.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Authentication required' });
      if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!await checkAdmin(ctx)) return res.status(403).json({ error: 'Admin access required' });
      if (!ctx.tenantUserId && (!ctx.roleId
        || !await checkFeature(ctx.roleId, FEATURE, ctx.memberExcludedFeatures))) {
        return res.status(403).json({ error: 'Membership Payment Report permission required' });
      }
      const method = req.query?.method ?? 'all';
      const format = req.query?.format ?? 'json';
      const rawSearch = req.query?.search ?? '';
      if (typeof rawSearch !== 'string' || rawSearch.length > 200) {
        return res.status(400).json({ error: 'Search must be text of at most 200 characters' });
      }
      const search = rawSearch.trim().toLowerCase();
      if (!['json', 'csv'].includes(format)) {
        return res.status(400).json({ error: 'Invalid report format' });
      }
      const page = integer(req.query?.page, 1, 1000000);
      const pageSize = integer(req.query?.pageSize, 25, 100);
      if (!page || !pageSize || !['all', ...PAYMENT_REPORT_METHODS.map(item => item.value)].includes(method)) {
        return res.status(400).json({ error: 'Invalid method, page or pageSize (maximum 100)' });
      }
      const tenantId = ctx.tenantId;
      const read = (table, columns, refine) => fetchPaymentReportRows(db, table, columns, tenantId, refine);
      const [members, history, agreements, plans, payments, configs, fields] = await Promise.all([
        // Core selectors vary by tenant configuration; only projected public fields leave the API.
        read('member', '*'),
        read('member_membership_history', 'id,tenant_id,member_id,tier_label,status,payment_method,billing_period,term_start_date,term_end_date,membership_renewal_date,term_key,commitment_snapshot,billing_agreement_id,membership_year,payment_status,currency,config_id,term_duration_months,notes,final_cost,total_with_vat'),
        read('membership_billing_agreements', 'id,tenant_id,member_id,organization_id,provider,environment,status,gocardless_mandate_id,stripe_subscription_id,stripe_customer_id,metadata',
          query => query.is('organization_id', null)),
        read('membership_payment_plans', 'id,tenant_id,member_id,organization_id,billing_agreement_id,provider,environment,status,interval_unit,created_at,gocardless_mandate_id,gocardless_subscription_id,stripe_subscription_id,collection_stopped_at,dynamic_next_collection_date,metadata',
          query => query.is('organization_id', null)),
        read('gocardless_payments', 'id,tenant_id,plan_id,environment,status,charge_date,gocardless_mandate_id,gocardless_subscription_id',
          query => query.in('status', ['pending_customer_approval', 'pending_submission', 'submitted'])
            .gte('charge_date', (deps.today || new Date().toISOString().slice(0, 10)))),
        read('membership_tier_config', 'id,tenant_id,name,is_active,structure_scope_type,structure_field_id,structure_match_value,effective_from,effective_to'),
        read('preference_field', 'id,tenant_id'),
      ]);
      const preferences = await fetchPaymentReportPreferences(db, tenantId, members, configs, fields);
      const input = { tenantId, members: members.filter(row => isEligiblePaymentReportMember(row, tenantId)),
        history, agreements, plans, payments, configs, preferences, today: deps.today };
      const providerSchedules = await (deps.resolveSchedules || resolvePaymentReportSchedules)(input);
      const rows = projectMembershipPaymentReport({ ...input, providerSchedules })
        .filter(row => (method === 'all' || row.paymentMethod === method)
          // Literal substring matching avoids SQL/PostgREST wildcard semantics.
          // Apply once to the complete projection for JSON totals, pages and CSV.
          && (!search || row.name.toLowerCase().includes(search)
            || (row.email || '').toLowerCase().includes(search)));
      if (format === 'csv') {
        const csv = membershipPaymentReportCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="membership-payment-report-${method}-${deps.today || new Date().toISOString().slice(0, 10)}.csv"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(csv);
      }
      const canViewMembers = !!ctx.tenantUserId || (!!ctx.roleId
        && await checkFeature(ctx.roleId, 'crm.members', ctx.memberExcludedFeatures));
      return res.json({ rows: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length, page, pageSize, methods: PAYMENT_REPORT_METHODS, canViewMembers });
    } catch (error) {
      console.error('[membership-payment-report]', error?.message);
      return res.status(500).json({ error: 'Membership payment report could not be loaded. Please try again.' });
    }
  };
}

export default createMembershipPaymentReportHandler();
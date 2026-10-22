import { administerVoucher } from './voucherCreditService.js';

const VOUCHER_FIELDS = new Set([
  'id', 'tenant_id', 'organization_id', 'member_id', 'code', 'value',
  'description', 'expires_at', 'issued_at', 'status', 'valid_from',
  'funding_source', 'notes', 'created_by', 'created_at', 'updated_at', 'currency',
]);
const TRANSACTION_FIELDS = new Set([
  'id', 'tenant_id', 'voucher_id', 'organization_id', 'member_id', 'type',
  'amount', 'balance_before', 'balance_after', 'created_at', 'booking_id',
  'notes', 'description',
]);
const WRITE_FIELDS = new Set([
  'organization_id', 'member_id', 'code', 'value', 'description',
  'expires_at', 'issued_at', 'status', 'valid_from', 'funding_source', 'notes', 'currency',
]);
export const VOUCHER_SETTING_KEYS = new Set([
  'individual_vouchers_enabled', 'organization_voucher_display_name', 'member_voucher_display_name',
  'xero_voucher_clearing_account_code', 'quickbooks_voucher_clearing_account_id',
  'xero_training_fund_clearing_account_code', 'quickbooks_training_fund_clearing_account_id',
  'xero_program_sales_account_code', 'quickbooks_program_sales_item_id',
  'xero_program_tax_code', 'quickbooks_program_tax_code', 'program_price_vat_rate_percent',
]);
const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function parseObject(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
  return parsed;
}

function filterQuery(query, filter, fields) {
  for (const [field, value] of Object.entries(filter)) {
    if (!fields.has(field)) throw new Error('Unsupported voucher filter');
    if (Array.isArray(value)) {
      query = query.in(field, value);
    } else if (value && typeof value === 'object') {
      for (const [op, operand] of Object.entries(value)) {
        if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'].includes(op)) {
          throw new Error('Unsupported voucher filter operator');
        }
        query = query[op](field, operand);
      }
    } else {
      query = value === null ? query.is(field, null) : query.eq(field, value);
    }
  }
  return query;
}

/**
 * Intercept before the generic pipeline: it historically assigns the caller's
 * organisation to missing owner fields and permits direct ledger writes.
 * Never use transaction.member_id for ownership: it may identify the spender.
 */
export async function handleVoucherEntity({ entity, id, req, res, context, db, hasAdminAccess }) {
  if (!['voucher', 'vouchertransaction'].includes(entity)) return false;
  const send = (status, payload) => { res.status(status).json(payload); return true; };
  if (!context.isAuthenticated) return send(401, { error: 'Authentication required' });
  if (context.tenantMismatch) return send(409, { error: 'Tenant context changed', code: 'TENANT_CONTEXT_CHANGED' });
  if (!uuid(context.tenantId)) return send(403, { error: 'Tenant context required' });
  if (id && !uuid(id)) return send(400, { error: 'Invalid voucher identifier' });
  const admin = await hasAdminAccess(context);
  const ledger = entity === 'vouchertransaction';

  try {
    if (req.method !== 'GET') {
      if (!admin) return send(403, { error: 'Voucher administration access required' });
      if (ledger) return send(403, { error: 'Voucher transactions are managed by the credit service' });
      const operation = !id && req.method === 'POST' ? 'issue'
        : id && ['PUT', 'PATCH'].includes(req.method) ? 'update'
        : id && req.method === 'DELETE' ? 'delete' : null;
      if (!operation) return send(405, { error: 'Method not allowed' });
      const body = req.body || {};
      const values = Object.fromEntries(Object.entries(body).filter(([key]) => WRITE_FIELDS.has(key)));
      const key = req.headers?.['idempotency-key'] || body.idempotency_key;
      if (operation === 'issue' && (typeof key !== 'string' || !key.trim() || key.length > 200)) {
        return send(400, { error: 'An idempotency key is required to issue credit' });
      }
      const result = await administerVoucher(db, {
        tenantId: context.tenantId, voucherId: id, operation, values,
        actor: context.tenantUserId || context.memberId,
        idempotencyKey: key || null,
      });
      return send(operation === 'issue' ? 201 : 200, result);
    }

    if (req.query?.expand) return send(400, { error: 'Voucher projections are not supported' });
    const wantsCount = req.query?.count === 'true';
    const projection = ledger ? '*,voucher!inner(id,tenant_id,organization_id,member_id)' : '*';
    let query = db.from(ledger ? 'voucher_transaction' : 'voucher')
      .select(projection, wantsCount ? { count: 'exact' } : undefined)
      .eq('tenant_id', context.tenantId);
    if (ledger) query = query.eq('voucher.tenant_id', context.tenantId);
    if (!admin) {
      const conditions = [];
      if (uuid(context.memberId)) conditions.push(`member_id.eq.${context.memberId}`);
      if (uuid(context.organizationId)) conditions.push(`organization_id.eq.${context.organizationId}`);
      if (!conditions.length) return id ? send(404, { error: 'Voucher not found' })
        : send(200, wantsCount ? { data: [], count: 0 } : []);
      query = query.or(conditions.join(','), ledger ? { referencedTable: 'voucher' } : undefined);
    }
    if (id) {
      query = query.eq('id', id);
      const { data, error } = await query.maybeSingle();
      if (error) return send(503, { error: 'Unable to load voucher history' });
      if (!data) return send(404, { error: 'Voucher not found' });
      const { voucher: owner, ...record } = data;
      return send(200, ledger ? { ...record, owner_type: owner.member_id ? 'member' : 'organization',
        owner_member_id: owner.member_id, owner_organization_id: owner.organization_id } : data);
    }
    const fields = ledger ? TRANSACTION_FIELDS : VOUCHER_FIELDS;
    if (req.query?.filter) query = filterQuery(query, parseObject(req.query.filter), fields);
    const sort = req.query?.sort ? parseObject(req.query.sort) : { created_at: 'desc' };
    for (const [field, direction] of Object.entries(sort)) {
      if (!fields.has(field) || !['asc', 'desc'].includes(direction)) throw new Error('Unsupported voucher sort');
      query = query.order(field, { ascending: direction === 'asc' });
    }
    if (!Object.hasOwn(sort, 'id')) query = query.order('id', { ascending: true });
    const offset = Number(req.query?.offset || 0);
    const limit = Number(req.query?.limit || 1000);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
      throw new Error('Invalid voucher pagination');
    }
    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) return send(503, { error: 'Unable to load vouchers' });
    const rows = ledger ? (data || []).map(({ voucher: owner, ...record }) => ({
      ...record, owner_type: owner.member_id ? 'member' : 'organization',
      owner_member_id: owner.member_id, owner_organization_id: owner.organization_id,
    })) : (data || []);
    return send(200, wantsCount ? { data: rows, count } : rows);
  } catch (error) {
    return send(error.statusCode || 400, { error: error.message || 'Unable to process voucher request' });
  }
}

/** The settings are public to read, never public/member-writable. */
export async function authorizeVoucherSettingWrite({ entity, id, req, res, context, db, hasAdminAccess }) {
  if (entity !== 'systemsettings' || req.method === 'GET') return false;
  let protectedKey = VOUCHER_SETTING_KEYS.has(req.body?.setting_key);
  if (id) {
    const { data, error } = await db.from('system_settings').select('setting_key')
      .eq('id', id).eq('tenant_id', context.tenantId).maybeSingle();
    if (error) { res.status(503).json({ error: 'Unable to verify settings authority' }); return true; }
    protectedKey ||= VOUCHER_SETTING_KEYS.has(data?.setting_key);
  }
  if (!protectedKey) return false;
  if (!context.isAuthenticated || !context.tenantId || context.tenantMismatch || !await hasAdminAccess(context)) {
    res.status(403).json({ error: 'Admin access required for voucher settings' });
    return true;
  }
  if (req.body && Object.hasOwn(req.body, 'setting_value')) {
    if (typeof req.body.setting_value !== 'string') {
      res.status(400).json({ error: 'Voucher settings must use string values' }); return true;
    }
    req.body.setting_value = req.body.setting_value.trim();
  }
  return false;
}

// Capability boundary shared by the console preview and pure job orchestrators.
// This module deliberately imports no database, provider, or live effect clients.
export class DryRunEffectBoundary extends Error {
  constructor(operation) {
    super(`Not executed: ${operation.description || operation.type}`);
    this.name = 'DryRunEffectBoundary';
    this.code = 'DD_DRY_RUN_EFFECT_BOUNDARY';
    this.operation = operation;
  }
}

export const isDryRunEffectBoundary = error => error?.code === 'DD_DRY_RUN_EFFECT_BOUNDARY';

const queryMethods = new Set([
  'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
  'is', 'in', 'contains', 'containedBy', 'overlaps', 'not', 'or', 'filter',
  'match', 'order', 'limit', 'range', 'single', 'maybeSingle',
]);
const denied = name => { throw new Error(`Dry run capability denied: ${String(name)}`); };
const databaseFailures = new WeakMap();

// No RPC is allowed, even if its name sounds read-only. Tenant scope is attached
// independently of caller filters. Only query results, never builders/clients,
// cross the promise boundary.
export function readonlyTenantDatabase(database, tenantId, { memberId = null, organizationId = null } = {}) {
  if (!database || !tenantId) throw new Error('Dry run database and tenant required');
  const failures = [];
  const denyDatabase = name => {
    const error = new Error(`Dry run capability denied: ${String(name)}`);
    failures.push(error);
    throw error;
  };
  const ownerTables = {
    member_preference_value: ['member_id', memberId],
    organization_preference_value: ['organization_id', organizationId],
  };
  const scopeQuery = (raw, table) => {
    if (ownerTables[table]) return raw.eq(...ownerTables[table]);
    return raw.eq(table === 'tenant' ? 'id' : 'tenant_id', tenantId);
  };
  const builder = (raw, table, selected = false, scoped = false) => new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'then') {
        if (!selected) return denyDatabase('database execution without select');
        return (resolve, reject) => Promise.resolve(scoped ? raw : scopeQuery(raw, table))
          .then(result => {
            if (result?.error) failures.push(new Error(`Dry run ${table} read failed: ${result.error.message || 'Unknown database error'}`));
            return result;
          }, error => { failures.push(error); throw error; }).then(resolve, reject);
      }
      if (typeof key === 'symbol') return undefined;
      if (!queryMethods.has(key)) return denyDatabase(`database.${key}`);
      return (...args) => {
        if (!selected && key !== 'select') return denyDatabase(`database.${key} before select`);
        // The legacy VAT cache is keyed by the tenant ID in setting_key and
        // some historical rows have no tenant_id. Only this exact key can use
        // key-based authority; all other settings retain the tenant predicate.
        const vatCacheKey = table === 'system_settings' && key === 'eq'
          && args[0] === 'setting_key' && args[1] === `xero_vat_rates_${tenantId}`;
        if (!scoped && ['single', 'maybeSingle', 'range'].includes(key)) {
          raw = scopeQuery(raw, table);
          scoped = true;
        }
        let next = raw[key](...args);
        if (key === 'select' && table !== 'system_settings') {
          next = scopeQuery(next, table);
          scoped = true;
        }
        return builder(next, table, selected || key === 'select', scoped || vatCacheKey);
      };
    },
    set() { return denyDatabase('database property write'); },
    getPrototypeOf() { return null; },
  });
  const guarded = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (key !== 'from') return denyDatabase(`database.${key}`);
      return table => {
        if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) return denyDatabase('database table');
        if (ownerTables[table] && !ownerTables[table][1]) return denyDatabase(`database.${table} without validated owner`);
        return builder(database.from(table), table);
      };
    },
    set() { return denyDatabase('database property write'); },
    getPrototypeOf() { return null; },
  });
  databaseFailures.set(guarded, failures);
  return guarded;
}

export const DD_PROVIDER_READ_METHODS = Object.freeze([
  'getBillingRequest', 'getSubscription', 'getMandate', 'getCustomer',
  'getPayment', 'listPayments', 'getRefund', 'listRefunds', 'getPayout', 'listPayoutItems',
]);

export function readonlyGocardless(client, { onEvidence = () => {}, clock = () => new Date() } = {}) {
  const adapter = Object.create(null);
  for (const method of DD_PROVIDER_READ_METHODS) {
    adapter[method] = async (...args) => {
      if (typeof client[method] !== 'function') throw new Error(`Provider read unavailable: ${method}`);
      if (method === 'listPayments' && !args[0]?.subscriptionId && !args[0]?.mandateId) {
        return denied('unscoped provider payment list');
      }
      if (method === 'listRefunds' && !args[0]?.paymentId) return denied('unscoped provider refund list');
      if (method === 'listPayoutItems' && !args[0]?.payoutId) return denied('unscoped provider payout list');
      try {
        const result = await client[method](...args);
        onEvidence({ method, evidenceAt: clock().toISOString(), status: 'read' });
        return result;
      } catch (error) {
        onEvidence({ method, evidenceAt: clock().toISOString(), status: 'error' });
        throw error;
      }
    };
  }
  adapter.getGocardlessEnvironment = () => client.getGocardlessEnvironment();
  // Public non-secret credential identity used by production validation.
  adapter.credentials = Object.freeze({
    source: client.credentials?.source, tenantId: client.credentials?.tenantId,
    environment: client.credentials?.environment,
  });
  Object.freeze(adapter);
  return new Proxy(adapter, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (!Object.hasOwn(target, key)) {
        onEvidence({ method: String(key), evidenceAt: clock().toISOString(), status: 'error' });
        return denied(`provider.${key}`);
      }
      return target[key];
    },
    getPrototypeOf() { return null; },
  });
}

// Family API: run({db, plan, agreement, now: Date, getGc, effects, trace}).
// trace({stage, status, reason, evidenceAt?, operations?}) adds a UI stage.
// getGc(tenantId) resolves a fresh, allowlisted read client for this evaluation.
// effects.perform(serializableOperation) NEVER resolves in recording mode.
// Catching code must rethrow DryRunEffectBoundary; never perform cleanup writes.
export function recordingEffects(operations) {
  let boundary = null;
  return Object.freeze({
    async perform(operation) {
      if (boundary) throw boundary;
      if (!operation || typeof operation.type !== 'string' || typeof operation.description !== 'string') {
        throw new Error('Dry run operation requires type and description');
      }
      const recorded = JSON.parse(JSON.stringify(operation));
      operations.push(recorded);
      boundary = new DryRunEffectBoundary(recorded);
      throw boundary;
    },
  });
}

export async function evaluateDryRunJob({ id, label, run }, context) {
  const stages = [], operations = [], evidence = [];
  const failures = databaseFailures.get(context.db) || [];
  const failuresBefore = failures.length;
  const trace = stage => stages.push({
    stage: stage.stage || id, status: stage.status || 'unknown',
    reason: stage.reason || '', evidenceAt: stage.evidenceAt || context.now.toISOString(),
    operations: stage.operations || [],
  });
  try {
    await run({
      ...context,
      plan: structuredClone(context.plan),
      agreement: structuredClone(context.agreement),
      now: new Date(context.now),
      trace, effects: recordingEffects(operations),
      getGc: async tenantId => {
        if (tenantId !== context.plan.tenant_id) throw new Error('Dry run provider tenant mismatch');
        return readonlyGocardless(await context.getGc(tenantId), { onEvidence: item => evidence.push(item) });
      },
    });
    if (failures.length > failuresBefore) throw failures[failuresBefore];
    if (evidence.some(item => item.status === 'error')) throw new Error('A provider read failed; this outcome remains unknown.');
    // Defensive against legacy catch/finally blocks swallowing the sentinel.
    // No later attempted effect can replace the original uncertainty boundary.
    if (operations.length) throw new DryRunEffectBoundary(operations[0]);
    if (!stages.length) trace({ stage: id, status: 'skipped', reason: 'No eligible work for this plan.' });
  } catch (error) {
    // Helpers in the production decision graph sometimes catch failed reads.
    // A preview must not turn their fallback into confident financial intent.
    if (failures.length > failuresBefore) error = failures[failuresBefore];
    else if (isDryRunEffectBoundary(error) && evidence.some(item => item.status === 'error')) {
      error = new Error('A provider read failed; this outcome remains unknown.');
    }
    if (isDryRunEffectBoundary(error)) {
      trace({
        stage: error.operation.stage || id, status: 'conditional',
        reason: `Stopped before this operation. Subsequent work depends on its result; no claim, change, or collection was made.${error.operation.continuation ? ` ${error.operation.continuation}` : ''}${typeof error.operation.conditional === 'string' ? ` ${error.operation.conditional}` : ''}`,
        operations: operations.map(operation => ({
          ...operation, conditional: true,
          ...((operation.continuation || typeof operation.conditional === 'string') ? {
            continuation: [operation.continuation, typeof operation.conditional === 'string' ? operation.conditional : null].filter(Boolean).join(' '),
          } : {}),
        })),
      });
    } else {
      trace({ stage: id, status: 'error', reason: error.message || 'Evaluation failed; outcome unknown.' });
    }
  }
  // Internal operation payloads are for live dispatch/parity tests, not UI data.
  for (const stage of stages) stage.operations = stage.operations.map(operation => {
    const publicOperation = {};
    for (const key of ['type', 'description', 'amountMinor', 'currency', 'date', 'conditional', 'continuation']) {
      if (operation[key] !== undefined) publicOperation[key] = operation[key];
    }
    return publicOperation;
  });
  return { id, label, stages, evidence };
}

// Independent sweeps within one scheduled job are evaluated against current
// evidence, not against hypothetical successes from a previous sweep.
export async function evaluateDryRunStages({ id, label, runners }, context) {
  const stages = [], evidence = [];
  for (const runner of runners) {
    const result = await evaluateDryRunJob({ label, ...runner }, context);
    stages.push(...result.stages);
    evidence.push(...result.evidence.map(item => ({ ...item, stage: runner.id })));
  }
  return { id, label, stages, evidence };
}
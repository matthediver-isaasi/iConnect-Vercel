// Live composition root. Shared renewal orchestration has no production-client
// imports; only this adapter can interpret its effects.
import { supabase } from './database.js';
import { ensureSubscriptionForAgreement, activateMembershipForAgreement } from './gocardlessDirectDebit.js';
import { sendDdLifecycleEmail } from './gocardlessDdEmails.js';
import { createDdRenewals } from './gocardlessDdRenewalsCore.js';
import { renewalCapabilities, findRenewalMandate } from './ddRenewalCapabilities.js';
export { RENEWAL_NOTICE_DAYS, deriveNextYearLabel, computeRenewalWindow, decideRenewalAction } from './ddRenewalPipeline.js';

export function createLiveDdRenewals(deps = {}) {
  const database = deps.db || supabase;
  const now = deps.now || (() => new Date());
  const effects = {
    async perform(operation) {
      const p = operation.payload;
      if (operation.type === 'renewal.database') {
        let query = database.from(p.table);
        for (const [method, args] of p.calls) query = query[method](...args);
        return await query;
      }
      if (operation.type === 'renewal.email') {
        return (deps.sendEmail || sendDdLifecycleEmail)(p.eventKey, p.agreement, {
          db: database, ...(deps.send ? { send: deps.send } : {}), extraContext: p.extraContext,
        });
      }
      if (operation.type === 'renewal.subscription') {
        return (deps.ensureSubscription || ensureSubscriptionForAgreement)(p.agreement, { db: database, gc: deps.gc, now });
      }
      if (operation.type === 'renewal.activation') {
        return (deps.activateMembership || activateMembershipForAgreement)(p.agreement, { db: database, trigger: p.trigger });
      }
      throw new Error(`Unsupported renewal effect: ${operation.type}`);
    },
  };
  const capabilities = renewalCapabilities(database, deps.effects || effects);
  const options = { ...deps, ...capabilities, now, findMandate: deps.findMandate || findRenewalMandate };
  return { engine: createDdRenewals(options), options, assertReads: capabilities.assertReads };
}

export function buildDdRenewalSnapshot(args) {
  return createDdRenewals({ db: null }).buildDdRenewalSnapshot(args);
}
export async function executeAutoRenewal(args) {
  const { engine, options, assertReads } = createLiveDdRenewals(args.deps);
  const result = await engine.executeAutoRenewal({ ...args, deps: options });
  assertReads();
  return result;
}
export async function processTenantDdRenewals(tenantId, results, deps = {}) {
  const { engine, options } = createLiveDdRenewals(deps);
  return engine.processTenantDdRenewals(tenantId, results, options);
}
export async function markRenewalConfirmed(args) {
  const { engine } = createLiveDdRenewals({ db: args?.db });
  return engine.markRenewalConfirmed(args);
}
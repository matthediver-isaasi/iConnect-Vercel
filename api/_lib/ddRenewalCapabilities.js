// The shared renewal engine receives this capability, never a writable client.
// Reads use the supplied read client; mutation builders become serializable
// operations interpreted by live/recording effects at the exact await boundary.
const readMethods = new Set(['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range', 'single', 'maybeSingle', 'contains']);
const writeMethods = new Set(['insert', 'update', 'upsert', 'delete']);

export function renewalCapabilities(readDb, effects) {
  const faults = [];
  let intent = {};
  const assertReads = () => {
    if (faults.length) throw new Error(`Renewal read failed; no effect permitted: ${faults[0]}`);
  };
  const perform = async operation => {
    assertReads();
    return effects.perform(operation);
  };
  const builder = (table, calls = []) => {
    let result;
    return new Proxy(Object.create(null), {
      get(_target, method) {
        if (method === 'then') return (resolve, reject) => {
          result ||= (async () => {
            if (!calls.length) throw new Error('Renewal query requires select or a mutation');
            if (writeMethods.has(calls[0][0])) {
              const values = calls[0][1][0] || {};
              const terms = values.metadata?.dd;
              const description = table === 'membership_dd_renewals' && values.status === 'notice_processing'
                ? 'Claim the renewal notice before sending email; delivery depends on winning this claim.'
                : table === 'membership_billing_agreements' && calls[0][0] === 'insert'
                  ? 'Reserve the next membership agreement with current quoted terms. Membership creation, mandate attachment, subscription setup and confirmation email depend on this reservation.'
                  : `${calls[0][0]} ${table}; later renewal steps depend on this write succeeding.`;
              return perform({
                type: 'renewal.database', description, conditional: true,
                ...intent,
                ...(terms ? { amountMinor: terms.monthly_amount_minor, currency: terms.currency, date: terms.membership_year_start } : {}),
                payload: { table, calls },
              });
            }
            try {
              let query = readDb.from(table);
              for (const [name, args] of calls) query = query[name](...args);
              const value = await query;
              if (value?.error) faults.push(value.error.message || String(value.error));
              return value;
            } catch (error) {
              faults.push(error.message);
              throw error;
            }
          })();
          return result.then(resolve, reject);
        };
        if (typeof method === 'symbol') return undefined;
        if (!readMethods.has(method) && !writeMethods.has(method)) throw new Error(`Renewal database capability denied: ${method}`);
        if (writeMethods.has(method) && calls.length) throw new Error('Renewal mutation must start a new effect query');
        if (!calls.length && !writeMethods.has(method) && method !== 'select') throw new Error('Renewal query must start with select or an effect');
        return (...args) => builder(table, [...calls, [method, args]]);
      },
    });
  };
  const db = Object.freeze({ from: table => builder(table) });
  const sendEmail = (eventKey, agreement, options = {}) => perform({
    type: 'renewal.email', description: `Send ${eventKey.replaceAll('_', ' ')} email to the membership billing contact.`,
    conditional: true,
    amountMinor: options.extraContext?.newMonthlyAmount == null ? undefined : Math.round(Number(options.extraContext.newMonthlyAmount) * 100),
    currency: options.extraContext?.newCurrency,
    payload: { eventKey, agreement, extraContext: options.extraContext },
  });
  return {
    db, assertReads, sendEmail,
    resetReads: () => { faults.length = 0; intent = {}; },
    onIntent: value => { intent = value; },
    ensureSubscription: agreement => perform({
      type: 'renewal.subscription', description: 'Set up the successor subscription, subject to provider validations and acceptance.',
      conditional: true, payload: { agreement },
    }),
    activateMembership: (agreement, options) => perform({
      type: 'renewal.activation', description: 'Apply the saved membership activation rule to the successor.',
      conditional: true, payload: { agreement, trigger: options.trigger },
    }),
  };
}

export async function findRenewalMandate({ tenantId, memberId, organizationId, db }) {
  let query = db.from('gocardless_customers').select('gocardless_customer_id').eq('tenant_id', tenantId);
  query = organizationId ? query.eq('organization_id', organizationId) : query.eq('member_id', memberId);
  const { data: customers, error } = await query;
  if (error) throw new Error(`Could not read renewal customers: ${error.message}`);
  if (!customers?.length) return null;
  const { data: mandates, error: mandateError } = await db.from('gocardless_mandates')
    .select('gocardless_mandate_id, gocardless_customer_id, status')
    .in('gocardless_customer_id', customers.map(c => c.gocardless_customer_id))
    .eq('status', 'active').order('updated_at', { ascending: false }).limit(1);
  if (mandateError) throw new Error(`Could not read renewal mandates: ${mandateError.message}`);
  return mandates?.length ? { mandateId: mandates[0].gocardless_mandate_id, customerId: mandates[0].gocardless_customer_id } : null;
}
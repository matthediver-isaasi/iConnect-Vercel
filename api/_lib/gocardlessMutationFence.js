import crypto from 'node:crypto';

// Intent is durable before HTTP. Unknown ordinary outcomes prevent a handover;
// they never become safe just because a worker lease or timeout elapsed.
export async function fencedGocardlessRequest({ db, environment, operationId = null,
  method, path, opts = {}, request }) {
  if (method === 'GET') return request(method, path, opts);
  let mandateId = opts.body?.payments?.links?.mandate || opts.body?.subscriptions?.links?.mandate;
  const resource = path.match(/^\/(mandates|subscriptions|payments)\/([^/]+)(?:\/|$)/);
  if (!mandateId && resource) {
    if (resource[1] === 'mandates') mandateId = resource[2];
    else {
      const json = await request('GET', `/${resource[1]}/${resource[2]}`);
      mandateId = json?.[resource[1]]?.links?.mandate;
      if (!mandateId) throw new Error('Provider mutation mandate could not be resolved');
    }
  }
  if (!mandateId) return request(method, path, opts);
  const requestKey = opts.idempotencyKey
    ? crypto.createHash('sha256').update(JSON.stringify([method, path, opts.idempotencyKey, opts.body])).digest('hex')
    : crypto.randomUUID();
  const claim = await db.rpc('begin_gocardless_mutation', {
    p_environment: environment, p_mandate_id: mandateId,
    p_request_key: requestKey, p_operation_id: operationId,
  });
  // Compatibility only before additive schema rollout. Replacement preparation
  // itself requires the RPC and release row; it can never use this exception.
  if (claim.error && !operationId && ['PGRST202', '42883'].includes(claim.error.code)) {
    return request(method, path, opts);
  }
  if (claim.error || !claim.data) throw new Error('Collection authority requires reconciliation', { cause: claim.error });
  let result;
  try {
    result = await request(method, path, opts);
  } catch (error) {
    const marked = await db.rpc('finish_gocardless_mutation', { p_id: claim.data, p_confirmed: false });
    if (marked.error) console.error('[GoCardless] Could not record unknown provider outcome');
    throw error;
  }
  const marked = await db.rpc('finish_gocardless_mutation', { p_id: claim.data, p_confirmed: true });
  if (marked.error) throw new Error('Provider result requires local reconciliation', { cause: marked.error });
  return result;
}

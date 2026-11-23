import { AsyncLocalStorage } from 'node:async_hooks';
const lookupContext = new AsyncLocalStorage();

function checkDeadline(context) {
  if (!context) return;
  if (context.signal.aborted) throw context.signal.reason;
  if (performance.now() >= context.deadline) {
    context.expire();
    throw context.signal.reason;
  }
}

// Wrap query builders, not data or authority. Outside a verification scope this
// is a transparent client; there is no session cache across requests.
export function sessionDatabase(client) {
  if (!client) return client;
  function queryProxy(query, context, stage) {
    if (!query || (typeof query !== 'object' && typeof query !== 'function')) return query;
    return new Proxy(query, {
      get(target, property) {
        if (property === 'then') {
          if (typeof target.then !== 'function') return undefined;
          return (resolve, reject) => {
            const run = async () => {
              checkDeadline(context);
              context.stage = stage;
              const abortable = typeof target.abortSignal === 'function'
                ? target.abortSignal(context.signal) : target;
              const value = await abortable;
              checkDeadline(context);
              return value;
            };
            return run().then(resolve, reject);
          };
        }
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args) => {
          checkDeadline(context);
          const nextStage = ['select', 'insert', 'update', 'delete', 'upsert'].includes(property)
            ? `${stage.split(':')[0]}:${property}` : stage;
          return queryProxy(value.apply(target, args), context, nextStage);
        };
      },
    });
  }
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const context = lookupContext.getStore();
        if (!context || !['from', 'rpc'].includes(property)) return value.apply(target, args);
        checkDeadline(context);
        // Only static table/RPC names; never query filters, IDs or credentials.
        const stage = `${String(args[0]).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)}:${property}`;
        return queryProxy(value.apply(target, args), context, stage);
      };
    },
  });
}

// Infrastructure failure is not evidence of logout. Throw rather than return
// a truthy pseudo-session or null (which guest consumers treat as authoritative).
export class SessionUnavailableError extends Error {
  constructor(cause) {
    super('Session verification is temporarily unavailable.', { cause });
    this.code = 'SESSION_UNAVAILABLE';
    this.status = 503;
  }
}

export function sessionUnavailable(error) {
  return error?.code === 'SESSION_UNAVAILABLE'
    ? error : new SessionUnavailableError(error);
}

export async function boundedSessionLookup(read, timeoutMs = 5000, stage = 'session_verification') {
  const inherited = lookupContext.getStore();
  if (inherited) {
    checkDeadline(inherited);
    const value = await read(inherited.signal);
    checkDeadline(inherited);
    return value;
  }
  const started = performance.now();
  const controller = new AbortController();
  const context = { signal: controller.signal, deadline: started + timeoutMs, stage };
  let timer;
  return lookupContext.run(context, async () => {
    const timeout = new Promise((_, reject) => {
      context.expire = () => {
        if (controller.signal.aborted) return;
        const error = sessionUnavailable();
        console.warn('[Session] verification_timeout', {
          stage: context.stage, elapsedMs: Math.round(performance.now() - started), budgetMs: timeoutMs,
        });
        controller.abort(error);
        reject(error);
      };
      timer = setTimeout(context.expire, timeoutMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => read(controller.signal)), timeout]);
      checkDeadline(context);
      return value;
    } finally {
      clearTimeout(timer);
    }
  });
}

export function sendSessionUnavailable(res, error) {
  if (error?.code !== 'SESSION_UNAVAILABLE') return false;
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(503).json({ code: 'SESSION_UNAVAILABLE', error: error.message });
  return true;
}

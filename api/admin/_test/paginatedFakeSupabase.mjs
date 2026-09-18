export function makeFakeSupabase(resolveQuery) {
  const calls = [];

  return {
    calls,
    from(table) {
      const call = { table, methods: [] };
      calls.push(call);
      const chain = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') {
            const result = Promise.resolve().then(() => resolveQuery(call));
            return result.then.bind(result);
          }
          return (...args) => {
            call.methods.push([property, ...args]);
            return chain;
          };
        },
      });
      return chain;
    },
  };
}

export function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

export const authenticatedTenant = async () => ({
  isAuthenticated: true,
  tenantId: 'tenant-1',
});

export function selectedWith(call, optionName, expected) {
  const select = call.methods.find(([method]) => method === 'select');
  return select?.[2]?.[optionName] === expected;
}

export function methodArguments(call, methodName) {
  return call.methods.filter(([method]) => method === methodName).map(([, ...args]) => args);
}
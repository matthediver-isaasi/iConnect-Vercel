import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const memberId = '11111111-1111-4111-8111-111111111111';
const slot = '__privateTicketDiscount';
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./complex-event-validate-discount.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{
    name: 'private-discount-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$|\/(session|tenantContext|tenantResolver|complexEventPricing)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path === '@supabase/supabase-js'
          ? `export const createClient = () => globalThis.${slot}.db;`
          : path.endsWith('/session.js')
            ? `export const getSession = async () => globalThis.${slot}.session;
               export const getSessionMember = async () => globalThis.${slot}.member;`
            : path.endsWith('/tenantContext.js')
              ? 'export const hasAdminAccess = async () => false;'
              : path.endsWith('/tenantResolver.js')
                ? 'export const resolveTenantFromRequest = async () => ({id:"tenant"});'
                : `export const resolveTicketPrice = (tickets, id) => ({found:true,price:100});
                   export const validateDiscountCode = async () => { globalThis.${slot}.discountCalls++; return {valid:true,discountCode:{id:"discount",type:"percentage",value:10}}; };
                   export const computeDiscountedPrice = () => 90;`,
      }));
    },
  }],
});
const handler = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)).default;

for (const actor of ['guest', 'listed', 'other-tenant']) {
  test(`private discount quote: ${actor} cannot bypass the read policy with a known ticket ID`, async () => {
    const state = {
      session: actor === 'guest' ? null : { data: { memberId } },
      member: actor === 'guest' ? null : { id: memberId, tenant_id: actor === 'other-tenant' ? 'other' : 'tenant' },
      discountCalls: 0,
      db: { from(table) {
        const query = {
          select() { return this; }, eq() { return this; },
          single() { return this; }, maybeSingle() { return this; },
          then(resolve) {
            return Promise.resolve({ error: null, data: table === 'member' ? state.member : [{
              id: 'private', audience_mode: 'selected_members', selected_member_ids: [memberId],
            }] }).then(resolve);
          },
        };
        return query;
      } },
    };
    globalThis[slot] = state;
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', body: { event_id: 'event', ticket_class_id: 'private', discount_code: 'VALID', member_id: memberId, private_ticket_eligible: true } }, res);
    assert.equal(res.statusCode, actor === 'listed' ? 200 : 403);
    assert.equal(state.discountCalls, actor === 'listed' ? 1 : 0);
    assert.equal(JSON.stringify(res.body).includes('selected_member_ids'), false);
  });
}

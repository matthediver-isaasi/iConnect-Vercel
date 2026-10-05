import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('enabled standard ticket quote accepts its ticket-restricted discount and rejects another ticket', async () => {
  const result = await build({
    entryPoints: ['api/_lib/publicTicketSimpleQuote.js'], bundle: true, write: false,
    platform: 'node', format: 'esm',
    define: {
      'process.env.SUPABASE_URL': '"https://fixture.invalid"',
      'process.env.SUPABASE_SERVICE_KEY': '"fixture-not-a-secret"',
    },
    plugins: [{ name: 'discount-fixture', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export function createClient(){return {from(table){
          if(table!=='discount_code')throw Error('Unexpected table');
          return {select(){return this},ilike(){return this},eq(){return this},
            async maybeSingle(){return {data:{id:'discount',ticket_class_id:'selected',event_id:'event',type:'percentage',value:20,is_active:true}}}};
        }}}`,
      }));
    } }],
  });
  const { validatePublicTicketSimpleCharge } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const args = { ticket: { id: 'selected', price: 25 }, attendees: [{}, {}],
    tenantId: 'tenant', eventId: 'event', discountCode: 'TICKET20', amount: 40 };
  await assert.doesNotReject(validatePublicTicketSimpleCharge(args));
  await assert.rejects(validatePublicTicketSimpleCharge({ ...args, ticket: { id: 'different', price: 25 } }), /selected ticket/);
  await assert.rejects(validatePublicTicketSimpleCharge({ ...args, amount: 39 }), /does not cover/);
});

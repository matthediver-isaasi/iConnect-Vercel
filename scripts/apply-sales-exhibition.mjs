import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const file='supabase/migrations/202610260001_sales_exhibition_inventory.sql';
const sql=await readFile(file,'utf8');
const sha256=createHash('sha256').update(sql).digest('hex');
const args=process.argv.slice(2);
if (!args.length || args.join()==='--review') {
  console.log(JSON.stringify({file,sha256,destination:PROJECT,applied:false}));
} else {
  if(args.length!==3 || !args.includes('--apply') || !args.includes(`--reviewed-sha256=${sha256}`) || !args.includes(`--confirm-destination=${PROJECT}`)) throw new Error('Explicit reviewed digest and destination required');
  const db=await connectDestination();
  try {
    await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
    const evidence="SELECT count(*)::text count,coalesce(sum(net_minor),0)::text net,coalesce(sum(tax_minor),0)::text tax,coalesce(sum(gross_minor),0)::text gross FROM sales_quote_version";
    const before=(await db.query(evidence)).rows;
    await db.query(sql);
    if(JSON.stringify(before)!==JSON.stringify((await db.query(evidence)).rows)) throw new Error('Historical quote totals changed');
    for(const table of ['sales_space_requirement','sales_space_group','sales_exhibition_space','sales_space_allocation','sales_space_command']) {
      const {rows:[r]}=await db.query(`SELECT c.relrowsecurity rls,has_table_privilege('anon',c.oid,'SELECT') anon,
      has_table_privilege('authenticated',c.oid,'INSERT') auth,has_table_privilege('service_role',c.oid,'INSERT') direct_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`,[table]);
      if(!r?.rls || r.anon || r.auth || r.direct_write) throw new Error(`Inventory privileges failed: ${table}`);
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({applied:true,file,sha256,destination:PROJECT,historicalTotalsUnchanged:true,serviceOnlyMutations:true}));
  } catch(error) {await db.query('ROLLBACK'); throw error;} finally {await db.end();}
}

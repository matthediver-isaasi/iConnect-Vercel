import {readFile,writeFile} from 'node:fs/promises';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {hash,TENANT_ID} from './bnms-dd-beta-invoices.mjs';
const dir='exports/private-bnms-manual-phase1';
const sheet=JSON.parse(await readFile(`${dir}/spreadsheet.json`,'utf8'));
const ids=[...new Set(sheet.rows.map(r=>r.memberId))];
const customerIds=[...new Set(sheet.rows.map(r=>r.customerId))];
const manifest=JSON.parse(await readFile('exports/private-bnms-alpha-final-review-20260920/manifest.json','utf8'));
if(hash(manifest)!=='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a')throw Error('Original manifest pin mismatch');
const c=await destinationConnection();const out={manifestSha256:hash(manifest)};
try {
 await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 for(const table of ['gocardless_customers','gocardless_mandates','membership_tier_vat_override','bnms_dd_alpha_membership_recognition','bnms_membership_recognition_beta_pilot']){
  out[table]=(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1`,[TENANT_ID])).rows.map(r=>r.row);
 }
 out.groupSchema=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('member_group_member','member_group_membership','member_group')")).rows;
 await c.query('ROLLBACK');
 await writeFile(`${dir}/supplement.json`,JSON.stringify(out,null,2),{mode:0o600,flag:'wx'});
 const matches=out.gocardless_customers.filter(r=>customerIds.includes(r.gocardless_customer_id));
 console.log(JSON.stringify({manifestPinVerified:true,recognitionTotals:{alpha:out.bnms_dd_alpha_membership_recognition.length,betaPilot:out.bnms_membership_recognition_beta_pilot.length},cohortRecognized:out.bnms_dd_alpha_membership_recognition.filter(r=>ids.includes(r.member_id)).length,vatOverrides:out.membership_tier_vat_override.length,matchedCustomerMirrors:matches.length,customerMirrorFields:Object.keys(out.gocardless_customers[0]||{}),mandateMirrorFields:Object.keys(out.gocardless_mandates[0]||{}),groupSchema:out.groupSchema}));
}finally{await c.end();}
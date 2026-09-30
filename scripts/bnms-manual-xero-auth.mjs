// Only the application's normal OAuth helper may rotate/save credentials.
// No contact, invoice, account or financial provider operation runs here.
import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.length>1||(args.length&&!/^--out=exports\/private-bnms-manual-phase2-refresh-[a-zA-Z0-9-]+\/auth-status\.json$/.test(args[0])))
 throw Error('Only a private refresh auth-status output is supported');
const output=args[0]?.slice('--out='.length)||'exports/private-bnms-manual-phase2/auth-status.json';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',xeroTenant='3d57dce6-2205-462f-abf6-9c7cbf00be23';
const c=await destinationConnection();
let locked=false;
const report={observedAt:new Date().toISOString(),financialWrites:0,invoiceRequests:0};
try{
 await c.connect();
 // Serialize operator warm-ups and re-read after acquiring the lock. Do not
 // rotate tokens in this runner or bypass the app's credential resolver.
 await c.query("SET lock_timeout='5s'");
 const lock=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('bnms-manual-xero-auth',0)) acquired")).rows[0].acquired;
 if(!lock)throw Error('AUTH_WARMUP_IN_PROGRESS');
 locked=true;
 const identity=(await c.query('SELECT tenant_id FROM xero_token WHERE app_tenant_id=$1',[tenant])).rows;
 if(identity.length!==1||identity[0].tenant_id!==xeroTenant)throw Error('PINNED_CONNECTION_MISMATCH');
 const auth=await getValidXeroAccessToken(tenant);
 if(auth.tenantId!==xeroTenant)throw Error('PINNED_CONNECTION_MISMATCH');
 report.status='application_authentication_available';
}catch(error){
 // OAuth bodies can contain sensitive fields. Retain only a fixed safe code.
 const text=String(error?.message||'');
 report.status='authentication_blocked';
 report.code=/invalid_grant/.test(text)?'invalid_grant':/invalid_client/.test(text)?'invalid_client':
  /AUTH_WARMUP_IN_PROGRESS/.test(text)?'auth_warmup_in_progress':/PINNED_CONNECTION_MISMATCH/.test(text)?'pinned_connection_mismatch':
  /credentials not configured/.test(text)?'tenant_oauth_credentials_unavailable':'application_oauth_helper_failed';
 report.action=report.code==='invalid_grant'
  ?'Reconnect the existing BNMS Xero integration in this application; not a different Replit integration.'
  :'Review existing application Xero authentication; no manual token handling or financial action attempted.';
 process.exitCode=1;
}finally{
 if(locked)await c.query("SELECT pg_advisory_unlock(hashtextextended('bnms-manual-xero-auth',0))");
 await c.end();
 await writeFile(output,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify(report));
}
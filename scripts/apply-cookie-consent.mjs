// Offline dry-run unless both apply and the reviewed content hash are supplied.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const project='lvmzliemqnieeoruhkik';
const file='supabase/migrations/202611020001_cookie_consent.sql';
const sql=await readFile(new URL('../'+file,import.meta.url),'utf8');
const hash=createHash('sha256').update(sql).digest('hex');
const args=process.argv.slice(2);
if(args.some(a=>a!=='--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(a)))throw Error('Invalid arguments');
if(!args.includes('--apply')){console.log(JSON.stringify({migration:file,destination:project,sha256:hash,writes:false}));}
else {
  if(!args.includes('--review-sha256='+hash))throw Error('Reviewed migration hash required');
  if(new URL(process.env.DEST_SUPABASE_URL).hostname!==project+'.supabase.co')throw Error('Destination mismatch');
  const url=new URL(process.env.DEST_DATABASE_URL);
  if(!['aws-1-eu-central-1.pooler.supabase.com',`db.${project}.supabase.co`].includes(url.hostname) ||
    (url.port && url.port!=='5432') || (url.hostname.includes('pooler') && !decodeURIComponent(url.username).endsWith('.'+project)))throw Error('SQL destination mismatch');
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
  const response=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if(!response.ok)throw Error('CA download failed');
  const ca=await response.text();
  const db=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca,servername:url.hostname}});
  await db.connect();
  try {await db.query("set lock_timeout='10s';set statement_timeout='60s'");await db.query(sql);console.log('Consent migration applied to verified destination');}
  finally {await db.end();}
}

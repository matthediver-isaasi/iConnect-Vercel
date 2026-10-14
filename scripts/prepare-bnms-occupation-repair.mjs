// Read-only source audit; never runs any historical importer.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { decodeMixedEncoding } from './import-bnms-former-members.mjs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { readMembers, liveSchema } from './bnms-job-title-repair-db.mjs';
import { TENANT, hash } from './bnms-job-title-repair-core.mjs';
import { planOccupationRepair } from './bnms-occupation-repair-core.mjs';

const dir='generated-artifacts/bnms-occupation-repair';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const sourceFiles=[],sources=[];
const definitions=fs.readdirSync('scripts').filter(f =>
  /^import-bnms-.*members\.mjs$/.test(f)
  || ['import-bnms-students.mjs','bnms-september-source.mjs','bnms-final-source.mjs'].includes(f));
for(const definition of definitions) {
  const code=fs.readFileSync(`scripts/${definition}`,'utf8');
  const line=code.match(/export const FILE[^;]*;/)?.[0];
  if(!line) continue; // Wrapper imports source constants from a separate module.
  const quoted=[...line.matchAll(/'([^']+\.(?:csv|xlsx))'/g)];
  assert.equal(quoted.length,1,`Unknown source declaration in ${definition}`);
  const file=`attached_assets/${path.basename(quoted[0][1])}`;
  const expected=code.match(/(?:export )?const (?:EXPECTED_FILE_SHA256|EXPECTED_SHA256|SHA256)\s*=\s*'([a-f0-9]{64})'/)?.[1];
  assert.ok(expected,`Missing source fingerprint in ${definition}`);
  const bytes=fs.readFileSync(file);
  const fingerprint=createHash('sha256').update(bytes).digest('hex');
  assert.equal(fingerprint,expected,`Source changed: ${file}`);
  const sheets=file.endsWith('.csv') ? [['CSV',parse(decodeMixedEncoding(bytes),{bom:true,relax_column_count:true})]]
    : (()=>{const wb=XLSX.read(bytes,{type:'buffer'});return wb.SheetNames.map(name=>[name,
      XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,defval:'',raw:false})]);})();
  let found=false;
  for(const [sheet,rows] of sheets) {
    const headers=(rows[0]||[]).map(h=>String(h).trim().toLowerCase());
    const idx=label=>headers.indexOf(label);
    if(['ym web site member id','email','occupation'].some(h=>idx(h)<0)) continue;
    for(const h of ['ym web site member id','email','occupation'])
      assert.equal(headers.filter(x=>x===h).length,1,`Ambiguous ${h} header`);
    found=true;
    for(let i=1;i<rows.length;i++) {
      const r=rows[i]; if(!String(r[idx('email')]||'').trim()) continue;
      sources.push({file,fingerprint,sheet,row:i+1,legacyId:String(r[idx('ym web site member id')]||''),
        email:String(r[idx('email')]||''),occupation:String(r[idx('occupation')]||''),
        notes:idx('notes')<0?'':String(r[idx('notes')]||'')});
    }
  }
  sourceFiles.push({file,fingerprint,hasOccupation:found});
}
assert.ok(sourceFiles.length>=9);
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const members=await readMembers(db);
  const prefs=(await db.query(`SELECT v.member_id,f.name,v.value FROM member_preference_value v
    JOIN preference_field f ON f.id=v.field_id JOIN member m ON m.id=v.member_id
    WHERE m.tenant_id=$1 AND f.tenant_id=$1 AND f.entity_scope='member'
      AND f.name IN ('ym_web_site_member_id','occupation')`,[TENANT])).rows;
  const decisions=members.map(m=>({id:m.id,...planOccupationRepair(m,
    prefs.filter(p=>p.member_id===m.id&&p.name==='ym_web_site_member_id').map(p=>p.value),
    prefs.filter(p=>p.member_id===m.id&&p.name==='occupation').map(p=>p.value),sources)}));
  const items=decisions.filter(d=>d.item).map(d=>d.item);
  const schema=await liveSchema(db);
  await db.query('ROLLBACK');
  assert.ok(items.some(i=>i.id==='40f32190-8286-4f65-87af-6c051135e619'));
  const manifest={tenant:TENANT,preparedAt:new Date().toISOString(),sourceFiles,
    items,schemaHash:hash(schema)};
  fs.writeFileSync(`${dir}/manifest.json`,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  fs.writeFileSync(`${dir}/review.json`,JSON.stringify({schema,decisions},null,2),{flag:'wx',mode:0o600});
  const reasons={};for(const d of decisions.filter(d=>!d.item))reasons[d.reason]=(reasons[d.reason]||0)+1;
  console.log(JSON.stringify({members:members.length,pinnedSources:sourceFiles.length,proposedChanges:items.length,
    preserved:reasons,manifestHash:hash(manifest),alexReplacement:items.find(i=>i.id==='40f32190-8286-4f65-87af-6c051135e619').title}));
} finally {await db.end();}

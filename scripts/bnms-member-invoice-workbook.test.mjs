import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { TENANT, COMPANY, hash, planAudit } from './lib/bnms-member-invoice-audit.mjs';

test('workbook reconciles every eligible member and retains formula-like input as literal text',async()=>{
  await mkdir('generated-artifacts',{recursive:true});
  const dir=await mkdtemp('generated-artifacts/bnms-member-invoice-audit-fixture-');
  const member={id:'fixture-owner',tenant_id:TENANT,role_id:'member',first_name:'=1+1',email:'fixture@example.test'};
  const s={tenant:{id:TENANT,name:'BNMS'},guestRole:{id:'guest'},roles:[{id:'member',name:'Member'}],
    total:2,members:[member,{...member,id:'excluded-fixture',role_id:'guest',email:'guest@example.test'}],
    secondary:[],addresses:[],links:[],relations:[],pagination:[2,0],excludedCount:1,capturedAt:'2026-11-18T00:00:00Z',connection:{}};
  const d={complete:true,contacts:[{ContactID:'fixture-contact',ContactStatus:'ACTIVE',EmailAddress:member.email,
    Name:'@Contact',Addresses:[{AddressType:'POBOX',AddressLine1:'=HYPERLINK("https://example.invalid","text")',Country:'UK'}]}],
    pages:[{page:1,count:1},{page:2,count:0}],organisation:[{OrganisationID:COMPANY,Name:'BNMS'}]};
  const manifest={snapshotHash:hash(s),discoveryHash:hash(d),rows:planAudit(s,d)};
  try {
    for(const [file,data] of Object.entries({'snapshot.json':s,'discovery.json':d,'manifest.json':manifest,'manifest-pin.json':{sha256:hash(manifest)}})) {
      await writeFile(`${dir}/${file}`,JSON.stringify(data),{mode:0o600,flag:'wx'});
    }
    execFileSync(process.execPath,['scripts/export-bnms-member-invoice-addresses.mjs',dir],{stdio:'pipe'});
    const book=new ExcelJS.Workbook();await book.xlsx.readFile(`${dir}/BNMS-member-invoice-address-audit.xlsx`);
    assert.equal(book.getWorksheet('All member audit').rowCount,2);
    assert.equal(book.getWorksheet('Copied addresses').rowCount,1);
    const sheet=book.getWorksheet('All member audit'), headers=sheet.getRow(1).values;
    const cell=label=>sheet.getRow(2).getCell(headers.indexOf(label));
    assert.equal(cell('Member name').value,'=1+1');assert.equal(cell('Member name').type,ExcelJS.ValueType.String);
    assert.match(cell('Xero mapped line 1').value,/^=HYPERLINK/);
    assert.equal(cell('Write outcome').value,'not written');
    for(const ws of book.worksheets) ws.eachRow(r=>r.eachCell(c=>assert.notEqual(c.type,ExcelJS.ValueType.Formula)));
  } finally {await rm(dir,{recursive:true,force:true});}
});

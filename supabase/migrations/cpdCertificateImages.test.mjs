import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('image save/ownership/version/duplication/retention contracts in PostgreSQL', { timeout: 90000 }, async () => {
  const h = await createLocalPostgresHarness('cpd-images-');
  const command = (name,args) => { const r=spawnSync(name,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  const query = text => spawnSync('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8'});
  const sql = text => { const r=query(text); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
  try {
    command('initdb',['-D',h.data,'-A','trust','-U','postgres','--no-locale']);
    command('pg_ctl',['-D',h.data,'-l',`${h.root}/server.log`,'-o',`-k ${h.socket} -p ${h.port} -h ''`,'-w','start']);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY); CREATE TABLE role(id uuid,excluded_features text[]);`);
    for (const file of ['20260906_cpd_certificate_templates.sql','20261027_cpd_certificate_authored_text.sql',
      '20261028_cpd_certificate_checked_save.sql','202701190002_cpd_certificate_images.sql','202701190003_cpd_certificate_image_cleanup.sql']) {
      sql(readFileSync(new URL(file,import.meta.url),'utf8'));
    }
    sql(`INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
      INSERT INTO cpd_certificate_template(id,tenant_id,name,source_geometry) VALUES
      ('${id(3)}','${id(1)}','Original','[{"width":600,"height":800}]'),
      ('${id(4)}','${id(1)}','Copy','[{"width":600,"height":800}]'),
      ('${id(5)}','${id(2)}','Other tenant','[]');`);
    const hash='a'.repeat(64);
    const asset=sql(`SET ROLE service_role; SELECT upload_cpd_certificate_image('${id(1)}','${id(3)}',1,'${hash}','image/png',80,40,'aGVsbG8=');`);
    const field={ placeholder_key:'signature.signer',field_type:'image',image_asset_id:asset,image_sha256:hash,
      text_template:null,label:'Signature',page_number:1,x:20,y:30,width:80,height:40,font_family:'Helvetica',font_size:12,
      font_style:'normal',alignment:'left',color:'#000000',line_height:1.2,minimum_font_size:4,vertical_align:'middle',
      overflow_policy:'shrink',missing_policy:'error',multiline:false,shrink_to_fit:true,display_order:0 };
    const save=(template,version,fields=[field],tenant=id(1)) => `SET ROLE service_role; SELECT (save_cpd_certificate_template_images_checked(
      '${template}','${tenant}',${version},'${template}',NULL,'${JSON.stringify(fields)}','test')).version;`;
    assert.equal(sql(save(id(3),1)),'2');
    assert.equal(sql(`SELECT image_sha256 FROM cpd_certificate_placeholder WHERE template_id='${id(3)}'`),hash);
    assert.notEqual(query(save(id(3),1)).status,0,'stale version must fail');
    assert.notEqual(query(save(id(4),1)).status,0,'unbound same-tenant image must fail');
    assert.notEqual(query(save(id(5),1,[field],id(2))).status,0,'cross-tenant image must fail');
    assert.equal(sql(`SELECT version FROM cpd_certificate_template WHERE id='${id(4)}'`),'1','failed save rolls back version');
    assert.equal(sql(`SELECT count(*) FROM cpd_certificate_placeholder WHERE template_id='${id(3)}'`),'1');
    sql(`SET ROLE service_role; SELECT copy_cpd_certificate_images('${id(1)}','${id(3)}','${id(4)}');`);
    assert.equal(sql(save(id(4),1)),'2');
    assert.equal(sql(save(id(3),2,[])),'3');
    const pending=sql(`SET ROLE service_role; SELECT upload_cpd_certificate_image('${id(1)}','${id(3)}',3,'${hash}','image/png',80,40,'aGVsbG8=');`);
    sql(`DELETE FROM cpd_certificate_template WHERE id='${id(3)}';`);
    assert.equal(sql(`SELECT count(*) FROM cpd_certificate_image WHERE id='${pending}'`),'0','deletion clears unpublished uploads');
    assert.equal(sql(`SELECT count(*) FROM cpd_certificate_image WHERE id='${asset}' AND published_at IS NOT NULL`),'1');
    assert.equal(sql(`SELECT image_asset_id FROM cpd_certificate_placeholder WHERE template_id='${id(4)}'`),asset);
    assert.notEqual(query(`SET ROLE service_role; UPDATE cpd_certificate_image SET sha256='${'b'.repeat(64)}';`).status,0);
    for (const role of ['anon','authenticated']) {
      assert.equal(sql(`SELECT has_table_privilege('${role}','cpd_certificate_image','SELECT')`),'f');
      assert.equal(sql(`SELECT has_function_privilege('${role}','upload_cpd_certificate_image(uuid,uuid,integer,text,text,integer,integer,text)','EXECUTE')`),'f');
    }
    // Active guard checked in SQL, not just by the upload handler.
    sql(`UPDATE cpd_certificate_template SET source_bucket='private-uploads',source_path='private.pdf',
      source_filename='test.pdf',source_mime_type='application/pdf',source_size_bytes=1,
      source_sha256='${hash}',source_page_count=1,status='active' WHERE id='${id(4)}';`);
    assert.notEqual(query(save(id(4),2)).status,0);
    assert.notEqual(query(`SELECT upload_cpd_certificate_image('${id(1)}','${id(4)}',2,'${hash}','image/png',80,40,'aGVsbG8=');`).status,0);
  } finally {
    spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop'],{encoding:'utf8'});
    await h.cleanup();
  }
});

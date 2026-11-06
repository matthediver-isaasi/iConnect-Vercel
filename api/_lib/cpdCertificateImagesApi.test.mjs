import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { handleCpdTemplates } from './cpdCertificateTemplatesApi.js';
import { signatureHash } from './cpdCertificateImages.js';

const assetId='10000000-0000-4000-8000-000000000001';
async function fixture({ authorized=true, active=false, conflict=false, binding=true, corrupt=false }={}) {
  const bytes=await sharp({create:{width:80,height:40,channels:4,background:'transparent'}}).png().toBuffer();
  const asset={id:assetId,tenant_id:'tenant',sha256:signatureHash(bytes),mime_type:'image/png',
    width:80,height:40,content_base64:(corrupt?Buffer.from('wrong'):bytes).toString('base64')};
  const calls=[];
  const template={id:'template',tenant_id:'tenant',status:active?'active':'draft',version:2,source_geometry:[{width:600,height:800}]};
  const db={from(table) {
    const filters={};
    const rows=table==='role'?[{id:'role',tenant_id:'tenant',excluded_features:[]}]:
      table==='cpd_certificate_template'?[template]:
      table==='cpd_certificate_image'?[asset]:
      table==='cpd_certificate_image_binding'&&binding?[{tenant_id:'tenant',template_id:'template',asset_id:assetId}]:[];
    let single=false;
    const q={select(){return q;},eq(k,v){filters[k]=v;return q;},order(){return q;},
      maybeSingle(){single=true;return q;},
      then(resolve,reject){const found=rows.filter(row=>Object.entries(filters).every(([k,v])=>row[k]===v));
        return Promise.resolve({data:single?found[0]:found}).then(resolve,reject);}};
    return q;
  },async rpc(name,args){calls.push({name,args});return conflict?{error:{code:'40001'}}:{data:assetId};}};
  async function invoke(method,buffer=bytes,query={},context={}) {
    const boundary='signatureBoundary';
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n2\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`),
      buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req=Readable.from([body]);
    Object.assign(req,{method,query:{id:'template',assetId,...query},headers:method==='POST'?{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(body.length)}:{}});
    const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;},
      setHeader(k,v){this.headers[k]=v;},send(value){this.body=value;return this;}};
    await handleCpdTemplates(req,res,'signatures',{supabase:db,getTenantContext:async()=>authorized?
      {isAuthenticated:true,tenantId:'tenant',roleId:'role',...context}:null});
    return res;
  }
  return {invoke,calls,asset,bytes};
}
test('multipart signature upload authorizes before decoding and binds to a checked template version',async()=>{
  const f=await fixture();
  const res=await f.invoke('POST');
  assert.equal(res.statusCode,201);
  assert.equal(res.body.asset.sha256,f.asset.sha256);
  assert.equal(f.calls[0].name,'upload_cpd_certificate_image');
  assert.equal(f.calls[0].args.p_expected_version,2);
  assert.equal(f.calls[0].args.p_template_id,'template');
  assert.equal(f.calls[0].args.p_content_base64,f.bytes.toString('base64'));
  for (const [options,status] of [[{authorized:false},401],[{active:true},409],[{conflict:true},409]]) {
    const rejected=await fixture(options);
    assert.equal((await rejected.invoke('POST')).statusCode,status);
    if(!options.conflict) assert.equal(rejected.calls.length,0);
  }
});
test('invalid files, tenant mismatches and unavailable assets fail closed; previews never cache publicly',async()=>{
  const f=await fixture();
  const invalid=await f.invoke('POST',Buffer.from('fake PNG'));
  assert.equal(invalid.statusCode,400);assert.match(invalid.body.error,/decoded/);
  assert.equal(f.calls.length,0);
  assert.equal((await f.invoke('POST',undefined,{}, {tenantId:'other'})).statusCode,403);
  const preview=await f.invoke('GET');
  assert.equal(preview.statusCode,200);
  assert.deepEqual(preview.body,f.bytes);
  assert.equal(preview.headers['Cache-Control'],'private, no-store');
  assert.equal(preview.headers['X-Content-Type-Options'],'nosniff');
  assert.equal((await f.invoke('GET',undefined,{id:'other-template'})).statusCode,404);
  assert.match((await (await fixture({binding:false})).invoke('GET')).body.error,/not available/);
  assert.match((await (await fixture({corrupt:true})).invoke('GET')).body.error,/integrity/);
});

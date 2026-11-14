import test from 'node:test';
import assert from 'node:assert/strict';
import {attachmentOffset,sendAttachmentChunk} from './attachmentResponse.js';
test('attachment response uses bounded ranges and immutable checksum headers',()=>{
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},send(body){this.body=body;return this;}};
  sendAttachmentChunk(res,{name:'Evidence.pdf',hex:'abcd',offset:1048576,total:1048578,bytes:2,sha256:'a'.repeat(64)});
  assert.equal(res.code,206);assert.equal(res.headers['Content-Range'],'bytes 1048576-1048577/1048578');
  assert.equal(res.body.toString('hex'),'abcd');
  assert.throws(()=>sendAttachmentChunk(res,{name:'x',hex:'abcd',offset:0,total:1,bytes:2,sha256:'a'.repeat(64)}));
});
test('attachment offsets reject coercion, arrays and ranges beyond the upload limit',()=>{
  assert.equal(attachmentOffset(undefined),0);assert.equal(attachmentOffset('1048576'),1048576);
  for(const value of ['-1','1e3','1.5','01','',[],26214400,'26214400'])assert.throws(()=>attachmentOffset(value));
});

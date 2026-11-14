export function attachmentOffset(value){
  if(value===undefined)return 0;
  if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw Object.assign(new Error('Invalid attachment range'),{status:400});
  const offset=Number(value);
  if(!Number.isSafeInteger(offset)||offset>=25*1024*1024)throw Object.assign(new Error('Invalid attachment range'),{status:400});
  return offset;
}
export function sendAttachmentChunk(res,data){
  const bytes=Buffer.from(data.hex,'hex');
  if(!Number.isInteger(data.offset)||data.offset<0||!Number.isInteger(data.total)||data.total>25*1024*1024
    ||!bytes.length||bytes.length>1048576||data.bytes!==bytes.length||data.offset+bytes.length>data.total
    ||typeof data.sha256!=='string'||!/^[a-f0-9]{64}$/.test(data.sha256))throw new Error('Invalid retained attachment chunk');
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Content-Range',`bytes ${data.offset}-${data.offset+bytes.length-1}/${data.total}`);
  res.setHeader('X-Awards-File-Sha256',data.sha256);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Disposition',`attachment; filename="award-attachment"; filename*=UTF-8''${encodeURIComponent(data.name).replace(/'/g,'%27')}`);
  return res.status(206).send(bytes);
}

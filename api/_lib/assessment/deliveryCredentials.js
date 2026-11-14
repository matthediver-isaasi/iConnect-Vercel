import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
function key(secret){
  if(typeof secret!=='string'||secret.length<16)throw new Error('Award delivery encryption is not configured');
  return createHash('sha256').update(`awards-delivery-v1:${secret}`).digest();
}
export function sealInvitation(token,context,secret=process.env.SESSION_SECRET){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return{v:1,nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};
}
export function openInvitation(envelope,context,secret=process.env.SESSION_SECRET){
  if(envelope?.v!==1)throw new Error('Unsupported award credential envelope');
  const decipher=createDecipheriv('aes-256-gcm',key(secret),Buffer.from(envelope.nonce,'base64url'));
  decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(envelope.tag,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64url')),decipher.final()]).toString('utf8');
}

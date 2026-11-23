import {createHmac,timingSafeEqual} from 'node:crypto';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function receiveFunnelMailgunReceipt({body,db,signingKey}) {
  const event=body?.['event-data']||body,variables=event?.['user-variables'];
  if(!variables||typeof variables!=='object'||Array.isArray(variables)
    ||!Object.hasOwn(variables,'iconn_funnel_confirmation')&&!Object.hasOwn(variables,'iconn_funnel_receipt'))return null;
  const signature=body?.signature;
  if(!signingKey)return {status:503,body:{error:'Receipt verification is not configured'}};
  if(!signature||!/^\d{1,12}$/.test(String(signature.timestamp))
    ||typeof signature.token!=='string'||signature.token.length>256
    ||typeof signature.signature!=='string'||!/^[a-f0-9]{64}$/i.test(signature.signature)) {
    return {status:401,body:{error:'Invalid receipt signature'}};
  }
  const expected=createHmac('sha256',signingKey).update(String(signature.timestamp)+signature.token).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature.signature,'hex')))return {status:401,body:{error:'Invalid receipt signature'}};
  const id=variables.iconn_funnel_confirmation,token=variables.iconn_funnel_receipt;
  if(!uuid(id)||!uuid(token))return {status:400,body:{error:'Invalid receipt identity'}};
  if(!['accepted','delivered','failed'].includes(event.event))return {status:200,body:{ignored:true}};
  const message=event.message?.headers?.['message-id']||event['message-id'];
  const time=typeof event.timestamp==='number'?new Date(event.timestamp*1000):null;
  if(typeof message!=='string'||!message||message.length>500||typeof event.recipient!=='string'
    ||!event.recipient||event.recipient.length>320||!Number.isFinite(time?.getTime())) {
    return {status:400,body:{error:'Incomplete receipt evidence'}};
  }
  if(!db)return {status:503,body:{error:'Receipt recovery unavailable'}};
  const result=await db.rpc('event_funnel_confirmation_receipt',{
    p_item:id,p_nonce:token,p_recipient:event.recipient,p_message_id:message.replace(/^<|>$/g,''),
    p_event:event.event,p_at:time.toISOString(),
  });
  if(result.error)return {status:503,body:{error:'Receipt recovery requires retry'}};
  return {status:200,body:{received:true}};
}

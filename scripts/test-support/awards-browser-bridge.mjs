import {createInterface} from 'node:readline';

const prefix='AWARDS_BROWSER_FRAME:';
export function createAwardsBrowserBridge(call){
  const input=createInterface({input:process.stdin});
  let active;
  const send=value=>process.stdout.write(`${prefix}${JSON.stringify(value)}\n`);
  input.on('line',async line=>{
    let frame;try{frame=JSON.parse(line);}catch{return;}
    if(!active)return;
    if(frame.type==='done'){
      const current=active;active=null;clearTimeout(current.timer);
      if(frame.error)current.reject(new Error(frame.error));else current.resolve();
      return;
    }
    if(frame.type!=='request')return;
    try{
      // Fixed assignment and principal: the browser cannot choose an identity
      // or call arbitrary administration endpoints through this fixture.
      if(active.kind==='certificate'){
        if(frame.path!=='awards/certificates'||!['preview','issue'].includes(frame.body?.command)
          ||frame.body.templateId!==active.templateId||frame.body.outcomeId!==active.outcomeId)throw new Error('Browser fixture certificate denied');
      }else if(active.kind==='event'){
        if(frame.path!=='public/awards-event'||frame.body||frame.query?.eventId!==active.eventId
          ||frame.query?.audience!=='public')throw new Error('Browser fixture public event denied');
      }else if(active.kind==='moderation'){
        if(!['awards/moderation','awards/assessment-history'].includes(frame.path))throw new Error('Browser fixture endpoint denied');
        const scope=frame.body||frame.query;
        if(scope?.roundId!==active.roundId||scope?.applicationId!==active.applicationId)throw new Error('Browser fixture evidence scope denied');
      }else{
        if(frame.path!=='judging/assessment')throw new Error('Browser fixture endpoint denied');
        if((frame.body?.assignmentId||frame.query?.assignmentId)!==active.assignmentId)throw new Error('Browser fixture assignment denied');
      }
      const principal=typeof active.judge==='object'
        ?{cookie:frame.headers?.cookie,csrf:frame.headers?.['x-judging-csrf']}:active.judge;
      const result=await call(frame.path,frame.body,principal,frame.query);
      send({type:'response',id:frame.id,status:result.statusCode,body:result.body,contentType:result.headers?.['Content-Type']});
    }catch(error){send({type:'response',id:frame.id,status:500,body:{error:error.message}});}
  });
  return{
    certificate({judge,tenantId,template,outcome}){
      return new Promise((resolve,reject)=>{
        active={kind:'certificate',judge,templateId:template.id,outcomeId:outcome.id,resolve,reject,
          timer:setTimeout(()=>reject(new Error('Native certificate browser step timed out')),45000)};
        send({type:'certificate',tenantId,template,outcome});
      });
    },
    event({eventId,published}){
      return new Promise((resolve,reject)=>{
        active={kind:'event',judge:{},eventId,resolve,reject,timer:setTimeout(()=>reject(new Error('Native event browser step timed out')),45000)};
        send({type:'event',eventId,published});
      });
    },
    moderate({judge,roundId,applicationId,tenantId,action,score}){
      if(active)throw new Error('Concurrent browser steps are not supported');
      return new Promise((resolve,reject)=>{
        active={kind:'moderation',judge,roundId,applicationId,resolve,reject,timer:setTimeout(()=>reject(new Error('Native moderation browser step timed out')),45000)};
        send({type:'moderation',roundId,applicationId,tenantId,action,score});
      });
    },
    assess({judge,assignmentId,value,criterionId='merit',cookie,csrf}){
      if(active)throw new Error('Concurrent browser steps are not supported');
      return new Promise((resolve,reject)=>{
        active={judge,assignmentId,resolve,reject,timer:setTimeout(()=>reject(new Error('Native browser step timed out')),45000)};
        send({type:'assessment',assignmentId,value,criterionId,cookie,csrf});
      });
    },
    close(){if(active)clearTimeout(active.timer);input.close();process.stdin.pause();},
  };
}

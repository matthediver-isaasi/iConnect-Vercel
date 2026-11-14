import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright';
let server,browser,origin,requests=[];
before(async()=>{
  const result=await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
    import React from 'react';import{createRoot}from'react-dom/client';
    import JudgingAssessment from './client/src/components/awards/JudgingAssessment.jsx';
    const data={assignment:{id:'assignment',version:1,conflict:'none',applicationVersionId:'application-version',criteriaVersionId:'criteria-version'},
      criteria:{definition:{optionalPolicy:'incomplete',criteria:[{id:'quality',title:'Research quality',type:'numeric',min:0,max:5,weight:100,required:true,commentsRequired:true}]}},assessment:null};
    createRoot(document.getElementById('root')).render(<JudgingAssessment data={data} summary={{roundState:'judging',deadline:'2099-01-01T00:00:00Z'}}
      onDirtyChange={()=>{}} onBusyChange={()=>{}} onSaved={()=>{}}/>);
  `},bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':`${process.cwd()}/client/src`},
    define:{'process.env.NODE_ENV':'"test"'}});
  server=createServer(async(req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(result.outputFiles[0].text);}
    if(req.url==='/api/judging/assessment'){
      let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input);
      res.setHeader('Content-Type','application/json');
      if(requests.length===1){res.statusCode=503;return res.end(JSON.stringify({error:'Fixture temporary failure'}));}
      return res.end(JSON.stringify({id:'revision',revision:input.expectedRevision+1,state:input.submit?'submitted':'draft',
        score:{numerator:'80',denominator:'1'},flags:[],scoringComplete:true}));
    }
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
for(const width of [1280,390])test(`judging retains failed drafts and locks confirmed submission at ${width}px`,async()=>{
  requests=[];const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(6000);
  try{
    await page.goto(origin);
    await page.locator('#judge-quality-value').fill('4');
    await page.locator('#judge-quality-comment').fill('Clear evidence and sound methods');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Fixture temporary failure'}).waitFor();
    assert.equal(await page.locator('#judge-quality-value').inputValue(),'4');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('Draft saved'));
    assert.equal(requests[0].requestId,requests[1].requestId);
    await page.getByRole('button',{name:'Submit assessment',exact:true}).click();
    await page.getByRole('button',{name:'Confirm submission',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#judge-quality-value')?.matches(':disabled'));
    assert.equal(requests.at(-1).expectedRevision,1);
    assert.equal(requests.at(-1).submit,true);
    assert.equal(requests.at(-1).answers.quality.comment,'Clear evidence and sound methods');
  }finally{await page.close();}
});

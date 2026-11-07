import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
test('admin can select the entry questionnaire, save its revision, and see a save conflict',async()=>{
 const dom=new JSDOM('<html><body></body></html>',{url:'https://fixture.invalid/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
  HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true});
 const bundle=await build({entryPoints:['client/src/components/admin/MembershipRenewalJourneySettings.jsx'],
  bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',
  plugins:[{name:'transport',setup(b){b.onResolve({filter:/^@\/lib\/adminFetch$/},()=>({path:'transport',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const adminFetch=(...args)=>globalThis.__journeyFetch(...args);',loader:'js'}));}}]});
 const m=new Module(`${process.cwd()}/journey-test.cjs`);m.filename=`${process.cwd()}/journey-test.cjs`;m.paths=Module._nodeModulePaths(process.cwd());
 m._compile(bundle.outputFiles[0].text,m.filename);
 const React=m.require('react'),{act}=React,{createRoot}=m.require('react-dom/client'),{Simulate}=m.require('react-dom/test-utils');
 const Component=m.exports.default,posts=[];let conflict=false;
 globalThis.__journeyFetch=async(url,options,tenant)=>{
  assert.equal(tenant,'tenant');
  if(options.method==='PUT') {
   posts.push(JSON.parse(options.body));
   return new Response(JSON.stringify(conflict?{error:'Settings changed. Reload before saving.'}:{settings:{mode:'questionnaire',form_id:'form',revision:1}}),{status:conflict?409:200});
  }
  return new Response(JSON.stringify({settings:{mode:'same_schedule',form_id:null,revision:0},forms:[{id:'form',name:'Renewing with BNMS'}]}));
 };
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
 try{
  await act(async()=>root.render(React.createElement(Component,{tenantId:'tenant'})));await settle();
  assert.equal(host.querySelectorAll('input[type="radio"]')[0].checked,true);
  await act(async()=>host.querySelectorAll('input[type="radio"]')[1].click());
  await act(async()=>Simulate.change(host.querySelector('select'),{target:{value:'form'}}));
  await act(async()=>Simulate.submit(host.querySelector('form')));await settle();
  assert.deepEqual(posts[0],{mode:'questionnaire',formId:'form',expectedRevision:0});
  assert.match(host.textContent,/Renewal journey saved/);
  conflict=true;await act(async()=>Simulate.submit(host.querySelector('form')));await settle();
  assert.match(host.querySelector('[role="alert"]').textContent,/Settings changed/);
  assert.equal(posts[1].expectedRevision,1);
 }finally{await act(async()=>root.unmount());delete globalThis.__journeyFetch;dom.window.close();}
});

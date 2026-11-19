import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://example.test'});
for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver']){
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
}
globalThis.getComputedStyle=dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react');globalThis.React=React;
const {act}=React;
const {createRoot}=await import('react-dom/client');
const {Simulate}=await import('react-dom/test-utils');
const {default:Selector}=await import('./AttendeeOptionsSelector.jsx');
const {default:Editor}=await import('../events/EventOptionListsEditor.jsx');
const {sanitizeOptionSelections}=await import('../../../../api/_lib/eventOptionSelections.js');

test('selecting Other reveals independent inputs, saves details and clears them on deselection',async()=>{
 const options={dietary_options:['Vegan','Other'],accessibility_options:['Other']};
 let latest={};
 function Harness(){
  const [value,setValue]=React.useState({dietary_selections:['Vegan']});
  return <Selector eventOptions={options} value={value} idPrefix="person"
    onChange={v=>{latest=v;setValue(v);}}/>;
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<Harness/>));
  assert.equal(host.querySelector('#person-dietary-other'),null);
  await act(async()=>host.querySelector('#person-dietary-1').click());
  assert.ok(host.querySelector('#person-dietary-other'));
  await act(async()=>Simulate.change(host.querySelector('#person-dietary-other'),{target:{value:'No onions'}}));
  await act(async()=>host.querySelector('#person-accessibility-0').click());
  await act(async()=>Simulate.change(host.querySelector('#person-accessibility-other'),{target:{value:'Quiet space'}}));
  assert.equal(host.querySelector('#person-dietary-1').getAttribute('aria-checked'),'true');
  const saved=sanitizeOptionSelections(latest,options);
  assert.deepEqual(saved.dietary_selections,['Vegan','Other: No onions']);
  assert.deepEqual(saved.accessibility_selections,['Other: Quiet space']);
  await act(async()=>host.querySelector('#person-dietary-1').click());
  assert.equal(host.querySelector('#person-dietary-other'),null);
  assert.deepEqual(latest.dietary_selections,['Vegan']);
  assert.deepEqual(latest.accessibility_selections,['Other: Quiet space']);
  await act(async()=>root.render(<Selector eventOptions={options} value={saved} idPrefix="restored" onChange={()=>{}}/>));
  assert.equal(host.querySelector('#restored-dietary-other').value,'No onions');
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('setup adds Other explicitly and recognises an existing manually entered Other',async()=>{
 const host=document.createElement('div');const root=createRoot(host);let result;
 try{
  await act(async()=>root.render(<Editor dietaryOptions={['Vegan']} accessibilityOptions={[' other ']}
   onDietaryChange={v=>result=v} onAccessibilityChange={()=>{}} onAllergyChange={()=>{}}/>));
  await act(async()=>host.querySelector('[data-testid="button-add-dietary-other"]').click());
  assert.deepEqual(result,['Vegan','Other']);
  assert.equal(host.querySelector('[data-testid="button-add-accessibility-other"]').disabled,true);
 }finally{await act(async()=>root.unmount());}
});

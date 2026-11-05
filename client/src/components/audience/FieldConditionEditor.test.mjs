import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const bundle=await build({entryPoints:['client/src/components/audience/FieldConditionEditor.jsx'],bundle:true,write:false,packages:'external',platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const filename=`${process.cwd()}/audience-test.cjs`;
const mod=new Module(filename);mod.paths=Module._nodeModulePaths(process.cwd());mod._compile(bundle.outputFiles[0].text,filename);
const {FieldConditionRow}=mod.exports;
function render(options,value=''){
  return renderToStaticMarkup(React.createElement(FieldConditionRow,{metadata:{member:{core:[{key:'role_id',label:'Role',data_type:'text',choice_only:true,options}]}},
    condition:{entity_scope:'member',field_key:'role_id',field_type:'core',operator:'equals',value},onChange(){}}));
}
test('single choices render as a labelled selector storing IDs, not a text box',()=>{
  const html=render([{value:'role-id',label:'Super Admin'}],'role-id');
  assert.match(html,/<select aria-label="Condition value"/);assert.match(html,/value="role-id" selected="">Super Admin/);
  assert.doesNotMatch(html,/input-filter-value/);
});
test('legacy typed labels and empty choices are explicit, not free-text fallbacks',()=>{
  assert.match(render([{value:'role-id',label:'Super Admin'}],'Super Admin'),/saved value is not an available choice/);
  assert.match(render([]),/No choices available/);
  assert.doesNotMatch(render([]),/input-filter-value/);
});

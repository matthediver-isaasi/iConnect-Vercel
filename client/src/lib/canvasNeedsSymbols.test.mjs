import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasNeedsSymbols} from './canvasNeedsSymbols.mjs';
test('ordinary portal blocks need no full symbol-library request',()=>{
 assert.equal(canvasNeedsSymbols({blocks:[{type:'payment-details'},{type:'event-teaser'}]}),false);
});
test('nested references, symbol blocks and unknown serialization retain lookup',()=>{
 for(const design of [{blocks:[{type:'symbol'}]},{sections:[{blocks:[{content:{symbolId:'a'}}]}]},'{bad',
 JSON.stringify({blocks:[{type:'symbol'}]}),{headerSymbolId:'header'}])assert.equal(canvasNeedsSymbols(design),true);
});

// Real repository component, isolated data only; no tenant or storage writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const names = ['AnnualReport'.repeat(18) + '.pdf',
  'Annual membership report supporting documents and financial statements for committee review final edition.pdf',
  'short.pdf'];
const bundle = await build({
  stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import Page from './client/src/pages/FileManagement.jsx';
    import {FileRepositoryPicker} from './client/src/components/ImageSelector.jsx';
    import {base44} from './client/src/api/base44Client.js';
    const folders=[
      {id:'a',name:'Marketing',parent_folder_id:null},
      {id:'b',name:'Reports',parent_folder_id:null},
      {id:'c',name:'Archive',parent_folder_id:'a'},
      {id:'d',name:'Older',parent_folder_id:'c'}
    ];
    const files=Array.from({length:15},(_,i)=>({
      id:'file-'+i,file_name:i===14?'deep-report.pdf':'document-'+i+'.pdf',
      folder_id:i===0?null:['a','b','d'][i%3],file_type:'document',file_size:1024,
      description:'Repository fixture',tags:i===14?['historic']:[],file_url:'https://files.test/example.pdf'
    }));
    const wrapping = new URLSearchParams(location.search).has('wrapping');
    if(wrapping) files.splice(0,files.length,...${JSON.stringify(names)}.map((name,i)=>({
      id:'wrap-'+i,file_name:name,folder_id:null,file_type:'document',file_size:1024,
      description:'Repository fixture description stays truncated as before',file_url:'https://files.test/'+i+'.pdf'
    })));
    base44.entities.FileRepository.list=async()=>files.map(f=>({...f}));
    base44.entities.FileRepository.listAll=async()=>files.map(f=>({...f}));
    base44.entities.FileRepositoryFolder.list=async()=>folders;
    base44.entities.FileRepositoryFolder.listAll=async()=>folders;
    window.actions=[];
    base44.entities.FileRepository.update=async(id,data)=>{window.actions.push({id,data});Object.assign(files.find(f=>f.id===id),data);};
    base44.entities.FileRepository.delete=async(id)=>{window.actions.push({deleted:id});files.splice(files.findIndex(f=>f.id===id),1);};
    window.open=(url)=>window.actions.push({opened:url});
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async(url)=>window.actions.push({copied:url})}});
    base44.entities.SystemSettings.filter=async()=>[];
    window.fetch=async url=>{
      if(url!=='/api/admin/plan-usage') throw Error('Unexpected fixture request');
      return {ok:true,json:async()=>({})};
    };
    function Fixture(){
      const [open,setOpen]=React.useState(new URLSearchParams(location.search).has('picker'));
      return <><button onClick={()=>setOpen(true)}>Open fixture picker</button><Page/>
        <FileRepositoryPicker open={open} onOpenChange={setOpen} onSelect={asset=>window.selectedAsset=asset}/></>;
    }
    createRoot(document.getElementById('root')).render(<MemoryRouter>
      <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
        <Fixture/>
      </QueryClientProvider></MemoryRouter>);
  `, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  alias: { '@': `${process.cwd()}/client/src` },
  define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
});
const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css',
  '--content', 'client/src/pages/FileManagement.jsx,client/src/components/ImageSelector.jsx,client/src/components/ui/**/*.{jsx,tsx}'], { maxBuffer: 10 * 1024 * 1024 });
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(process.argv.includes('--serve') ? 5173 : 0, '0.0.0.0', resolve));
if (process.argv.includes('--serve')) {
  console.log('Repository fixture on port 5173');
} else {
  test('repository sidebar, combined pages, search and destinations in Chromium', async () => {
    const browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: 'Delete document-0.pdf', exact: true }).waitFor();
      await page.getByTestId('scope-all-files').click();
      assert.equal(await page.getByRole('heading', { name: 'All files', exact: true }).count(), 1);
      assert.ok((await page.getByTestId('scope-all-files').boundingBox()).y < (await page.getByTestId('scope-root').boundingBox()).y);
      await page.getByText('Showing 1-12 of 15 files').waitFor();
      await page.getByRole('button', { name: '2', exact: true }).click();
      await page.getByRole('button', { name: 'Delete deep-report.pdf', exact: true }).waitFor();
      await page.getByPlaceholder('Search files...').fill('historic');
      await page.getByText('Showing 1-1 of 1 files').waitFor();
      await page.getByRole('button', { name: 'New Folder', exact: true }).click();
      await page.getByText('Parent Folder: Root', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByTestId('scope-root').click();
      await page.getByRole('heading', { name: 'No Files Found' }).waitFor();
      for (const width of [1440, 390]) {
        await page.setViewportSize({width,height:1000});
        await page.goto(`http://127.0.0.1:${server.address().port}/?wrapping`);
        for (const [i,name] of names.entries()) {
          const title = page.getByText(name,{exact:true});
          await title.waitFor();
          const card = page.locator('[draggable="true"]').filter({has:title});
          await assertWrapping(title,card,name,i<2);
        }
        const card = page.locator('[draggable="true"]').filter({has:page.getByText(names[0],{exact:true})});
        await card.getByRole('button',{name:'Copy URL',exact:true}).click();
        await card.locator('button').filter({has:page.locator('svg.lucide-external-link')}).click();
        await card.getByRole('button',{name:'Edit Info'}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
        await page.locator('[draggable="true"]').filter({has:page.getByText(names[2],{exact:true})})
          .getByRole('button',{name:'Edit Info'}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Save Changes'}).click();
        await page.getByRole('dialog').waitFor({state:'hidden'});
        assert.deepEqual(await page.evaluate(()=>window.actions.slice(0,2)),
          [{copied:'https://files.test/0.pdf'},{opened:'https://files.test/0.pdf'}]);
        assert.equal(await page.evaluate(()=>window.actions[2].id),'wrap-2');
        await page.getByRole('button',{name:'Bulk Move Mode',exact:true}).click();
        await card.click();
        assert.match(await card.getAttribute('class'),/ring-4/);
        await page.getByRole('button',{name:'Open fixture picker'}).click();
        const dialog=page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
        for(const [i,name] of names.entries()){
          const pickerCard=page.getByTestId('file-select-wrap-'+i);
          await assertWrapping(pickerCard.getByText(name,{exact:true}),pickerCard,name,i<2);
        }
        await page.getByTestId('file-select-wrap-0').click();
        assert.equal(await page.evaluate(()=>window.selectedAsset.name),names[0]);
        await dialog.waitFor({state:'hidden'});
        page.once('dialog',dialog=>dialog.accept());
        await card.getByRole('button',{name:'Delete '+names[0],exact:true}).click();
        await card.waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>window.actions.at(-1).deleted),'wrap-0');
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function assertWrapping(title, card, name, multiline) {
  const result=await title.evaluate((el)=>{
    const r=el.getBoundingClientRect(),style=getComputedStyle(el);
    const range=document.createRange();range.selectNodeContents(el);
    return {text:el.textContent,x:r.x,right:r.right,y:r.y,bottom:r.bottom,height:r.height,
      lineHeight:parseFloat(style.lineHeight),whiteSpace:style.whiteSpace,overflow:style.overflow,
      rects:[...range.getClientRects()].map(r=>({x:r.x,right:r.right,y:r.y,bottom:r.bottom}))};
  });
  const bounds=await card.boundingBox();
  assert.equal(result.text,name);
  assert.equal(result.whiteSpace,'normal');
  assert.notEqual(result.overflow,'hidden');
  assert.ok(multiline ? result.height>result.lineHeight : result.height<=result.lineHeight+1);
  for(const rect of result.rects){
    assert.ok(rect.x>=bounds.x && rect.right<=bounds.x+bounds.width+1,'text stays inside card');
    assert.ok(rect.y>=bounds.y && rect.bottom<=bounds.y+bounds.height+1,'all lines visible');
  }
  assert.ok(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no card overflow');
  const obstacles=await card.locator('button, [role="combobox"], svg, p').evaluateAll(els=>
    els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,text:el.textContent};}));
  for(const obstacle of obstacles.filter(o=>o.text!==name)){
    assert.ok(result.right<=obstacle.x+1 || result.x>=obstacle.right-1 ||
      result.bottom<=obstacle.y+1 || result.y>=obstacle.bottom-1,'filename does not overlap icons, metadata or controls');
  }
}

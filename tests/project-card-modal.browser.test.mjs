// Isolated real-component browser fixture. No live tenant or storage writes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let browser, server, origin;
async function setup() {
  const output = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
      import Modal from './client/src/components/sales/ProjectCardDetailModal.jsx';
      import {publishProjectCardUpdate} from './client/src/lib/projectBoardCache.js';
      const card={id:'card',board_id:'board',list_id:'list',title:'Plan the autumn webinar',
        description:'Confirm the programme and prepare the speaker briefing.',priority:'medium',
        project_card_label:[],project_card_assignee:[],cover_image:null};
      const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
      client.setQueryData(['project-board','board'],{cards:[card],labels:[]});
      window.fixtureClient=client;
      function App(){
        const board=useQuery({queryKey:['project-board','board'],queryFn:()=>fetch('/api/projects/boards/board').then(r=>r.json())});
        return <><div data-testid="board-cover">{board.data.cards[0].cover_image||'No cover'}</div>
          <Modal card={board.data.cards[0]} open onOpenChange={()=>{}} boardId="board"
            labels={board.data.labels} lists={[{id:'list',name:'To do'}]}
            members={[{identity_id:'person',first_name:'Alex',last_name:'Example'}]}
            canEdit canManage canAssign canManageLabels
            onUpdate={async patch=>{window.savedPatch=patch;await publishProjectCardUpdate(client,'card',patch);}}
            onDelete={()=>{}} /></>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' }, logLevel: 'silent',
  });
  const cssName = (await readdir('dist/public/assets')).find(name => /^index-.*\.css$/.test(name));
  const css = await readFile(`dist/public/assets/${cssName}`);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(output.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/projects/cards/card') return res.end(JSON.stringify({
        card: { id: 'card',board_id:'board',list_id:'list',cover_image:null },
        attachments:[],comments:[{id:'comment',identity_id:'person',content:'The draft agenda is ready for review.',created_at:'2026-10-09T10:00:00Z'}],activity:[],
      }));
      res.statusCode = 500; return res.end('{"error":"Unexpected fixture request"}');
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(process.argv.includes('--serve') ? 5187 : 0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
}
if (process.argv.includes('--serve')) {
  await setup(); console.log(`Fixture ready on ${origin}`); await new Promise(()=>{});
}
before(setup);
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function open(width) {
  const page = await browser.newPage({viewport:{width,height:850}});
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByText('The draft agenda is ready for review.').waitFor();
  await page.getByTestId('card-detail-modal').evaluate(async el =>
    Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))));
  return page;
}
for (const width of [1280,390]) test(`wide/stacked layout and date fields at ${width}px`, async () => {
  const page = await open(width);
  try {
    const box=await page.getByTestId('card-detail-modal').boundingBox();
    assert.ok(box.x>=0 && box.x+box.width<=width);
    if(width===1280) assert.ok(box.width>1000);
    const left=await page.getByRole('region',{name:'Card details',exact:true}).boundingBox();
    const right=await page.getByRole('complementary').boundingBox();
    if(width===1280) assert.ok(right.x>left.x+left.width-1);
    else assert.ok(right.y>=left.y+left.height-1);
    await page.getByTestId('input-start-date').fill('2026-10-10');
    await page.getByTestId('input-due-date').fill('2026-10-15');
    await page.getByTestId('button-save-card').click();
    await page.waitForFunction(()=>window.savedPatch?.start_date==='2026-10-10');
    assert.equal(await page.evaluate(()=>window.savedPatch.due_date),'2026-10-15');
  } finally {await page.close();}
});
test('upload and cover appear before slow refetches; cover uses one write and removal clears board', async () => {
  const page=await open(1280);
  try {
    // Hold every refresh until assertions are finished; only writes respond.
    await page.route('**/api/projects/cards/card',route=>route.abort());
    await page.route('**/api/projects/boards/board',route=>route.abort());
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const attachment={id:'image',card_id:'card',name:'cover.png',url:image,file_type:'image/png',file_size:68};
    const json=(route,body)=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    await page.route('**/api/projects/cards/card/attachments',route=>json(route,{signedUrl:origin+'/storage',uploadToken:'fixture'}));
    await page.route('**/storage',route=>route.fulfill({status:200,body:''}));
    await page.route('**/api/projects/cards/card/attachments/confirm',route=>json(route,{attachment}));
    let coverWrites=0;
    await page.route('**/api/projects/cards/card/attachments/image',route=>{
      coverWrites++; return json(route,{success:true,coverImage:route.request().postDataJSON().clearCover?null:image});
    });
    await page.getByTestId('input-file-upload').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('fixture')});
    await page.getByText('cover.png',{exact:true}).first().waitFor();
    await page.getByTestId('button-add-cover').click();
    await page.getByTestId('cover-option-image').click();
    await page.waitForFunction(()=>window.fixtureClient.getQueryData(['project-board','board']).cards[0].cover_image);
    assert.equal(coverWrites,1);
    assert.equal(await page.getByTestId('board-cover').textContent(),image);
    await page.getByAltText('Card cover',{exact:true}).waitFor();
    let directWrites=0;
    await page.route('**/api/projects/cards/card',route=>{
      if(route.request().method()==='PATCH'){directWrites++;return json(route,{card:{id:'card',cover_image:null}});}
      return route.abort();
    });
    await page.getByTestId('button-remove-cover').click();
    await page.waitForFunction(()=>window.fixtureClient.getQueryData(['project-board','board']).cards[0].cover_image===null);
    assert.equal(directWrites,1);
  } finally {await page.close();}
});

// Isolated real-component browser fixture. No live tenant or storage writes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';

let browser, server, origin, screenshotBytes;
async function setup() {
  const output = await build({
    outfile: '/tmp/card-modal-fixture.js',
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
      import {Toaster} from 'sonner';
      import Modal from './client/src/components/sales/ProjectCardDetailModal.jsx';
      import {publishProjectCardUpdate} from './client/src/lib/projectBoardCache.js';
      import Summary from './client/src/components/projects/ProjectCardTileSummary.jsx';
      import {useProjectCardCompletion} from './client/src/components/projects/useProjectCardCompletion.js';
      import {DragDropContext,Droppable,Draggable} from '@hello-pangea/dnd';
      const params=new URLSearchParams(location.search);
      const canEdit=!params.has('readonly');
      const card={id:'card',board_id:'board',list_id:'list',title:'Plan the autumn webinar',
        description:'Confirm the programme and prepare the speaker briefing.',priority:'medium',
        is_complete:params.has('complete'),
        project_card_label:[],project_card_assignee:[],cover_image:null};
      const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
      client.setQueryData(['project-board','board'],{cards:[card],labels:[]});
      window.fixtureClient=client;
      function App(){
        const [open,setOpen]=React.useState(!params.has('board'));
        const completion=useProjectCardCompletion();
        const board=useQuery({queryKey:['project-board','board'],queryFn:()=>fetch('/api/projects/boards/board').then(r=>r.json())});
        return <><div data-testid="board-cover">{board.data.cards[0].cover_image||'No cover'}</div>
          <DragDropContext onDragStart={()=>window.fixtureDrags=(window.fixtureDrags||0)+1} onDragEnd={()=>{}}>
          <Droppable droppableId="list">{drop=><div ref={drop.innerRef} {...drop.droppableProps}>
          <Draggable draggableId="card" index={0} isDragDisabled={!canEdit}>{drag=>
          <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps} data-testid="summary-card" onClick={()=>setOpen(true)}>
            <Summary card={board.data.cards[0]} completionPending={completion.pendingIds.has('card')}
              onToggleComplete={canEdit?()=>completion.toggle(board.data.cards[0],true):undefined}/>
          </div>}</Draggable>{drop.placeholder}</div>}</Droppable></DragDropContext>
          <Modal card={board.data.cards[0]} open={open} onOpenChange={setOpen} boardId="board"
            labels={board.data.labels} lists={[{id:'list',name:'To do'}]}
            members={[{identity_id:'person',first_name:'Alex',last_name:'Example'}]}
            canEdit={canEdit} canManage={canEdit} canAssign={canEdit} canManageLabels={canEdit}
            onUpdate={async patch=>{if(window.failDescriptionSave) throw new Error('Description save failed');
              window.savedPatch=patch;await publishProjectCardUpdate(client,'card',patch);}}
            onDelete={()=>{}} /></>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/><Toaster/></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' }, logLevel: 'silent',
  });
  // Compile the current component classes, rather than relying on an old dist
  // build that can silently omit new completion/cover styling.
  const config=loadConfig(`${process.cwd()}/tailwind.config.ts`);
  const css=(await postcss([tailwindcss({...config,content:[
    './client/src/components/sales/ProjectCardDetailModal.jsx',
    './client/src/components/projects/ProjectCardTileSummary.jsx',
    './client/src/components/projects/CardAttachments.jsx',
    './client/src/components/projects/ActivityComposer.jsx',
    './client/src/components/projects/ProjectDescription.jsx',
    './client/src/components/ui/**/*.{jsx,tsx}',
  ]})]).process(await readFile('client/src/index.css','utf8'),{from:'client/src/index.css'})).css
    + (output.outputFiles.find(file => file.path.endsWith('.css'))?.text || '');
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(output.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url === '/saved-screenshot.png') { res.setHeader('Content-Type', 'image/png'); return res.end(screenshotBytes); }
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/projects/cards/card') return res.end(JSON.stringify({
        card: { id: 'card',board_id:'board',list_id:'list',cover_image:null },
        attachments:[],comments:[{id:'comment',identity_id:'person',content:'The draft agenda is ready for review.',created_at:'2026-10-09T10:00:00Z',
          images: req.headers.referer?.includes('image-demo') ? [{ attachment: {
            id: 'fixture-image', name: 'Screenshot.png', file_type: 'image/png', url: '/saved-screenshot.png',
          } }] : [],
        }],activity:[],
      }));
      res.statusCode = 500; return res.end('{"error":"Unexpected fixture request"}');
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(process.argv.includes('--serve') ? 5187 : 0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
  const pixels = await browser.newPage();
  screenshotBytes = Buffer.from(await pixels.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 100;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e2e8f0'; context.fillRect(0, 0, 240, 100);
    context.fillStyle = '#0f172a'; context.font = '18px sans-serif'; context.fillText('Activity screenshot', 20, 55);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await pixels.close();
}
if (process.argv.includes('--serve')) {
  await setup(); console.log(`Fixture ready on ${origin}`); await new Promise(()=>{});
}
before(setup);
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function open(width, search='') {
  const page = await browser.newPage({viewport:{width,height:850}});
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin+search);
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

async function pasteImage(page, { type = 'image/png', native = false, field = 'input-new-comment' } = {}) {
  if (native) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }, [...screenshotBytes]);
    await page.getByTestId(field).focus();
    await page.keyboard.press('Control+V');
  } else {
    await page.getByTestId(field).evaluate((el, type) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['fixture'], 'screenshot.png', { type }));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, type);
  }
}

test('description screenshot paste saves references, retries without duplicate uploads, reloads and respects viewers', async () => {
  const page = await open(1280);
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const attachment = { id: '11111111-2222-4333-8444-555555555555', name: 'screenshot.png',
    file_type: 'image/png', url: origin + '/saved-screenshot.png' };
  let preparations = 0, confirmations = 0;
  try {
    await page.route('**/api/projects/boards/board', route => route.abort());
    await page.route('**/api/projects/cards/card', route => route.abort());
    await page.route('**/api/projects/cards/card/attachments', route => {
      preparations++;
      return json(route, { signedUrl: origin + '/storage', uploadToken: 'fixture' });
    });
    await page.route('**/storage', route => route.fulfill({ status: 200, body: '' }));
    await page.route('**/api/projects/cards/card/attachments/confirm', route => {
      confirmations++; return json(route, { attachment });
    });
    // Ordinary clipboard text remains native, alongside screenshot support.
    await page.getByTestId('input-card-description').fill('');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('Pasted description'));
    await page.getByTestId('input-card-description').focus(); await page.keyboard.press('Control+V');
    await page.waitForFunction(() => document.querySelector('#card-description').value === 'Pasted description');
    await pasteImage(page, { field: 'input-card-description', native: true });
    await page.getByAltText(/Description preview/).waitFor();
    assert.equal(preparations, 0);
    assert.equal(await page.getByAltText(/Description preview/).count(), 1);
    await page.evaluate(() => { window.failDescriptionSave = true; });
    await page.getByTestId('button-save-card').click();
    await page.getByText('Description save failed', { exact: true }).waitFor();
    assert.equal(await page.getByAltText(/Description preview/).count(), 1);
    await page.evaluate(() => { window.failDescriptionSave = false; });
    await page.getByTestId('button-save-card').click();
    await page.waitForFunction(() => window.savedPatch?.description?.includes('[project-image:'));
    const description = await page.evaluate(() => window.savedPatch.description);
    assert.equal(description, `Pasted description\n[project-image:${attachment.id}]`);
    assert.equal(preparations, 1); assert.equal(confirmations, 1);
    await page.route('**/api/projects/cards/card', route => json(route, {
      card: { id: 'card', board_id: 'board', list_id: 'list', description },
      attachments: [attachment], comments: [], activity: [],
    }));
    await page.reload();
    await page.getByTestId('card-description-section').getByAltText('screenshot.png', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('input-card-description').inputValue(), 'Pasted description');
    await page.getByRole('button', { name: 'Remove description image screenshot.png', exact: true }).click();
    await page.getByTestId('button-save-card').click();
    await page.waitForFunction(() => window.savedPatch?.description === 'Pasted description');
    await page.goto(origin + '/?readonly');
    await page.getByTestId('card-description-section').getByAltText('screenshot.png', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('input-card-description').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Remove description image/ }).count(), 0);
    assert.equal(await page.getByTestId('button-save-card').count(), 0);
  } finally { await page.close(); }
});

test('description rejects unsupported images, allows removal and preserves draft after upload failure', async () => {
  const page = await open(390);
  try {
    await pasteImage(page, { field: 'input-card-description', type: 'image/svg+xml' });
    await page.getByRole('alert').filter({ hasText: 'Choose PNG' }).waitFor();
    assert.equal(await page.getByAltText(/Description preview/).count(), 0);
    await pasteImage(page, { field: 'input-card-description' });
    await page.getByRole('button', { name: 'Remove pasted description image screenshot.png', exact: true }).click();
    assert.equal(await page.getByAltText(/Description preview/).count(), 0);
    await pasteImage(page, { field: 'input-card-description' });
    await page.route('**/api/projects/cards/card/attachments', route => route.fulfill({
      status: 403, contentType: 'application/json', body: '{"error":"Storage quota exceeded"}',
    }));
    await page.getByTestId('button-save-card').click();
    await page.getByRole('alert').filter({ hasText: 'Storage quota exceeded' }).waitFor();
    assert.equal(await page.getByAltText(/Description preview/).count(), 1);
    assert.equal(await page.evaluate(() => window.savedPatch), undefined);
    assert.equal(await page.getByTestId('input-card-description').inputValue(), 'Confirm the programme and prepare the speaker briefing.');
  } finally { await page.close(); }
});

test('native screenshot paste, failed submit retry, immediate image publication and reload persistence', async () => {
  const page = await open(1280);
  try {
    const attachment = { id: '50000000-0000-0000-0000-000000000001', name: 'screenshot.png',
      file_type: 'image/png', url: origin + '/saved-screenshot.png', file_size: screenshotBytes.length };
    let saved = null, posts = [], confirmations = 0, preparations = 0;
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/saved-screenshot.png', route => route.fulfill({ contentType: 'image/png', body: screenshotBytes }));
    await page.route('**/api/projects/cards/card/attachments', route => {
      preparations++; assert.equal(route.request().postDataJSON().purpose, 'activity');
      return json(route, { signedUrl: origin + '/storage', uploadToken: 'signed-fixture' });
    });
    await page.route('**/storage', route => route.fulfill({ status: 200, body: '' }));
    await page.route('**/api/projects/cards/card/attachments/confirm', route => {
      confirmations++; return json(route, { attachment });
    });
    await page.route('**/api/projects/cards/card/comments', route => {
      const body = route.request().postDataJSON(); posts.push(body);
      if (posts.length === 1) return json(route, { error: 'Comment service temporarily unavailable' }, 503);
      saved = { id: 'image-comment', content: body.content, identity_id: 'person',
        created_at: new Date().toISOString(), images: [{ attachment }] };
      return json(route, { comment: saved });
    });
    // Publication must not depend on a successful detail refresh.
    await page.route('**/api/projects/cards/card', route => route.abort());
    await page.route('**/api/projects/boards/board', route => route.abort());
    await pasteImage(page, { native: true });
    await page.getByAltText(/Preview /).waitFor();
    assert.equal(preparations, 0, 'pasting does not upload discarded images');
    assert.equal(await page.getByAltText(/Preview /).count(), 1, 'items/files are not ingested twice');
    await page.getByTestId('button-add-comment').click();
    await page.getByRole('alert').filter({ hasText: 'Comment service temporarily unavailable' }).waitFor();
    assert.equal(await page.getByAltText(/Preview /).count(), 1);
    await page.getByTestId('button-add-comment').click();
    await page.getByRole('complementary').getByAltText('screenshot.png', { exact: true }).waitFor();
    assert.equal(preparations, 1);
    assert.equal(confirmations, 1);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].content, '');
    assert.equal(posts[1].requestId, posts[0].requestId);
    assert.deepEqual(posts[1].attachmentIds, [attachment.id]);
    assert.equal(await page.getByAltText(/Preview /).count(), 0);
    await page.unroute('**/api/projects/cards/card');
    await page.route('**/api/projects/cards/card', route => json(route, {
      card: { id: 'card', board_id: 'board', list_id: 'list' }, comments: [saved], attachments: [attachment], activity: [],
    }));
    await page.reload();
    await page.getByRole('complementary').getByAltText('screenshot.png', { exact: true }).waitFor();
    assert.equal(await page.getByRole('complementary').getByAltText('screenshot.png', { exact: true }).count(), 1);
    await page.waitForFunction(() => [...document.querySelectorAll('aside img')].some(image => image.naturalWidth === 240));
  } finally { await page.close(); }
});

test('plain text paste and mentions survive; unsupported images and upload failures retain recoverable drafts', async () => {
  const page = await open(1280);
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('Pasted notes'));
    await page.getByTestId('input-new-comment').focus();
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() => document.querySelector('[data-testid="input-new-comment"]').value === 'Pasted notes');
    await pasteImage(page, { type: 'image/svg+xml' });
    await page.getByRole('alert').filter({ hasText: 'Choose PNG' }).waitFor();
    assert.equal(await page.getByAltText(/Preview /).count(), 0);
    await pasteImage(page);
    await page.getByRole('button', { name: 'Remove image screenshot.png' }).click();
    assert.equal(await page.getByAltText(/Preview /).count(), 0);
    await page.getByTestId('input-new-comment').fill('Pasted notes @Al');
    await page.getByRole('option').filter({ hasText: 'Alex Example' }).click();
    await pasteImage(page);
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    let attempts = 0, puts = 0, payload;
    const attachment = { id: 'image', name: 'screenshot.png', file_type: 'image/png', url: origin + '/image.png' };
    await page.route('**/api/projects/cards/card/attachments', route => {
      attempts++;
      return attempts === 1 ? json(route, { error: 'Storage quota exceeded' }, 403)
        : json(route, { signedUrl: origin + '/storage', uploadToken: 'fixture' });
    });
    await page.route('**/storage', route => {
      puts++; return route.fulfill({ status: puts === 1 ? 503 : 200, body: '' });
    });
    await page.route('**/api/projects/cards/card/attachments/confirm', route => puts < 2
      ? json(route, { error: 'Upload not present' }, 400) : json(route, { attachment }));
    await page.route('**/api/projects/cards/card/comments', route => {
      payload = route.request().postDataJSON();
      return json(route, { comment: { id: 'new', content: payload.content, images: [{ attachment }] } });
    });
    await page.route('**/api/projects/cards/card', route => route.abort());
    await page.route('**/api/projects/boards/board', route => route.abort());
    await page.getByTestId('button-add-comment').click();
    await page.getByRole('alert').filter({ hasText: 'Storage quota exceeded' }).waitFor();
    assert.equal(await page.getByAltText(/Preview /).count(), 1);
    assert.match(await page.getByTestId('input-new-comment').inputValue(), /Pasted notes @Alex Example/);
    await page.getByTestId('button-add-comment').click();
    await page.getByRole('alert').filter({ hasText: 'Image upload failed' }).waitFor();
    assert.equal(await page.getByAltText(/Preview /).count(), 1);
    await page.getByTestId('button-add-comment').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="input-new-comment"]').value === '');
    assert.deepEqual(payload.mentionIdentityIds, ['person']);
    assert.deepEqual(payload.attachmentIds, ['image']);
    assert.equal(attempts, 2);
    assert.equal(puts, 2);
  } finally { await page.close(); }
});

test('read-only viewers have no Activity composer or paste upload target', async () => {
  const page = await open(1280, '?readonly');
  try {
    assert.equal(await page.getByTestId('input-new-comment').count(), 0);
    assert.equal(await page.getByTestId('button-add-comment').count(), 0);
    assert.equal(await page.getByTestId('input-file-upload').count(), 0);
  } finally { await page.close(); }
});
for (const width of [1280,390]) test(`upload and header cover appear before slow refetches with visible controls at ${width}px`, async () => {
  const page=await open(width);
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
    assert.equal(await page.getByAltText('Card cover',{exact:true}).count(),1);
    const header=page.getByTestId('card-cover-header');
    assert.equal(await header.getByAltText('Card cover').count(),1);
    assert.equal(await page.getByRole('region',{name:'Card details',exact:true}).getByAltText('Card cover').count(),0);
    assert.equal(await page.getByTestId('card-cover-section').count(),0);
    const imageFit=await header.getByAltText('Card cover').evaluate(el=>getComputedStyle(el).objectFit);
    assert.equal(imageFit,'contain');
    const change=page.getByTestId('button-change-cover');
    const remove=page.getByTestId('button-remove-cover');
    assert.ok(await change.isVisible());
    assert.ok(await remove.isVisible());
    assert.equal(await change.evaluate(el=>getComputedStyle(el.parentElement).opacity),'1');
    // The nested cover picker can still be exiting; measure this modal's close
    // button, not the transient picker's identically labelled control.
    const closeBox=await page.getByTestId('card-detail-modal').getByRole('button',{name:'Close',exact:true}).boundingBox();
    const changeBox=await change.boundingBox();
    assert.ok(changeBox.y>=closeBox.y+closeBox.height,`cover controls do not overlap modal close: ${JSON.stringify({changeBox,closeBox})}`);
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

for (const width of [1280,390]) test(`immediate detail and summary completion persists at ${width}px`,async()=>{
  const page=await open(width);
  try {
    let saved = false;
    const writes = [];
    await page.route('**/api/projects/cards/card', async route => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON(); writes.push(patch); saved = patch.is_complete;
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify({
        card:{id:'card',board_id:'board',is_complete:saved},comments:[],activity:[],attachments:[],
      })});
    });
    await page.route('**/api/projects/boards/board', route => route.abort());
    const toggle=page.getByTestId('button-toggle-card-complete');
    assert.equal(await toggle.getAttribute('aria-checked'),'false');
    assert.equal(await page.getByTestId('card-complete-pill').count(),0);
    await toggle.click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="button-toggle-card-complete"]').getAttribute('aria-checked')==='true');
    assert.equal(await toggle.locator('svg').count(),1);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-testid="button-toggle-card-complete"]')).backgroundColor==='rgb(90, 127, 35)');
    await page.getByTestId('card-complete-pill').waitFor();
    assert.equal(await page.evaluate(()=>window.savedPatch),undefined);
    assert.deepEqual(writes,[{is_complete:true}]);
    await toggle.click();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="card-complete-pill"]'));
    await toggle.focus();
    await page.keyboard.press('Space');
    await page.getByTestId('card-complete-pill').waitFor();
    await page.getByTestId('card-detail-modal').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByTestId('card-detail-modal').waitFor({state:'detached'});
    const summary = page.getByTestId('tile-complete-card');
    assert.equal(await summary.getAttribute('aria-checked'),'true');
    await summary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-testid="tile-complete-card"]').getAttribute('aria-checked')==='false');
    assert.equal(await page.getByTestId('card-detail-modal').count(),0);
    await summary.click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="tile-complete-card"]').getAttribute('aria-checked')==='true');
    assert.equal(await page.evaluate(()=>window.fixtureDrags||0),0);
    await page.getByTestId('summary-card').getByText('Plan the autumn webinar').click();
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('[data-testid="button-toggle-card-complete"]')?.getAttribute('aria-checked')==='true');
  } finally {await page.close();}
});

test('summary failure and pending actions retain confirmed state and recover without opening or dragging', async () => {
  const page=await open(390);
  try {
    await page.getByTestId('card-detail-modal').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByTestId('card-detail-modal').waitFor({state:'detached'});
    let writes=0, release, fail=true;
    await page.route('**/api/projects/cards/card',async route=>{
      if(route.request().method()!=='PATCH') return route.abort();
      writes++;
      await new Promise(resolve=>{release=resolve;});
      return route.fulfill({status:fail?403:200,contentType:'application/json',
        body:JSON.stringify(fail?{error:'Completion permission denied'}:{card:{id:'card',is_complete:true}})});
    });
    await page.route('**/api/projects/boards/board',route=>route.abort());
    const toggle=page.getByTestId('tile-complete-card');
    await toggle.evaluate(el=>{el.click();el.click();});
    await page.waitForFunction(()=>document.querySelector('[data-testid="tile-complete-card"]').disabled);
    assert.equal(writes,1);
    assert.equal(await toggle.getAttribute('aria-checked'),'false');
    release();
    await page.getByText('Completion permission denied',{exact:true}).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'),'false');
    fail=false;
    await toggle.click();
    while(writes<2) await new Promise(resolve=>setTimeout(resolve,10));
    release();
    await page.waitForFunction(()=>document.querySelector('[data-testid="tile-complete-card"]').getAttribute('aria-checked')==='true');
    assert.equal(await page.getByTestId('card-detail-modal').count(),0);
    assert.equal(await page.evaluate(()=>window.fixtureDrags||0),0);
    await page.goto(origin+'/?board&readonly');
    assert.equal(await page.getByTestId('tile-complete-card').count(),0);
  } finally {await page.close();}
});

test('read-only completed card has disabled completion and no cover actions',async()=>{
  const page=await open(390,'?readonly&complete');
  try {
    const toggle=page.getByRole('checkbox',{name:'Reopen card'});
    assert.ok(await toggle.isDisabled());
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    assert.equal(await toggle.locator('svg').count(),1);
    assert.equal(await page.getByTestId('card-complete-pill').textContent(),'Complete');
    assert.equal(await page.getByTestId('button-add-cover').count(),0);
    assert.equal(await page.getByTestId('button-change-cover').count(),0);
    assert.equal(await page.getByTestId('button-remove-cover').count(),0);
    await page.evaluate(()=>{
      window.fixtureClient.setQueryData(['card-detail','card'],old=>({
        ...old,card:{...old.card,cover_image:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="olive"/></svg>'},
      }));
    });
    await page.getByAltText('Card cover',{exact:true}).waitFor();
    assert.equal(await page.getByAltText('Card cover',{exact:true}).count(),1);
    assert.equal(await page.getByTestId('button-change-cover').count(),0);
    assert.equal(await page.getByTestId('button-remove-cover').count(),0);
  } finally {await page.close();}
});

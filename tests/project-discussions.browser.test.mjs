// Browser-only component fixture. Every API request is intercepted below; no
// application credentials, customer databases or notification providers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { normalizeDiscussionContent } from '../api/_lib/projectDiscussionContent.js';
let browser, server, origin;
const ids = {
  root: '00000000-0000-4000-8000-000000000001', reply: '00000000-0000-4000-8000-000000000002',
  nested: '00000000-0000-4000-8000-000000000003', actor: '00000000-0000-4000-8000-000000000004',
  newRoot: '00000000-0000-4000-8000-000000000005',
};
before(async () => {
  const output = await build({
    outfile: '/tmp/project-discussion-lifecycle.js',
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
      import Composer from './client/src/components/projects/ActivityComposer.jsx';
      import Threads from './client/src/components/projects/DiscussionThread.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
      window.fixtureClient=client;
      const members=[{identity_id:'${ids.actor}',first_name:'Alex',last_name:'Example'}];
      function App(){
        const drafts=React.useRef(new Map());
        const detail=useQuery({queryKey:['card-detail','card'],queryFn:()=>fetch('/api/projects/cards/card').then(r=>r.json())});
        const comments=detail.data?.comments||[];
        const canWrite=detail.data?.discussionCanWrite!==false;
        return <main style={{maxWidth:600,margin:'20px auto',padding:12}}>
          <h1>{new URLSearchParams(location.search).get('entry')||'Projects'} discussion</h1>
          <p data-testid="comment-count">{comments.length} comments</p>
          {canWrite&&<Composer cardId="card" boardId="board" members={members} drafts={drafts.current} refresh={()=>{}}/>}
          <Threads comments={comments} cardId="card" boardId="board" members={members} canWrite={canWrite} drafts={drafts.current} refresh={()=>{}}/>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'import.meta.env': '{}' }, logLevel: 'silent',
  });
  const js = output.outputFiles.find(f => f.path.endsWith('.js')).text;
  const css = output.outputFiles.find(f => f.path.endsWith('.css'))?.text || '';
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(js); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url.startsWith('/api/')) { res.statusCode = 500; return res.end('Unexpected unmocked request'); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/fixture.css"><style>
      :root{--background:0 0% 100%;--foreground:222 20% 15%;--muted:210 20% 96%;--muted-foreground:215 16% 45%;--border:214 25% 85%;--primary:213 75% 45%;--popover:0 0% 100%}
      body{font-family:Arial,sans-serif}button{cursor:pointer}article{margin-top:16px}input{max-width:90%}.relative{position:relative}
      </style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
const row = (id, content, parent = null, time = '2026-11-24T10:00:00Z') => ({
  id, content, parent_comment_id: parent, created_at: time, identity_id: ids.actor,
  author: { first_name: 'Alex', last_name: 'Example' }, can_edit: true, images: [], reactions: [],
});
async function fixture(entry = 'Projects', width = 900, initial) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = {
    comments: initial || [row(ids.root, 'Original root')],
    discussionVersion: 1, discussionCanWrite: true, calls: [], fail: null,
  };
  const snapshot = () => ({ comments: state.comments, discussionVersion: state.discussionVersion, discussionCanWrite: state.discussionCanWrite });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (!url.startsWith(origin)) return route.abort();
    if (!url.includes('/api/')) return route.continue();
    const method = request.method(), body = request.postDataJSON();
    if (url.endsWith('/api/projects/cards/card') && method === 'GET') return route.fulfill({ json: snapshot() });
    if (!url.endsWith('/comments')) return route.fulfill({ json: {} });
    state.calls.push({ method, body });
    if (state.fail === method) {
      state.fail = null;
      return route.fulfill({ status: 500, json: { error: 'Temporary discussion failure' } });
    }
    if (method === 'POST') {
      const normalized = normalizeDiscussionContent(body);
      const target = state.comments.find(c => c.id === body.replyToCommentId);
      const comment = { ...row(body.replyToCommentId ? state.comments.some(c => c.id === ids.reply) ? ids.nested : ids.reply : ids.newRoot,
        normalized.content, target ? target.parent_comment_id || target.id : null, '2026-11-24T11:00:00Z'),
        rich_content: normalized.richContent, reply_to_comment_id: target?.id || null,
        reply_to_name: target ? 'Alex Example' : null };
      state.comments.push(comment); state.discussionVersion++;
      return route.fulfill({ json: { ...snapshot(), comment } });
    }
    const comment = state.comments.find(c => c.id === body.commentId);
    if (method === 'PATCH') {
      const normalized = normalizeDiscussionContent(body);
      Object.assign(comment, { content: normalized.content, rich_content: normalized.richContent, edited_at: '2026-11-24T12:00:00Z' });
    } else if (method === 'PUT') {
      comment.reactions = body.emoji ? [{ emoji: body.emoji, count: 1, selected: true, reactors: [{ id: ids.actor, name: 'Alex Example' }] }] : [];
    } else if (method === 'DELETE') {
      const children = state.comments.filter(c => c.parent_comment_id === comment.id).sort((a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      if (children.length) {
        children[0].parent_comment_id = null; children[0].reply_to_comment_id = null; children[0].reply_to_name = null;
        for (const child of children.slice(1)) child.parent_comment_id = children[0].id;
      }
      state.comments = state.comments.filter(c => c.id !== comment.id);
    }
    state.discussionVersion++;
    return route.fulfill({ json: { ...snapshot(), comment: method === 'DELETE' ? null : comment, deletedId: method === 'DELETE' ? body.commentId : null } });
  });
  await page.goto(`${origin}/?entry=${entry}`);
  await page.getByText('Original root', { exact: true }).waitFor();
  return { page, state, errors };
}
async function submitComposer(composer, text) {
  await composer.getByTestId('input-new-comment').fill(text);
  await composer.getByTestId('button-add-comment').click();
}
for (const [entry, width] of [['Projects', 900], ['Sales', 390]]) test(`${entry} reply/edit/reaction/promotion lifecycle at ${width}px`, async () => {
  const { page, state, errors } = await fixture(entry, width);
  try {
    const root = page.locator(`[data-comment-id="${ids.root}"]`);
    await root.getByRole('button', { name: 'Reply', exact: true }).click();
    await submitComposer(page.locator('[data-discussion-mode="reply"]'), 'First reply');
    const reply = page.locator(`[data-comment-id="${ids.reply}"]`);
    await reply.getByText('First reply', { exact: true }).waitFor();
    assert.equal(state.calls.at(-1).body.replyToCommentId, ids.root);
    assert.equal(state.comments.length, 2);
    await reply.getByRole('button', { name: 'Reply', exact: true }).click();
    await submitComposer(page.locator('[data-discussion-mode="reply"]'), 'Reply to first reply');
    const nested = page.locator(`[data-comment-id="${ids.nested}"]`);
    await nested.getByText('Reply to first reply', { exact: true }).waitFor();
    assert.equal(state.calls.at(-1).body.replyToCommentId, ids.reply);
    assert.equal(state.comments.at(-1).parent_comment_id, ids.root);

    // Save failure keeps the editable draft; Cancel does not change saved text.
    await nested.getByRole('button', { name: 'Edit comment', exact: true }).click();
    const edit = page.locator('[data-discussion-mode="edit"]');
    await edit.getByTestId('input-new-comment').fill('Edited reply');
    state.fail = 'PATCH';
    await edit.getByTestId('button-save-comment-edit').click();
    await edit.getByRole('alert').waitFor();
    assert.equal(await edit.getByTestId('input-new-comment').innerText(), 'Edited reply');
    await edit.getByTestId('button-save-comment-edit').click();
    await nested.getByText('Edited reply', { exact: true }).waitFor();
    await nested.getByText('(edited)', { exact: true }).waitFor();
    assert.equal(state.comments.find(c => c.id === ids.nested).created_at, '2026-11-24T11:00:00Z');
    await nested.getByRole('button', { name: 'Edit comment', exact: true }).click();
    await edit.getByTestId('input-new-comment').fill('Cancelled change');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await nested.getByText('Edited reply', { exact: true }).waitFor();
    await nested.getByRole('button', { name: 'Edit comment', exact: true }).click();
    assert.equal(await edit.getByTestId('input-new-comment').innerText(), 'Edited reply');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();

    // A reaction is a separate PUT; replacing/removing it changes no row count.
    await nested.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await nested.getByRole('button', { name: 'React with 👍', exact: true }).click();
    await nested.getByRole('button', { name: /👍, 1 reaction/ }).waitFor();
    assert.equal(state.comments.length, 3);
    await nested.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await nested.getByRole('button', { name: 'React with ❤️', exact: true }).click();
    await nested.getByRole('button', { name: /❤️, 1 reaction/ }).waitFor();
    assert.equal(state.calls.at(-1).body.emoji, '❤️');
    // Badges reveal names even to touch/keyboard users; removing is explicit.
    await nested.getByRole('button', { name: /❤️, 1 reaction/ }).click();
    await nested.getByText('Alex Example', { exact: true }).last().waitFor();
    await nested.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await nested.getByRole('button', { name: 'React with ❤️', exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`[data-comment-id="${id}"] [aria-label*="❤️, 1 reaction"]`), ids.nested);
    assert.equal(state.calls.at(-1).body.emoji, null);

    let confirmation = '';
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
    // Scope to the root's own controls, not descendant reply actions.
    await root.getByRole('button', { name: 'Delete comment', exact: true }).first().click();
    await root.waitFor({ state: 'detached' });
    assert.match(confirmation, /promot/i);
    assert.equal(state.comments.length, 2);
    assert.equal(state.comments.find(c => c.id === ids.reply).parent_comment_id, null);
    assert.equal(state.comments.find(c => c.id === ids.nested).parent_comment_id, ids.reply);
    await page.reload();
    await page.getByText('Edited reply', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('comment-count').textContent(), '2 comments');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('posting retry preserves request identity, formatting and order; failed reaction and deletion stay recoverable', async () => {
  const { page, state, errors } = await fixture();
  try {
    const create = page.locator('[data-discussion-mode="create"]');
    await create.getByTestId('input-new-comment').fill('New decision 😊');
    await create.getByTestId('input-new-comment').press('Control+A');
    await create.getByTestId('input-new-comment').press('Control+B');
    state.fail = 'POST';
    await create.getByTestId('button-add-comment').click();
    await create.getByRole('alert').waitFor();
    const failed = state.calls.at(-1).body;
    assert.equal(await create.getByTestId('input-new-comment').innerText(), 'New decision 😊');
    assert.equal(state.comments.length, 1);
    await create.getByTestId('button-add-comment').click();
    const posted = page.locator(`[data-comment-id="${ids.newRoot}"]`);
    await posted.getByText('New decision 😊', { exact: true }).waitFor();
    assert.equal(state.calls.at(-1).body.requestId, failed.requestId);
    assert.equal(await posted.locator('strong').textContent(), 'New decision 😊');
    assert.deepEqual(state.comments.find(c => c.id === ids.newRoot).reactions, [], 'inline emoji is not a reaction');
    const rootIds = await page.getByLabel('Discussion threads').locator(':scope > article').evaluateAll(nodes => nodes.map(n => n.dataset.commentId));
    assert.deepEqual(rootIds, [ids.newRoot, ids.root]);
    await page.reload();
    await posted.locator('strong').waitFor();
    assert.equal(await posted.locator('strong').textContent(), 'New decision 😊');

    state.fail = 'PUT';
    await posted.getByRole('button', { name: 'Add reaction', exact: true }).click();
    await posted.getByRole('button', { name: 'React with 😂', exact: true }).click();
    await posted.getByRole('alert').waitFor();
    assert.deepEqual(state.comments.find(c => c.id === ids.newRoot).reactions, []);
    await posted.getByRole('button', { name: /Retry reaction/ }).click();
    await posted.getByRole('button', { name: /😂, 1 reaction/ }).waitFor();
    assert.equal(state.calls.at(-1).body.emoji, '😂');
    assert.equal(state.comments.length, 2);
    await page.reload();
    await posted.getByRole('button', { name: /😂, 1 reaction/ }).waitFor();

    state.fail = 'DELETE';
    page.once('dialog', dialog => dialog.accept());
    await posted.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await posted.getByRole('alert').waitFor();
    assert.equal(state.comments.length, 2);
    page.once('dialog', dialog => dialog.accept());
    await posted.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await posted.waitFor({ state: 'detached' });
    assert.equal(state.comments.length, 1);

    // A fresh viewer snapshot removes controls while preserving readable posts.
    state.discussionCanWrite = false;
    state.comments[0].can_edit = false;
    state.comments[0].reactions = [{ emoji: '👍', count: 1, selected: false, reactors: [{ id: ids.actor, name: 'Alex Example' }] }];
    await page.reload();
    await page.getByText('Original root', { exact: true }).waitFor();
    assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Reply', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add reaction', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit comment', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete comment', exact: true }).count(), 0);
    await page.getByRole('button', { name: /👍, 1 reaction/ }).click();
    assert.equal(state.calls.at(-1).method, 'DELETE', 'viewing reactor names does not mutate');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

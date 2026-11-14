// Isolated Chromium component/HTTP fixtures. Real evidence reader, controls
// and authority transports; NOT deployed/native E2E, login or provider proof.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const APP = '11111111-1111-4111-8111-111111111111';
const ROUND = '22222222-2222-4222-8222-222222222222';
const ASSIGNMENT = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const PRIOR = '88888888-8888-4888-8888-888888888888';
const ROUND2 = '99999999-9999-4999-8999-999999999999';
const TENANT = '77777777-7777-4777-8777-777777777777';
const FILE1 = '55555555-5555-4555-8555-555555555555';
const FILE2 = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'E'.repeat(43); // Explicit fake fixture credential.
const CHUNK = 1024 * 1024;
const bytes = Buffer.from(Uint8Array.from({ length: CHUNK + 43217 }, (_, index) => (index * 31 + 17) % 251));
const digest = createHash('sha256').update(bytes).digest('hex');
function pngChunk(type, body) {
  const data = Buffer.concat([Buffer.from(type), body]); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const image = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
  pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 24, 57, 62, 255]))), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
const projection = {
  applicationVersionId: VERSION,
  review: {
    fields: [
      { id: 'plain', label: 'Plain evidence', type: 'text', value: '<script>not executable</script>' },
      { id: 'signature', label: 'Submitted signature', type: 'signature', value: { image, signedAt: '2030-02-07T12:34:56Z' } },
      { id: 'address', label: 'Saved address', type: 'address_lookup', value: ['building name: Fixture House', 'line 1: 27 Fixture Street', 'line 2: Fixture Quarter', 'line 3: Fixture District', 'post town: Leeds'] },
      { id: 'group', label: 'Grouped evidence', type: 'grouped_question', value: ['Methods: Fixture methods', 'Impact: Fixture impact'] },
      { id: 'rows', label: 'Evidence rows', type: 'repeatable_rows', value: ['Row 1\nNote: first fixture row', 'Row 2\nNote: second fixture row'] },
      { id: 'list', label: 'Static list', type: 'list', value: ['Fixture list item', 'Another fixture item'] },
    ],
    attachments: [
      { id: FILE1, label: 'Evidence rows — Row 1 — Supporting file', name: '../private/row-one.bin' },
      { id: FILE2, label: 'Evidence rows — Row 2 — Supporting file', name: '..\\private\\row-two.bin' },
    ],
  },
};
const states = new Map();
let server, browser, origin, serial = 0;

before(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import './client/src/lib/externalAwardApplicantAccess.js';
      import React,{useEffect,useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {BrowserRouter} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {useExternalAwardApplicant} from './client/src/hooks/useExternalAwardApplicant.js';
      import ImmutableEvidence from './client/src/components/awards/ImmutableEvidence.jsx';
      import ApplicantEvidence from './client/src/components/awards/ApplicantEvidence.jsx';
      import JudgingApplication from './client/src/components/awards/JudgingApplication.jsx';
      import AdminModerationEvidence from './client/src/components/awards/AdminModerationEvidence.jsx';
      import AssessmentHistory from './client/src/components/awards/AssessmentHistory.jsx';
      import ModerationPanel from './client/src/components/awards/ModerationPanel.jsx';
      import {judgingRequest,judgingAttachmentRequest,judgingPanelAttachmentRequest} from './client/src/components/awards/judgingClient.js';
      import './client/src/components/awards/awards.css';
      const mode=new URLSearchParams(location.search).get('mode');
      window.fixtureAuthorityActive=true;
      const authority={ready:true,status:'ready',scopeKey:'explicit-fixture-'+mode,tenantSlug:'fixture',
        assertCurrent(){if(!window.fixtureAuthorityActive)throw Error('Fixture authority is no longer current')}};
      function External(){
        const access=useExternalAwardApplicant('${APP}');
        return access.status==='ready'?<ApplicantEvidence session={access} tenantSlug='fixture' applicationId='${APP}' version={1}/>
          :<p role='alert'>{access.error}</p>;
      }
      function OwnApplication(){
        const [application,setApplication]=useState(null);
        useEffect(()=>{const controller=new AbortController();
          judgingRequest('/api/judging/assessment?assignmentId=${ASSIGNMENT}',{authority,signal:controller.signal})
            .then(data=>setApplication(data.application));
          return()=>controller.abort();
        },[]);
        return application?<JudgingApplication application={{...application,reference:'FIXTURE-JUDGE-27'}}
          assignmentId='${ASSIGNMENT}' authority={authority}/>:<p role='status'>Loading fixture assignment projection</p>;
      }
      function Workspace(){
        const [generation,setGeneration]=useState(0);
        const [roundId,setRoundId]=useState('${ROUND}');
        const [roles,setRoles]=useState({canModerate:mode!=='admin-approve'&&mode!=='report-history',canApprove:mode==='admin-approve'});
        window.fixtureChangeRound=()=>setRoundId('${ROUND2}');
        window.fixtureRemoveAdminRole=()=>setRoles({canModerate:false,canApprove:false});
        const tenant={scopeKey:'fixture-admin-tenant',tenantId:'${TENANT}',assertCurrent:authority.assertCurrent};
        window.fixtureChangeScope=()=>{window.fixtureAuthorityActive=false;setGeneration(x=>x+1)};
        return <main className='awards-workspace max-w-3xl mx-auto p-4 space-y-5'>
          <p role='note'>ISOLATED COMPONENT FIXTURE — HTTP stubs; not deployed/native E2E/provider proof.</p>
          <label>Independent local draft<textarea aria-label='Independent local draft' defaultValue='Fixture draft unchanged'/></label>
          {mode==='admin-panel'?<ModerationPanel tenant={tenant} roundId={roundId} applicationId='${APP}' {...roles}/>
            :['admin-history','report-history'].includes(mode)?<AssessmentHistory tenant={tenant} roundId={roundId} applicationId='${APP}' enabled={!generation} {...roles}/>
            :mode.startsWith('admin')?<AdminModerationEvidence tenant={tenant} roundId={roundId} applicationId='${APP}' enabled={!generation} {...roles}/>
            :mode==='own-application'?<OwnApplication/>:mode==='external'?<External/>:mode==='member'?<ApplicantEvidence session={authority} tenantSlug='fixture' applicationId='${APP}' version={1} enabled={!generation}/>
            :<ImmutableEvidence scopeKey={authority.scopeKey+generation} enabled={!generation} assertCurrent={authority.assertCurrent}
              loadReview={async signal=>{
                if(mode==='panel')return judgingRequest('/api/judging/panel?scope=review&roundId=${ROUND}&applicationId=${APP}',{authority,signal});
                const data=await judgingRequest('/api/judging/assessment?assignmentId=${ASSIGNMENT}',{authority,signal});
                return {applicationVersionId:data.assignment.applicationVersionId,review:data.application};
              }}
              loadAttachment={(id,options)=>mode==='panel'
                ?judgingPanelAttachmentRequest('${ROUND}','${APP}',id,{...options,authority})
                :judgingAttachmentRequest('${ASSIGNMENT}',id,{...options,authority})}/>}
        </main>;
      }
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      createRoot(document.getElementById('root')).render(<BrowserRouter><QueryClientProvider client={client}><Workspace/></QueryClientProvider></BrowserRouter>);
    ` },
    outfile: 'fixture.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'tenant-location-helper-only', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)publicClient$/ }, () => ({ path: 'tenant-helper', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getTenantSlugFromLocation=()=>new URLSearchParams(location.search).get('tenant');`, loader: 'js' }));
      builder.onResolve({ filter: /(?:^|\/)base44Client$/ }, () => ({ path: 'fixture-admin-identity', namespace: 'fixture-admin' }));
      builder.onResolve({ filter: /(?:^|\/)queryClient$/ }, () => ({ path: 'fixture-admin-events', namespace: 'fixture-admin' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-admin' }, args => ({ contents: args.path==='fixture-admin-identity'
        ? `export const getActiveTenantId=()=>'${TENANT}';` : `export const emitTenantContextChanged=()=>window.dispatchEvent(new Event('tenant-context-changed'));`, loader: 'js' }));
    } }],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 12 * 1024 * 1024 }).toString()
    + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  server = createServer(async (req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(js); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    const url = new URL(req.url, 'http://fixture.invalid');
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
      if (!['/fixture-evidence', '/award-application'].includes(url.pathname)) {
        states.get(req.headers['x-awards-fixture'])?.unexpected.push(req.url);
        res.statusCode = 404; return res.end('No ordinary file/storage fallback exists in this fixture');
      }
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    }
    const state = states.get(req.headers['x-awards-fixture']);
    if (!state) { res.statusCode = 500; return res.end('Missing fixture scope'); }
    state.requests.push({ url: req.url, headers: req.headers, method: req.method });
    const json = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    const allowed = ['/api/judging/attachment', '/api/judging/assessment', '/api/judging/panel', '/api/awards/my-applications', '/api/awards/external-application', '/api/awards/assessment-history', '/api/awards/moderation'];
    if (!allowed.includes(url.pathname) || req.method !== 'GET') { state.unexpected.push(req.url); return json({ error: 'Unexpected fixture request' }, 500); }
    if (url.searchParams.has('attachmentId')) {
      const offset = Number(url.searchParams.get('offset'));
      state.offsets.push(offset);
      if (offset === CHUNK && state.holdSecond) await new Promise(resolve => { state.release = resolve; });
      if (res.destroyed) return;
      if (state.revoked) return json({ error: 'Fixture access revoked between chunks' }, state.mode === 'external' ? 410 : 403);
      const end = Math.min(offset + (state.fault === 'big-chunk' ? CHUNK + 1 : CHUNK), bytes.length);
      let body = Buffer.from(bytes.subarray(offset, end));
      if (state.fault === 'truncated' && offset) body = body.subarray(0, body.length - 17);
      if (state.fault === 'corrupt' && offset) body[0] ^= 0x80;
      const hash = state.fault === 'digest' && offset ? 'a'.repeat(64) : digest;
      const start = state.fault === 'range' && offset ? offset + 1 : offset;
      const total = state.fault === 'oversized' ? 25 * CHUNK + 1 : state.fault === 'total' && offset ? bytes.length + 1 : bytes.length;
      res.statusCode = state.fault === 'legacy' ? 200 : 206;
      res.setHeader('Content-Type', state.fault === 'mime' ? 'text/html' : 'application/octet-stream');
      res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
      res.setHeader('X-Awards-File-Sha256', hash);
      res.setHeader('Content-Length', body.length);
      return res.end(body);
    }
    if (state.revoked || state.failRead) return json({ error: 'Fixture evidence read revoked' }, 403);
    if (url.pathname === '/api/awards/moderation') return json({application:{id:APP,reference:'FIXTURE-ADMIN-27'},criteria:null,assessments:[],moderation:null,messages:[],history:[],independent:{complete:true},official:{complete:false},sourceIds:[],page:1,pageSize:25,total:0});
    if (url.pathname === '/api/awards/assessment-history' && !url.searchParams.has('scope')) return json({
      assessments:[{id:FILE1,judge:'Judge A1B2C3D4',revision:1,submittedAt:'2030-02-07T12:34:56Z',answers:{quality:{value:72}},score:{numerator:'72',denominator:'1'},applicationVersionId:PRIOR,criteriaVersionId:VERSION,definition:{criteria:[{id:'quality',title:'Original quality criterion',type:'numeric'}]},current:false,assignmentIncluded:true,assignmentState:'assigned',conflict:'none'}],
      total:1,page:1,pageSize:10});
    if (url.pathname === '/api/awards/assessment-history') {
      const version = url.searchParams.get('versionId');
      if (version && version !== PRIOR) return json({error:'Fixture unreferenced version refused'},403);
      if (state.badVersion) return json(projection);
      const data=JSON.parse(JSON.stringify(projection));
      data.applicationVersionId=version||VERSION;
      if(version)data.review.fields[0].value='Fixture prior evidence only';
      else if(url.searchParams.get('roundId')===ROUND2)data.review.fields[0].value='Fixture round two evidence';
      return json(data);
    }
    if (url.pathname === '/api/judging/assessment') return json({
      assignment: { id: ASSIGNMENT, applicationVersionId: VERSION }, application: projection.review,
    });
    return json(projection);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium']).toString().trim(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

async function fixture(mode = 'member', options = {}) {
  const key = String(++serial);
  const state = { mode, requests: [], offsets: [], unexpected: [], holdSecond: false, ...options };
  states.set(key, state);
  const context = await browser.newContext({ viewport: { width: options.width || 1280, height: 940 },
    acceptDownloads: true, extraHTTPHeaders: { 'X-Awards-Fixture': key } });
  const externalRequests = [], errors = [], downloads = [];
  await context.route('**/*', route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    externalRequests.push(route.request().url()); return route.abort('blockedbyclient');
  });
  await context.addCookies([{ name: 'fixture_member_cookie', value: 'not-external-authority', url: origin }]);
  await context.addInitScript(({ holdHash, chunkSize }) => {
    window.fixtureEvents = []; window.fixtureFetches = []; window.fixtureCanvasCalls = 0;
    // Observe large native allocations (including any accidental oversize). Views
    // remain genuine TypedArrays; hashing/streaming/Blob behaviour is not faked.
    window.fixtureAllocations = [];
    const NativeUint8Array = Uint8Array;
    window.Uint8Array = new Proxy(NativeUint8Array, { construct(target, args) {
      const view = Reflect.construct(target, args);
      if (args.length === 1 && typeof args[0] === 'number' && args[0] >= chunkSize) window.fixtureAllocations.push(view);
      return view;
    } });
    window.fixtureHoldHash = holdHash;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      window.fixtureFetches.push({ url: String(args[0]), hash: location.hash, credentials: args[1]?.credentials });
      return originalFetch(...args);
    };
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      window.fixtureEvents.push('hash:start');
      const pending = originalDigest(...args);
      // Hold only promise delivery; the native digest and its result are real.
      if (window.fixtureHoldHash) await new Promise(resolve => { window.fixtureReleaseHash = resolve; });
      const result = await pending;
      window.fixtureEvents.push('hash:complete');
      return result;
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.fixtureEvents.push({ create: url, size: blob.size }); return url; };
    URL.revokeObjectURL = url => { window.fixtureEvents.push({ revoke: url }); return revoke(url); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.fixtureEvents.push({ click: this.href, download: this.download }); return click.call(this);
    };
    HTMLCanvasElement.prototype.toDataURL = function () { window.fixtureCanvasCalls++; throw Error('Static evidence must not regenerate a signature'); };
  }, { holdHash: !!options.holdHash, chunkSize: CHUNK });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download));
  const path = mode === 'external' ? `/award-application?applicationId=${APP}&mode=external&tenant=fixture#token=${TOKEN}` : `/fixture-evidence?mode=${mode}&tenant=fixture`;
  await page.goto(origin + path);
  if (!options.manualOpen) {
    if (mode !== 'own-application') await page.getByRole('button', { name: 'View saved evidence and files' }).click();
    await expect(page.getByAltText('Submitted signature image')).toBeVisible();
  }
  return { page, state, downloads, errors, externalRequests, async close() {
    state.release?.(); await context.close(); states.delete(key);
  } };
}
const startDownload = f => f.page.getByRole('button', { name: 'Download row-two.bin', exact: true }).click();
async function assertClean(f) {
  assert.deepEqual(f.errors, []); assert.deepEqual(f.externalRequests, []); assert.deepEqual(f.state.unexpected, []);
  assert.equal(await f.page.getByRole('textbox', { name: 'Independent local draft' }).inputValue(), 'Fixture draft unchanged');
  assert.equal(await f.page.evaluate(() => window.fixtureCanvasCalls), 0);
  for (const request of f.state.requests) {
    const url = new URL(request.url, origin);
    const admin = f.state.mode.startsWith('admin') || f.state.mode === 'report-history';
    if (admin) {
      assert.equal(request.headers['x-tenant-id'], TENANT);
      assert.equal(request.headers.cookie, 'fixture_member_cookie=not-external-authority');
      assert.equal(request.headers['x-awards-applicant'], undefined); assert.equal(request.headers['x-judging-csrf'], undefined);
      assert.equal(request.headers['x-awards-certificate-token'], undefined);
      assert(url.pathname==='/api/awards/assessment-history'||url.pathname==='/api/awards/moderation');
      assert.equal(url.searchParams.get('applicationId'), APP);
      assert([ROUND, ROUND2].includes(url.searchParams.get('roundId')));
    } else assert.equal(url.searchParams.get('tenant'), 'fixture');
    assert(!request.url.includes(TOKEN));
    if (url.searchParams.has('attachmentId')) {
      assert.equal(url.searchParams.get('attachmentId'), FILE2);
      if (f.state.mode === 'panel') { assert.equal(url.searchParams.get('scope'), 'attachment'); assert.equal(url.searchParams.get('roundId'), ROUND); assert.equal(url.searchParams.get('applicationId'), APP); }
      if (['own', 'own-application'].includes(f.state.mode)) assert.equal(url.searchParams.get('assignmentId'), ASSIGNMENT);
      if (['member', 'external'].includes(f.state.mode)) { assert.equal(url.searchParams.get('review'), '1'); assert.equal(url.searchParams.get('applicationId'), APP); }
    }
    if (f.state.mode === 'external') {
      assert.equal(request.headers['x-awards-applicant'], TOKEN);
      assert.equal(request.headers['x-tenant-slug'], 'fixture');
      assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.referer, undefined);
    }
  }
}
async function assertDiscarded(f, expectedAllocations = 1) {
  assert.equal(f.downloads.length, 0);
  assert.equal(await f.page.evaluate(() => window.fixtureEvents.some(event => event.create || event.click)), false);
  await expect.poll(() => f.page.evaluate(() => window.fixtureAllocations.length)).toBe(expectedAllocations);
  await expect.poll(() => f.page.evaluate(() => window.fixtureAllocations.every(view => view.every(byte => byte === 0)))).toBe(true);
}

for (const mode of ['member', 'external', 'panel', 'own', 'own-application','admin','admin-approve']) test(`isolated ${mode} fixture: two exact chunks, final native SHA-256 precedes real browser download`, async () => {
  const f = await fixture(mode, { holdHash: true, width: mode === 'external' ? 390 : 1280 });
  try {
    const img = f.page.getByAltText('Submitted signature image');
    assert.equal(await img.getAttribute('src'), image);
    await expect(img).toHaveJSProperty('naturalWidth', 1);
    await expect(f.page.getByText('Evidence rows — Row 2 — Supporting file', { exact: true })).toBeVisible();
    await expect(f.page.getByText('post town: Leeds', { exact: true })).toBeVisible();
    await expect(f.page.getByText('<script>not executable</script>', { exact: true })).toBeVisible();
    assert.equal(f.downloads.length, 0); assert.deepEqual(f.state.offsets, []);
    await startDownload(f);
    await expect.poll(() => f.page.evaluate(() => window.fixtureEvents.includes('hash:start'))).toBe(true);
    assert.deepEqual(f.state.offsets, [0, CHUNK]); assert.equal(f.downloads.length, 0);
    assert.equal(await f.page.evaluate(() => window.fixtureEvents.some(event => event.create)), false);
    await f.page.evaluate(() => window.fixtureReleaseHash());
    await expect.poll(() => f.downloads.length).toBe(1);
    const download = f.downloads[0];
    assert.equal(download.suggestedFilename(), 'row-two.bin');
    const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const actual = Buffer.concat(chunks);
    assert.equal(actual.length, bytes.length); assert.equal(createHash('sha256').update(actual).digest('hex'), digest);
    const events = await f.page.evaluate(() => window.fixtureEvents);
    assert(events.indexOf('hash:complete') < events.findIndex(event => event.create));
    assert(events.findIndex(event => event.create) < events.findIndex(event => event.click));
    assert.equal(events.find(event => event.create).size, bytes.length);
    assert.equal(await f.page.evaluate(() => window.fixtureAllocations.length), 1);
    assert(await f.page.evaluate(() => window.fixtureAllocations[0].every(byte => byte === 0)));
    await expect.poll(() => f.page.evaluate(() => window.fixtureEvents.filter(event => event.revoke).length)).toBe(1);
    if (mode === 'external') {
      assert.equal(new URL(f.page.url()).hash, '');
      const reads = await f.page.evaluate(() => window.fixtureFetches);
      assert(reads.every(read => !read.hash && read.credentials === 'omit'));
      assert.equal(await f.page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), TOKEN), false);
    }
    assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated administrator moderation panel fixture: private evidence denial clears viewer, preserves actual proposal/discussion inputs', async () => {
  const f = await fixture('admin-panel');
  try {
    await f.page.getByLabel('Proposal justification (required)', { exact: true }).fill('Fixture local proposal remains');
    await f.page.getByLabel('Add a discussion message', { exact: true }).fill('Fixture local discussion remains');
    f.state.revoked = true;
    await f.page.getByRole('button', { name: 'Refresh saved evidence', exact: true }).click();
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    await expect(f.page.getByRole('alert')).toContainText('403');
    await expect(f.page.getByLabel('Proposal justification (required)', { exact: true })).toHaveValue('Fixture local proposal remains');
    await expect(f.page.getByLabel('Add a discussion message', { exact: true })).toHaveValue('Fixture local discussion remains');
    assert.equal(f.downloads.length, 0); await assertClean(f);
  } finally { await f.close(); }
});

test('isolated administrator fixture: denied initial private evidence is not replaced by ordinary/judging URLs', async () => {
  const f = await fixture('admin', { manualOpen: true, failRead: true });
  try {
    await f.page.getByRole('button', { name: 'View saved evidence and files' }).click();
    await expect(f.page.getByRole('alert')).toContainText('403');
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    assert.equal(f.state.requests.length, 1); assert.deepEqual(f.state.offsets, []);
    assert.equal(f.downloads.length, 0); await assertClean(f);
  } finally { await f.close(); }
});

for (const change of ['round', 'role']) test(`isolated administrator fixture: ${change} change cancels pending chunks and clears private evidence`, async () => {
  const f = await fixture('admin', { holdSecond: true });
  try {
    await startDownload(f); await expect.poll(() => f.state.offsets.length).toBe(2);
    await f.page.evaluate(which => which === 'round' ? window.fixtureChangeRound() : window.fixtureRemoveAdminRole(), change);
    f.state.release();
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    await assertDiscarded(f);
    if (change === 'round') {
      await f.page.getByRole('button', { name: 'View saved evidence and files' }).click();
      await expect(f.page.getByText('Fixture round two evidence', { exact: true })).toBeVisible();
      assert.equal(new URL(f.state.requests.at(-1).url, origin).searchParams.get('roundId'), ROUND2);
    } else {
      await expect(f.page.getByRole('button', { name: 'View saved evidence and files' })).toHaveCount(0);
    }
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated report-only history fixture: submitted revisions visible, private version viewing never offered/requested', async () => {
  const f = await fixture('report-history', { manualOpen: true });
  try {
    await f.page.locator('summary').filter({ hasText: 'Judge A1B2C3D4' }).click();
    await expect(f.page.getByRole('term').filter({ hasText: 'Original quality criterion' })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'View referenced evidence version' })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'View saved evidence and files' })).toHaveCount(0);
    assert(f.state.requests.length > 0);
    assert(f.state.requests.every(request => !new URL(request.url, origin).searchParams.has('scope')));
    await assertClean(f);
  } finally { await f.close(); }
});

for (const mismatch of [false, true]) test(`isolated administrator history fixture: ${mismatch ? 'wrong returned version is discarded without fallback' : 'only selected submitted source version is viewed/downloaded; round changes clear it'}`, async () => {
  const f = await fixture('admin-history', { manualOpen: true, badVersion: mismatch });
  try {
    await f.page.locator('summary').filter({ hasText: 'Judge A1B2C3D4' }).click();
    await f.page.getByRole('button', { name: 'View referenced evidence version' }).click();
    await f.page.getByRole('button', { name: 'View saved evidence and files' }).click();
    if (mismatch) {
      await expect(f.page.getByRole('alert')).toContainText('does not match the requested historical version');
      await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
      assert.deepEqual(f.state.offsets, []);
    } else {
      await expect(f.page.getByText('Fixture prior evidence only', { exact: true })).toBeVisible();
      await expect(f.page.getByText(/Historical submitted evidence version\./)).toBeVisible();
      await startDownload(f); await expect.poll(() => f.downloads.length).toBe(1);
      await f.page.evaluate(() => window.fixtureChangeRound());
      await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    }
    const privateReads = f.state.requests.filter(request => new URL(request.url, origin).searchParams.has('scope'));
    assert(privateReads.length > 0);
    for (const request of privateReads) {
      const url = new URL(request.url, origin);
      assert.equal(url.searchParams.get('versionId'), PRIOR); assert.equal(url.searchParams.get('roundId'), ROUND);
    }
    await assertClean(f);
  } finally { await f.close(); }
});

for (const fault of ['digest', 'range', 'total', 'truncated', 'corrupt', 'legacy', 'mime', 'oversized', 'big-chunk']) test(`isolated member fixture: ${fault} response discarded, no partial download or automatic fallback/retry`, async () => {
  const f = await fixture('member', { fault });
  try {
    await startDownload(f);
    await expect(f.page.getByRole('alert')).toContainText(/inconsistent|incomplete|integrity|unavailable/);
    const firstChunkRejected = ['legacy', 'mime', 'oversized', 'big-chunk'].includes(fault);
    assert.deepEqual(f.state.offsets, firstChunkRejected ? [0] : [0, CHUNK]);
    await assertDiscarded(f, firstChunkRejected ? 0 : 1);
    const events = await f.page.evaluate(() => window.fixtureEvents);
    assert.equal(events.some(event => event.create || event.click), false);
    assert.equal(events.includes('hash:start'), fault === 'corrupt');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.state.offsets.length, firstChunkRejected ? 1 : 2);
    await expect(f.page.getByAltText('Submitted signature image')).toBeVisible();
    await assertClean(f);
  } finally { await f.close(); }
});

for (const mode of ['member', 'external', 'panel', 'own', 'own-application','admin']) test(`isolated ${mode} fixture: revocation between chunks clears evidence, no partial download or fallback`, async () => {
  const f = await fixture(mode, { holdSecond: true });
  try {
    await startDownload(f);
    await expect.poll(() => f.state.offsets.length).toBe(2);
    f.state.revoked = true; f.state.release();
    await expect(f.page.getByRole('alert')).toBeVisible();
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    await expect(f.page.getByText('Evidence rows — Row 2 — Supporting file', { exact: true })).toHaveCount(0);
    await assertDiscarded(f);
    assert.equal(await f.page.evaluate(() => window.fixtureEvents.some(event => event.create || event.click)), false);
    assert.deepEqual(f.state.offsets, [0, CHUNK]);
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated phone panel fixture: explicit cancellation aborts a pending chunk, preserves local draft', async () => {
  const f = await fixture('panel', { holdSecond: true, width: 390 });
  try {
    await startDownload(f); await expect.poll(() => f.state.offsets.length).toBe(2);
    await f.page.getByRole('button', { name: 'Cancel download of row-two.bin', exact: true }).click();
    await expect(f.page.getByRole('status')).toContainText('Download cancelled');
    f.state.release();
    await expect(f.page.getByRole('button', { name: 'Download row-two.bin', exact: true })).toBeEnabled();
    await assertDiscarded(f);
    assert.equal(await f.page.evaluate(() => window.fixtureEvents.some(event => event.create || event.click || event === 'hash:start')), false);
    await expect(f.page.getByAltText('Submitted signature image')).toBeVisible();
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated panel fixture: current authority changes during pending chunk, download discarded and stale evidence hidden', async () => {
  const f = await fixture('panel', { holdSecond: true });
  try {
    await startDownload(f); await expect.poll(() => f.state.offsets.length).toBe(2);
    await f.page.evaluate(() => window.fixtureChangeScope()); f.state.release();
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    await expect(f.page.getByRole('alert')).toContainText('Current access must be verified');
    await assertDiscarded(f);
    assert.equal(await f.page.evaluate(() => window.fixtureEvents.some(event => event.create || event.click)), false);
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated member fixture: failed refresh clears previously loaded evidence, not independent local draft', async () => {
  const f = await fixture('member');
  try {
    f.state.failRead = true;
    await f.page.getByRole('button', { name: 'Refresh saved evidence', exact: true }).click();
    await expect(f.page.getByRole('alert')).toContainText('Fixture evidence read revoked');
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    assert.equal(f.downloads.length, 0); assert.deepEqual(f.state.offsets, []);
    await assertClean(f);
  } finally { await f.close(); }
});

test('isolated member fixture: live authority guard fails during a chunk before React scope changes, stale evidence is cleared', async () => {
  const f = await fixture('member', { holdSecond: true });
  try {
    await startDownload(f); await expect.poll(() => f.state.offsets.length).toBe(2);
    await f.page.evaluate(() => { window.fixtureAuthorityActive = false; });
    f.state.release();
    await expect(f.page.getByRole('alert')).toBeVisible();
    await expect(f.page.getByAltText('Submitted signature image')).toHaveCount(0);
    await assertDiscarded(f); await assertClean(f);
  } finally { await f.close(); }
});

test('isolated panel fixture: cancellation while final SHA-256 promise is pending cannot hand a file to the browser', async () => {
  const f = await fixture('panel', { holdHash: true });
  try {
    await startDownload(f);
    await expect.poll(() => f.page.evaluate(() => window.fixtureEvents.includes('hash:start'))).toBe(true);
    await f.page.getByRole('button', { name: 'Cancel download of row-two.bin', exact: true }).click();
    await f.page.evaluate(() => window.fixtureReleaseHash());
    await expect(f.page.getByRole('button', { name: 'Download row-two.bin', exact: true })).toBeEnabled();
    await assertDiscarded(f); await assertClean(f);
  } finally { await f.close(); }
});

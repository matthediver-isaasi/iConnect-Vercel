// ISOLATED BROWSER COMPONENT FIXTURES, not native/deployed E2E or provider proof.
// Real isolated amendment, FormRenderer, signature, upload and applicant UI;
// only layout/session identity and unused ordinary API clients are fixture seams.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const AWARD = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'F'.repeat(43);
const ORG1 = '61000000-0000-4000-8000-000000000001', ORG2 = '61000000-0000-4000-8000-000000000002';
const GROUP1 = '62000000-0000-4000-8000-000000000001', GROUP2 = '62000000-0000-4000-8000-000000000002';
const REL1 = '63000000-0000-4000-8000-000000000001', REL2 = '63000000-0000-4000-8000-000000000002';
const choiceFields = [
  { id: 'dirGroup', type: 'organisation_group_dropdown', label: 'Existing group', group_initial_selection: { mode: 'specific', group_id: GROUP2 }, not_listed_choice: { enabled: true, label: 'Other group' } },
  { id: 'dirRelated', type: 'relationship_dropdown', label: 'Existing related record', parent_field_id: 'entity',
    relationship_definition_id: '64000000-0000-4000-8000-000000000001', not_listed_choice: { enabled: true, label: 'Create another record' } },
  { id: 'unsafeAction', type: 'organisation_dropdown', label: 'Managed action field', create_entity: true },
  { id: 'legacyLabel', type: 'organisation_dropdown', label: 'Recorded linked label' },
  { id: 'savedOther', type: 'organisation_dropdown', label: 'Original Other answer', not_listed_choice: { enabled: true, label: 'Current Other label' } },
];
const choiceAnswers = { entity: ORG1, dirGroup: GROUP1, dirRelated: REL1, unsafeAction: ORG1,
  legacyLabel: { id: ORG1, label: 'Originally recorded Harbour Guild' }, savedOther: '__form_not_listed__',
  __not_listed_choice_labels: { savedOther: 'Historically recorded organisation option' },
  __not_listed_choice_text: { savedOther: 'Original community partner' } };
const signature = { type: 'signature', mode: 'typed', typedName: 'Original fixture signer',
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ZkAAAAASUVORK5CYII=',
  signed_at: '2027-01-09T12:00:00Z' };
const fields = [
  { id: 'group', type: 'grouped_question', label: 'Grouped evidence', required: true, min_completed: 1, max_completed: 2,
    sub_questions: [{ id: 'methods', label: 'Methods' }, { id: 'impact', label: 'Impact' }] },
  { id: 'rows', type: 'repeatable_rows', label: 'Evidence rows', repeatable_row: { version: 1, min_rows: 0, max_rows: 5,
    children: [{ id: 'note', type: 'text', label: 'Evidence note', required: true },
      { id: 'proof', type: 'file', label: 'Supporting file' }] } },
  { id: 'signature', type: 'signature', label: 'Local signature', required: true },
  { id: 'address', type: 'address_lookup', label: 'Address evidence' },
  { id: 'payment', type: 'membership_payment', label: 'Read-only payment' },
  { id: 'entity', type: 'organisation_dropdown', label: 'Read-only organisation' },
  { id: 'unsafe', type: 'repeatable_rows', label: 'Read-only managed container',
    repeatable_row: { children: [{ id: 'organisation', type: 'organisation_dropdown', label: 'Managed organisation' }] } },
];
const original = { group: { methods: 'Original methods', impact: 'Original impact' },
  rows: [{ _row_id: 'fixture-row-one', note: 'Original row', proof: null }],
  signature, address: null, payment: { retained: 'fixture payment evidence' }, entity: 'fixture-organisation',
  unsafe: [{ _row_id: 'managed-row', organisation: 'fixture-organisation' }] };
const clone = value => JSON.parse(JSON.stringify(value));
const states = new Map();
const networks = new WeakMap();
let browser, server, origin, serial = 0;

before(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import './client/src/lib/externalAwardApplicantAccess.js';
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BrowserRouter,useLocation} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import Amendment from './client/src/components/forms/AwardAmendmentFormView.jsx';
      import Landing from './client/src/pages/AwardApplication.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      window.fixtureQueryKeys=()=>client.getQueryCache().getAll().map(query=>query.queryKey);
      window.fixturePipelineCalls=[];
      function FixtureRoute(){
        const location=useLocation();
        return location.pathname==='/award-application'?<Landing/>:<Amendment applicationId='${ID}' slug='fixture-evidence' externalApplicant={new URLSearchParams(location.search).get('externalApplicant')==='1'}/>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><QueryClientProvider client={client}>
        <p role="note">ISOLATED COMPONENT FIXTURE — HTTP stubs; not native E2E/provider proof.</p>
        <FixtureRoute/>
      </QueryClientProvider></BrowserRouter>);
    ` },
    outfile: 'fixture.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
    plugins: [{
      name: 'explicit-amendment-fixture-seams',
      setup(builder) {
        builder.onResolve({ filter: /(?:useMemberChangeSession|LayoutContext|publicClient|base44Client|adminFetch)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'award-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'award-fixture' }, args => {
          const stubs = {
            useMemberChangeSession: `export const useMemberChangeSession=()=>({status:'ready',scopeKey:'fixture-member',assertCurrent(){}});`,
            LayoutContext: `export const usePageLayoutDecision=()=>{}; export const useLayout=()=>({});`,
            publicClient: `import {PublicClient} from '${process.cwd()}/client/src/api/publicClient.js';
              const actual=new PublicClient();actual.tenantSlug='fixture';
              export const getTenantSlugFromLocation=()=>new URLSearchParams(location.search).get('tenant');
              export const getPublicRequestHeaders=()=>({});
              export const publicClient=new Proxy(actual, {get(target,key){
                if(['listFormOrganizationOptions','listFormOrganisationGroupOptions','listFormRelationshipOptions','getTenantSlug'].includes(key))return target[key].bind(target);
                return ()=>{window.fixturePipelineCalls.push('publicClient.'+String(key));throw Error('Unexpected ordinary public API call')}
              }});`,
            adminFetch: `export const adminFetch=()=>{window.fixturePipelineCalls.push('adminFetch');throw Error('Unexpected admin transport')};`,
            base44Client: `const deny=path=>new Proxy(function(){},{get(_,key){return deny(path+'.'+String(key))},apply(){window.fixturePipelineCalls.push(path);throw Error('Unexpected ordinary entity/payment call: '+path)}});export const base44=deny('base44');`,
          };
          return { contents: stubs[args.path], loader: 'js', resolveDir: process.cwd() };
        });
      },
    }],
  });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text;
  const componentCss = output.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 12 * 1024 * 1024 }).toString() + componentCss;
  server = createServer(async (req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(js); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    const url = new URL(req.url, 'http://fixture.invalid');
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/fixture-upload/')) {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    }
    const state = states.get(req.headers['x-awards-fixture']);
    if (!state) { res.statusCode = 500; return res.end('Missing explicit fixture scope'); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw && req.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null;
    state.http.push({ path: req.url, method: req.method, headers: req.headers, raw, body });
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/awards/external-application' && !(url.searchParams.get('edit') === '1' || body?.command === 'amend')) {
      if (state.revoked) return json({ error: 'Fixture revoked applicant grant' }, 410);
      return json({ applications: [{ id: ID, awardId: AWARD, reference: 'FIXTURE-PRIVATE-27', version: 3,
        awardName: 'Fixture confidential award', submittedAt: '2027-01-09T12:00:00Z', status: 'Pending',
        canWithdraw: false, canAmend: state.choices === true, outcome: null, certificates: [] }], total: 1, page: 1, pageSize: 25 });
    }
    if (['/api/awards/my-applications', '/api/awards/external-application'].includes(url.pathname)) {
      if (req.method === 'GET' && url.searchParams.get('edit') === '1') {
        return json({ applicationId: ID, awardId: AWARD, tenantId: TENANT, reference: 'FIXTURE-27', version: state.editorVersion || 3,
          existingChoiceAccess: state.choiceAccess === true,
          displaySnapshot: state.displaySnapshot || {},
          formId: FORM, formSlug: 'fixture-evidence', answers: clone(state.editorAnswers || (state.choices ? { ...original, ...choiceAnswers, ...(state.multiple ? { dirRelated: [REL1] } : {}) } : original)), deadline: '2099-01-01T00:00:00Z',
          form: { id: FORM, tenant_id: TENANT, slug: 'fixture-evidence', name: 'Fixture evidence', title: 'Fixture evidence',
            description: 'Explicit isolated fixture', fields: state.choices ? [...fields, ...choiceFields.map(field => state.multiple && field.id === 'dirRelated' ? { ...field, selection_mode: 'multiple' } : field)] : fields, pages: [], visibility_rules: [], form_type: state.survey ? 'survey' : 'standard', survey_settings: {} } });
      }
      if (req.method === 'POST' && body?.command === 'amend') {
        state.posts.push({ body, raw });
        if (state.fail) return json({ error: 'Fixture ambiguous amendment response; retain exact request' }, 503);
        return json({ id: ID, applicationVersionId: '55555555-5555-4555-8555-555555555555',
          effects: 'review_evidence_only', judgeAdoption: 'unchanged' });
      }
    }
    if (url.pathname === '/api/public/organisations') {
      if (state.denyChoices) return json({ error: 'Fixture ordinary form access denied' }, 403);
      return json([{ id: ORG1, name: 'Harbour Guild' }, { id: ORG2, name: 'Mere Association' }]);
    }
    if (url.pathname === '/api/public/organisation-groups') {
      if (state.denyChoices) return json({ error: 'Fixture ordinary form access denied' }, 403);
      return json([{ id: GROUP1, name: 'Research Circle' }, { id: GROUP2, name: 'Regional Circle' }]);
    }
    if (url.pathname === '/api/public/form/fixture-evidence/relationship-options') {
      if (state.denyChoices) return json({ error: 'Fixture ordinary form access denied' }, 403);
      const data = url.searchParams.get('parentRecordId') === ORG2 ? [{ id: REL2, label: 'Existing panel two' }]
        : [{ id: REL1, label: 'Existing panel one' }, { id: REL2, label: 'Existing panel two' }];
      return json({ data, total: data.length });
    }
    if (url.pathname === '/api/public/address-lookup' && req.method === 'POST') return json({
      addresses: [{ line_1: '27 Fixture Street', post_town: 'Leeds', postcode: 'LS1 1AA', country: 'GB' }],
    });
    if (url.pathname === '/api/storage/signed-upload-url') {
      state.uploads.push(body);
      return json({ bucket: 'private-uploads', path: `${TENANT}/form-submissions/${body.entityId}/fixture-${state.uploads.length}.txt`,
        signedUrl: `${origin}/fixture-upload/${body.entityId}/${state.uploads.length}` });
    }
    if (url.pathname.startsWith('/fixture-upload/') && req.method === 'PUT') { res.statusCode = 200; return res.end(''); }
    state.unexpected.push(req.url); return json({ error: 'Unexpected ordinary pipeline endpoint in isolated fixture' }, 500);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function fixture(width = 1280, landing = false, options = {}) {
  const key = `amendment-${++serial}`, state = { http: [], posts: [], uploads: [], unexpected: [], fail: true, revoked: false, ...options };
  states.set(key, state);
  const context = await browser.newContext({ viewport: { width, height: 940 }, extraHTTPHeaders: { 'X-Awards-Fixture': key } });
  // Any regression which tries to load a provider is observed and fails the
  // network assertion below, but is never allowed to leave this fixture.
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [];
  networks.set(page, []);
  page.on('request', request => networks.get(page).push(request.url()));
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureFetches = [];
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      window.fixtureFetches.push({ url: String(input), hash: location.hash, credentials: options.credentials });
      return fetch(input, options);
    };
  });
  if (!options.noCookie) await context.addCookies([{ name: 'fixture_member_cookie', value: 'must-not-authorise-external', url: origin }]);
  if (options.external) {
    await page.goto(`${origin}/award-application?applicationId=${ID}&tenant=fixture#token=${TOKEN}`);
    await expect(page.getByText('FIXTURE-PRIVATE-27', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Amend evidence', exact: true }).click();
  } else await page.goto(landing ? `${origin}/award-application?applicationId=${ID}&tenant=fixture#token=${TOKEN}` : `${origin}/FormView?award_amendment=${ID}&tenant=fixture`);
  if (landing) await expect(page.getByText('FIXTURE-PRIVATE-27', { exact: true })).toBeVisible();
  else if (!options.loadError) await expect(page.locator('#group-methods')).toBeVisible();
  return { page, state, errors, async close() { await context.close(); states.delete(key); } };
}
async function review(page) {
  await page.locator('#award-amendment-reason').fill('Fixture evidence-only correction');
  await page.getByRole('button', { name: 'Review evidence-only amendment…', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
}
async function frozenFailure(page) {
  await page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Fixture ambiguous amendment response');
}
async function assertNoPipeline(page, state, errors) {
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.fixturePipelineCalls), []);
  assert.deepEqual(state.unexpected, []);
  assert.deepEqual(networks.get(page).filter(url => !url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(url)), [],
    'The isolated editor must not initiate unexpected third-party/provider requests');
  assert(state.http.every(request => ['/api/awards/my-applications', '/api/awards/external-application', '/api/storage/signed-upload-url', '/api/public/address-lookup', '/api/public/organisations', '/api/public/organisation-groups', '/api/public/form/fixture-evidence/relationship-options'].includes(new URL(request.path, origin).pathname) || request.path.startsWith('/fixture-upload/')));
  assert.equal(state.http.some(request => /payment|checkout|process-application|entities|copy-email|public\/forms/.test(request.path)), false);
}

for (const width of [1280, 390]) {
  test(`isolated component fixture: grouped/row edits, unchanged saved signature and exact frozen retry (${width}px)`, async () => {
    const f = await fixture(width), { page, state, errors } = f;
    try {
      await page.waitForTimeout(650); // Saved typed signature must NOT run its 300ms signing timer.
      await page.locator('#group-methods').fill('Edited fixture methods');
      await page.locator('#group-impact').fill('Edited fixture impact');
      const rows = page.getByTestId('repeatable-rows-rows');
      await rows.locator('input[type="text"]').first().fill('Edited fixture row');
      await rows.getByTestId('button-add-repeatable-row-rows').click();
      await rows.locator('input[type="text"]').nth(1).fill('Second fixture row retained');
      await rows.getByTestId('button-add-repeatable-row-rows').click();
      await rows.locator('input[type="text"]').nth(2).fill('Temporary row to remove');
      await rows.getByRole('button', { name: 'Remove row 3', exact: true }).click();
      await expect(rows.locator('input[type="text"]')).toHaveCount(2);
      assert.equal(await page.getByText('Read-only in evidence-only amendments (membership_payment). No widget action will run.', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Read-only in evidence-only amendments (organisation_dropdown). No widget action will run.', { exact: true }).count(), 1);
      await review(page); await frozenFailure(page);
      assert.equal(state.posts.length, 1);
      const first = clone(state.posts[0]);
      assert.deepEqual(first.body.answers.group, { methods: 'Edited fixture methods', impact: 'Edited fixture impact' });
      assert.equal(first.body.answers.rows[0].note, 'Edited fixture row');
      assert.equal(first.body.answers.rows[0]._row_id, 'fixture-row-one');
      assert.equal(first.body.answers.rows.length, 2);
      assert.equal(first.body.answers.rows[1].note, 'Second fixture row retained');
      assert.equal(typeof first.body.answers.rows[1]._row_id, 'string');
      assert.deepEqual(first.body.answers.signature, signature);
      assert.deepEqual(first.body.answers.unsafe, original.unsafe);
      assert.deepEqual(first.body.answers.payment, original.payment);
      await expect(page.locator('#group-methods')).toBeDisabled();
      state.fail = false;
      await page.getByRole('button', { name: 'Retry identical evidence amendment', exact: true }).click();
      await expect(page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
      assert.equal(state.posts.length, 2);
      assert.equal(state.posts[1].raw, first.raw);
      assert.equal(state.posts[1].body.requestId, first.body.requestId);
      assert.equal(state.posts[1].body.command, 'amend');
      await assertNoPipeline(page, state, errors);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    } finally { await f.close(); }
  });
}

test('isolated component fixture: grouped minimum and local signature preparation gate freezing', async () => {
  const f = await fixture(), { page, state, errors } = f;
  try {
    await page.locator('#group-methods').fill('');
    await page.locator('#group-impact').fill('');
    await page.locator('#award-amendment-reason').fill('Fixture validation and local signature');
    const reviewButton = page.getByRole('button', { name: 'Review evidence-only amendment…', exact: true });
    await expect(reviewButton).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'configured grouped-question minimum/maximum' })).toBeVisible();
    await page.locator('#group-methods').fill('Minimum met without changing the other child');
    await expect(reviewButton).toBeEnabled();
    await page.getByTestId('input-signature-typed-name-signature').fill('New fixture signer');
    await expect(page.getByRole('status').filter({ hasText: 'Finish drawing or preparing' })).toBeVisible();
    await expect(reviewButton).toBeDisabled();
    await expect(reviewButton).toBeEnabled();
    await review(page); state.fail = false;
    await page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    assert.equal(state.posts[0].body.answers.signature.typedName, 'New fixture signer');
    assert.match(state.posts[0].body.answers.signature.data, /^data:image\/png;base64,/);
    assert.notEqual(state.posts[0].body.answers.signature.signed_at, signature.signed_at);
    assert.equal(state.uploads.length, 0);
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

test('isolated component fixture: concurrent saved child changes cannot overwrite an edited frozen worksheet', async () => {
  const f = await fixture(), { page, state, errors } = f;
  try {
    await page.locator('#group-methods').fill('My retained child edit');
    await page.getByTestId('repeatable-rows-rows').locator('input[type="text"]').first().fill('My retained row edit');
    await review(page); await frozenFailure(page);
    const frozen = state.posts[0].raw;
    await page.getByRole('button', { name: 'Keep draft and go back', exact: true }).click();
    state.editorAnswers = clone(original); state.editorVersion = 4;
    state.editorAnswers.group.impact = 'Another saved revision changed this sibling';
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Edit as a new request (reload authority)…', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'changed concurrently' })).toBeVisible();
    await expect(page.locator('#group-methods')).toHaveValue('My retained child edit');
    await expect(page.locator('#group-impact')).toHaveValue('Original impact');
    await expect(page.getByTestId('repeatable-rows-rows').locator('input[type="text"]').first()).toHaveValue('My retained row edit');
    await expect(page.locator('#group-methods')).toBeDisabled();
    assert.equal(state.posts.length, 1); assert.equal(state.posts[0].raw, frozen);
    assert.equal(state.uploads.length, 0);
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

for (const width of [1280, 390]) test(`isolated component fixture: address control uses only explicit lookup-read HTTP (${width}px)`, async () => {
  const f = await fixture(width), { page, state, errors } = f;
  try {
    await page.getByTestId('input-address-lookup-postcode-address').fill('LS1 1AA');
    await page.getByTestId('address-lookup-results-address').getByRole('option').click();
    await expect(page.getByTestId('input-address-lookup-address-line_1')).toHaveValue('27 Fixture Street');
    await review(page); state.fail = false;
    await page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    const address = state.posts[0].body.answers.address;
    assert.equal(address.line_1, '27 Fixture Street'); assert.equal(address.postcode, 'LS1 1AA');
    const lookup = state.http.find(request => request.path === '/api/public/address-lookup');
    assert.equal(lookup.body.form_id, FORM); assert.equal(lookup.body.field_id, 'address');
    assert.equal(state.uploads.length, 0);
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

for (const width of [1280, 390]) test(`isolated component fixture: new upload intent preserves nested edits and requires a new owned file prefix (${width}px)`, async () => {
  const f = await fixture(width), { page, state, errors } = f;
  try {
    const rows = page.getByTestId('repeatable-rows-rows'), file = rows.locator('input[type="file"]');
    await page.locator('#group-methods').fill('Locally retained nested methods');
    await rows.locator('input[type="text"]').first().fill('Locally retained row');
    await file.setInputFiles({ name: 'first-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture first bytes') });
    await expect(rows.getByText('first-proof.txt', { exact: true })).toBeVisible();
    await review(page); await frozenFailure(page);
    const first = state.posts[0].body;
    await page.getByRole('button', { name: 'Keep draft and go back', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Edit as a new request (reload authority)…', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'prior replacement is not attached' })).toBeVisible();
    await expect(page.locator('#group-methods')).toHaveValue('Locally retained nested methods');
    await expect(rows.locator('input[type="text"]').first()).toHaveValue('Locally retained row');
    await rows.locator('input[type="text"]').first().fill('Edited again without reattaching');
    await expect(page.getByRole('button', { name: 'Review evidence-only amendment…', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'prior replacement is not attached' })).toBeVisible();
    await file.setInputFiles({ name: 'second-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture second bytes') });
    await expect(rows.getByText('second-proof.txt', { exact: true })).toBeVisible();
    assert.equal(await page.getByRole('alert').filter({ hasText: 'prior replacement is not attached' }).count(), 0);
    await review(page); state.fail = false;
    await page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    const second = state.posts.at(-1).body;
    assert.notEqual(second.requestId, first.requestId);
    assert.equal(second.answers.group.methods, 'Locally retained nested methods');
    assert.equal(second.answers.rows[0].note, 'Edited again without reattaching');
    // The actual canonical file control emits a JSON STRING, also in rows.
    const proof = JSON.parse(second.answers.rows[0].proof);
    assert(proof.storage_path.startsWith(`${TENANT}/form-submissions/${second.requestId}/`));
    assert(!JSON.stringify(second.answers).includes(first.requestId));
    assert.equal(state.uploads[0].entityId, first.requestId);
    assert.equal(state.uploads[1].entityId, second.requestId);
    for (const upload of state.uploads) { assert.equal(upload.type, 'form-submission'); assert.equal(upload.formId, FORM); assert.equal(upload.isPrivate, true); }
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

test('isolated external landing fixture: fragment cleared before reads, header-only grant, revocation clears status', async () => {
  const f = await fixture(390, true), { page, state, errors } = f;
  try {
    assert.equal(new URL(page.url()).hash, '');
    const request = state.http[0];
    assert.equal(request.headers['x-awards-applicant'], TOKEN);
    assert.equal(request.headers['x-tenant-slug'], 'fixture');
    assert.equal(request.headers.cookie, undefined);
    assert(!request.path.includes(TOKEN));
    assert((await page.evaluate(() => window.fixtureFetches)).every(item => !item.hash && item.credentials === 'omit' && !item.url.includes('token')));
    assert.equal(await page.evaluate(token => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(token), TOKEN), false);
    state.revoked = true;
    await page.getByRole('button', { name: 'Refresh current status', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /expired|revoked|unavailable/ }).first()).toBeVisible();
    assert.equal(await page.getByText('FIXTURE-PRIVATE-27', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Fixture confidential award', { exact: true }).count(), 0);
    assert.equal(state.http.some(item => item.path.includes('/my-applications')), false);
    for (const item of state.http) {
      assert.equal(item.headers['x-awards-applicant'], TOKEN);
      assert.equal(item.headers.cookie, undefined);
      assert.equal(item.headers.referer, undefined);
      assert(!item.path.includes(TOKEN)); assert(!item.raw.includes(TOKEN));
    }
    const readsBeforeReload = state.http.length;
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: /missing, expired, revoked/ })).toBeVisible();
    assert.equal(state.http.length, readsBeforeReload, 'A tokenless reload must not fall back to the existing member cookie');
    assert.equal(await page.getByText('FIXTURE-PRIVATE-27', { exact: true }).count(), 0);
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

test('isolated external landing fixture: application scope change clears status without reusing the grant', async () => {
  const f = await fixture(390, true), { page, state, errors } = f;
  try {
    const reads = state.http.length;
    await page.evaluate(() => {
      const next = '/award-application?applicationId=99999999-9999-4999-8999-999999999999&tenant=fixture';
      history.pushState({ ...history.state, idx: (history.state?.idx || 0) + 1 }, '', next);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await expect(page.getByRole('alert').filter({ hasText: /missing, expired, revoked/ })).toBeVisible();
    assert.equal(await page.getByText('FIXTURE-PRIVATE-27', { exact: true }).count(), 0);
    assert.equal(state.http.length, reads, 'An application-bound grant must not be sent for another UUID');
    await assertNoPipeline(page, state, errors);
  } finally { await f.close(); }
});

function choiceReads(state) { return state.http.filter(item => ['/api/public/organisations', '/api/public/organisation-groups', '/api/public/form/fixture-evidence/relationship-options'].includes(new URL(item.path, origin).pathname)); }
async function choose(page, trigger, option) {
  await page.getByTestId(trigger).click();
  await page.getByTestId(option).click();
}
async function assertOrdinaryChoiceTransport(f) {
  const reads = choiceReads(f.state);
  for (const read of reads) {
    assert.equal(read.headers['x-awards-applicant'], undefined);
    assert.equal(read.headers['x-judging-csrf'], undefined);
    assert.equal(read.headers['x-awards-request'], undefined);
    assert.match(read.headers.cookie || '', /fixture_member_cookie=/);
    assert(!read.path.includes(TOKEN)); assert(!read.raw.includes(TOKEN));
    assert(!read.raw.includes(ID), 'Choice discovery must not use application ID as access authority');
    if (read.body) {
      assert.equal(read.body.formId, FORM); assert.equal(read.body.containerFieldId, null);
      assert.notEqual(read.body.fieldId, 'unsafeAction'); assert.notEqual(read.body.fieldId, 'legacyLabel'); assert.notEqual(read.body.fieldId, 'savedOther');
    }
  }
  const keys = await f.page.evaluate(() => window.fixtureQueryKeys());
  assert(!JSON.stringify(keys).includes(TOKEN));
  await expect(f.page.getByTestId('select-organisation-unsafeAction')).toHaveCount(0);
  await expect(f.page.getByTestId('select-organisation-group-unsafe')).toHaveCount(0);
  await expect(f.page.getByText('Originally recorded Harbour Guild', { exact: true }).first()).toBeVisible();
  await expect(f.page.getByText('Historically recorded organisation option', { exact: true }).first()).toBeVisible();
  await expect(f.page.getByText('Original community partner', { exact: true }).first()).toBeVisible();
  assert.equal(f.state.uploads.length, 0);
  await assertNoPipeline(f.page, f.state, f.errors);
}

for (const external of [false, true]) for (const width of [1280, 390]) test(`isolated ${external ? 'external' : 'member'} directory amendment fixture: existing ordinary choices only (${width}px)`, async () => {
  const f = await fixture(width, false, { choices: true, choiceAccess: true, external });
  const { page, state } = f;
  try {
    await expect(page.getByTestId('select-organisation-entity')).toContainText('Harbour Guild');
    await expect(page.getByTestId('select-organisation-group-dirGroup')).toContainText('Research Circle');
    await expect(page.getByTestId('select-relationship-dirRelated')).toContainText('Existing panel one');
    await choose(page, 'select-organisation-group-dirGroup', `option-organisation-group-${GROUP2}`);
    await choose(page, 'select-organisation-entity', `option-organisation-${ORG2}`);
    await expect(page.getByTestId('select-relationship-dirRelated')).toBeEnabled();
    await choose(page, 'select-relationship-dirRelated', `option-relationship-dirRelated-${REL2}`);
    await page.getByTestId('select-relationship-dirRelated').click();
    await expect(page.getByRole('option', { name: /Create another record|Other/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('#group-methods').fill('Other evidence kept with linked amendment');
    await review(page); state.fail = false;
    await page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    const saved = state.posts[0].body.answers;
    assert.equal(saved.entity, ORG2); assert.equal(saved.dirGroup, GROUP2); assert.equal(saved.dirRelated, REL2);
    assert.deepEqual(saved.legacyLabel, choiceAnswers.legacyLabel);
    assert.equal(saved.unsafeAction, ORG1); assert.deepEqual(saved.unsafe, original.unsafe);
    assert.equal(saved.payment.retained, 'fixture payment evidence');
    assert.deepEqual(saved.__not_listed_choice_text, choiceAnswers.__not_listed_choice_text);
    assert.deepEqual(saved.__not_listed_choice_labels, choiceAnswers.__not_listed_choice_labels);
    const reads = choiceReads(state);
    assert(reads.some(read => read.path.includes('organisations')));
    assert(reads.some(read => read.path.includes('organisation-groups')));
    assert(reads.some(read => new URL(read.path, origin).searchParams.get('parentRecordId') === ORG2));
    if (external) {
      const saves = state.http.filter(read => new URL(read.path, origin).pathname === '/api/awards/external-application');
      assert(saves.every(read => read.headers['x-awards-applicant'] === TOKEN && read.headers.cookie === undefined));
      assert(!state.http.some(read => read.path.includes('/my-applications')));
    }
    // The success screen intentionally no longer renders the original editor.
    for (const read of reads) {
      assert.equal(read.headers['x-awards-applicant'], undefined);
      assert.match(read.headers.cookie || '', /fixture_member_cookie=/);
      assert(!read.raw.includes(TOKEN)); assert(!read.path.includes(TOKEN));
    }
    assert(!JSON.stringify(await page.evaluate(() => window.fixtureQueryKeys())).includes(TOKEN));
    await assertNoPipeline(page, state, f.errors);
  } finally { await f.close(); }
});

for (const external of [false, true]) for (const deniedAtLookup of [false, true]) test(`isolated ${external ? 'external' : 'member'} directory amendment fixture: ${deniedAtLookup ? 'ordinary endpoint denies permission' : 'editor access flag false'} preserves saved linked evidence`, async () => {
  const f = await fixture(390, false, { choices: true, choiceAccess: deniedAtLookup, denyChoices: deniedAtLookup, external });
  try {
    if (deniedAtLookup) await expect(f.page.getByRole('status').filter({ hasText: 'Linked answers were restored' })).toBeVisible();
    await expect(f.page.getByTestId('select-organisation-entity')).toHaveCount(0);
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toHaveCount(0);
    if (!deniedAtLookup) assert.equal(choiceReads(f.state).length, 0);
    const count = choiceReads(f.state).length;
    await f.page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
    await f.page.waitForTimeout(160);
    assert.equal(choiceReads(f.state).length, count);
    await assertOrdinaryChoiceTransport(f);
    await f.page.locator('#group-methods').fill('A non-linked correction remains available');
    await review(f.page); f.state.fail = false;
    await f.page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(f.page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    assert.equal(f.state.posts[0].body.answers.entity, ORG1);
    assert.equal(f.state.posts[0].body.answers.dirRelated, REL1);
    assert.deepEqual(f.state.posts[0].body.answers.legacyLabel, choiceAnswers.legacyLabel);
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

for (const external of [false, true]) test(`isolated ${external ? 'external' : 'member'} directory amendment fixture: revocation on dependent lookup restores all saved links and retains unrelated draft`, async () => {
  const f = await fixture(1280, false, { choices: true, choiceAccess: true, external });
  try {
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toBeEnabled();
    await f.page.locator('#group-methods').fill('Unrelated draft survives permission revocation');
    await f.page.locator('#award-amendment-reason').fill('My reason survives permission revocation');
    await choose(f.page, 'select-organisation-group-dirGroup', `option-organisation-group-${GROUP2}`);
    f.state.denyChoices = true;
    await choose(f.page, 'select-organisation-entity', `option-organisation-${ORG2}`);
    await expect(f.page.getByRole('status').filter({ hasText: 'Linked answers were restored' })).toBeVisible();
    await expect(f.page.getByTestId('select-organisation-entity')).toHaveCount(0);
    await expect(f.page.locator('#group-methods')).toHaveValue('Unrelated draft survives permission revocation');
    await expect(f.page.locator('#award-amendment-reason')).toHaveValue('My reason survives permission revocation');
    const count = choiceReads(f.state).length;
    await f.page.evaluate(() => dispatchEvent(new Event('focus')));
    await f.page.waitForTimeout(160); assert.equal(choiceReads(f.state).length, count);
    await assertOrdinaryChoiceTransport(f);
    await review(f.page); f.state.fail = false;
    await f.page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(f.page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    const saved = f.state.posts[0].body.answers;
    assert.equal(saved.entity, ORG1); assert.equal(saved.dirGroup, GROUP1); assert.equal(saved.dirRelated, REL1);
    assert.equal(saved.group.methods, 'Unrelated draft survives permission revocation');
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

test('isolated directory amendment fixture: survey choices remain read-only despite editor flag', async () => {
  const f = await fixture(390, false, { choices: true, choiceAccess: true, survey: true });
  try {
    await expect(f.page.getByTestId('select-organisation-entity')).toHaveCount(0);
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toHaveCount(0);
    assert.equal(choiceReads(f.state).length, 0);
    await assertOrdinaryChoiceTransport(f);
  } finally { await f.close(); }
});

for (const denied of [false, true]) test(`isolated external directory amendment fixture: no ordinary cookie, ${denied ? 'denial never falls back to applicant grant' : 'public ordinary endpoint may authorise choices'}`, async () => {
  const f = await fixture(390, false, { choices: true, choiceAccess: true, external: true, noCookie: true, denyChoices: denied });
  try {
    if (denied) {
      await expect(f.page.getByRole('status').filter({ hasText: 'Linked answers were restored' })).toBeVisible();
      await expect(f.page.getByTestId('select-organisation-entity')).toHaveCount(0);
    } else {
      await expect(f.page.getByTestId('select-organisation-entity')).toContainText('Harbour Guild');
      await choose(f.page, 'select-organisation-entity', `option-organisation-${ORG2}`);
      await expect(f.page.getByTestId('select-organisation-entity')).toContainText('Mere Association');
    }
    const count = choiceReads(f.state).length;
    assert(count > 0);
    for (const read of choiceReads(f.state)) {
      assert.equal(read.headers.cookie, undefined);
      assert.equal(read.headers['x-awards-applicant'], undefined);
      assert(!read.raw.includes(TOKEN)); assert(!read.path.includes(TOKEN));
    }
    await f.page.evaluate(() => dispatchEvent(new Event('focus')));
    await f.page.waitForTimeout(160);
    if (denied) assert.equal(choiceReads(f.state).length, count);
    assert(!JSON.stringify(await f.page.evaluate(() => window.fixtureQueryKeys())).includes(TOKEN));
    await expect(f.page.getByText('Historically recorded organisation option', { exact: true }).first()).toBeVisible();
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

test('isolated directory amendment fixture: changed parent cannot freeze a retained child outside current canonical scope', async () => {
  const f = await fixture(1280, false, { choices: true, choiceAccess: true });
  try {
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toContainText('Existing panel one');
    await choose(f.page, 'select-organisation-entity', `option-organisation-${ORG2}`);
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toBeEnabled();
    await f.page.locator('#award-amendment-reason').fill('Changing parent requires a correctly scoped child');
    await f.page.getByRole('button', { name: 'Review evidence-only amendment…', exact: true }).click();
    await expect(f.page.getByRole('alert')).toContainText('does not match current canonical choices');
    await expect(f.page.getByRole('dialog')).toHaveCount(0);
    assert.equal(f.state.posts.length, 0);
    await choose(f.page, 'select-relationship-dirRelated', `option-relationship-dirRelated-${REL2}`);
    await review(f.page);
    await expect(f.page.getByRole('dialog')).toBeVisible();
    await assertOrdinaryChoiceTransport(f);
  } finally { await f.close(); }
});

test('isolated external phone directory amendment fixture: canonical multiple existing selections without Other or actions', async () => {
  const f = await fixture(390, false, { choices: true, choiceAccess: true, external: true, multiple: true });
  try {
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toContainText('Existing panel one');
    await choose(f.page, 'select-relationship-dirRelated', `option-relationship-dirRelated-${REL2}`);
    await expect(f.page.getByTestId('option-relationship-dirRelated-__form_not_listed__')).toHaveCount(0);
    await f.page.keyboard.press('Escape');
    await review(f.page); f.state.fail = false;
    await f.page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(f.page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    assert.deepEqual(f.state.posts[0].body.answers.dirRelated, [REL1, REL2]);
    for (const read of choiceReads(f.state)) {
      assert.equal(read.headers['x-awards-applicant'], undefined); assert(!read.raw.includes(TOKEN)); assert(!read.path.includes(TOKEN));
    }
    assert(!JSON.stringify(await f.page.evaluate(() => window.fixtureQueryKeys())).includes(TOKEN));
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

test('isolated directory amendment fixture: failed linked save freezes exact retry and never re-queries with application authority', async () => {
  const f = await fixture(1280, false, { choices: true, choiceAccess: true, external: true });
  try {
    await expect(f.page.getByTestId('select-relationship-dirRelated')).toBeEnabled();
    await choose(f.page, 'select-organisation-group-dirGroup', `option-organisation-group-${GROUP2}`);
    const reads = choiceReads(f.state).length;
    await review(f.page); await frozenFailure(f.page);
    const frozen = f.state.posts[0].raw;
    await f.page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
    await f.page.waitForTimeout(160);
    assert.equal(choiceReads(f.state).length, reads);
    f.state.fail = false;
    await f.page.getByRole('button', { name: 'Retry identical evidence amendment', exact: true }).click();
    await expect(f.page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    assert.equal(f.state.posts.length, 2); assert.equal(f.state.posts[1].raw, frozen);
    assert.equal(f.state.posts[1].body.answers.dirGroup, GROUP2);
    assert.equal(choiceReads(f.state).length, reads);
    for (const read of choiceReads(f.state)) assert.equal(read.headers['x-awards-applicant'], undefined);
    assert(!JSON.stringify(await f.page.evaluate(() => window.fixtureQueryKeys())).includes(TOKEN));
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

for (const external of [false, true]) test(`isolated ${external ? 'external phone' : 'member desktop'} amendment fixture: immutable root/row labels without lookup, answer IDs unchanged`, async () => {
  const answers = { ...clone(original), ...clone(choiceAnswers), unsafe: [
    { _row_id: 'recorded-second', organisation: ORG2 }, { _row_id: 'recorded-first', organisation: ORG1 },
  ] };
  const labels = { entity: 'Recorded Guild <script>not executable</script>', dirRelated: 'Related record at submission', dirGroup: 'Group at submission',
    unsafe: { [JSON.stringify(['recorded-first', 'organisation'])]: 'Recorded first row organisation',
      [JSON.stringify(['recorded-second', 'organisation'])]: 'Recorded second row organisation' } };
  const f = await fixture(external ? 390 : 1280, false, { external, choices: true, choiceAccess: false, editorAnswers: answers, displaySnapshot: labels });
  try {
    await expect(f.page.getByText(labels.entity, { exact: true }).first()).toBeVisible();
    await expect(f.page.getByText('Related record at submission', { exact: true }).first()).toBeVisible();
    const rows = f.page.locator('li').filter({ hasText: /Recorded (first|second) row organisation/ });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Recorded second row organisation');
    await expect(rows.nth(1)).toContainText('Recorded first row organisation');
    assert.equal(choiceReads(f.state).length, 0);
    await f.page.getByRole('textbox', { name: 'Methods', exact: true }).fill('Unrelated text correction keeps immutable IDs');
    await review(f.page);
    f.state.fail = false;
    await f.page.getByRole('button', { name: 'Confirm evidence-only amendment', exact: true }).click();
    await expect(f.page.getByText('Evidence amendment confirmed', { exact: true })).toBeVisible();
    const saved = f.state.posts[0].body.answers;
    assert.equal(saved.entity, ORG1); assert.equal(saved.dirRelated, REL1); assert.deepEqual(saved.unsafe, answers.unsafe);
    assert(!f.state.posts[0].raw.includes('Recorded Guild')); assert(!f.state.posts[0].raw.includes('Recorded first row organisation'));
    assert.equal(choiceReads(f.state).length, 0);
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

test('isolated amendment fixture: malformed immutable row-label map fails closed before any directory lookup', async () => {
  const f = await fixture(390, false, { choices: true, choiceAccess: false, loadError: true, displaySnapshot: { unsafe: { not_a_canonical_row_key: 'Invalid label' } } });
  try {
    await expect(f.page.getByRole('alert')).toContainText('Immutable row display label identity is invalid');
    await expect(f.page.getByRole('button', { name: 'Review evidence-only amendment…', exact: true })).toHaveCount(0);
    assert.equal(choiceReads(f.state).length, 0);
    await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

test('isolated amendment fixture: changed linked ID never borrows its original immutable label in frozen evidence', async () => {
  const f = await fixture(1280, false, { choices: true, choiceAccess: true, displaySnapshot: { entity: 'Original immutable Guild name' } });
  try {
    await expect(f.page.getByText('Original immutable Guild name', { exact: true })).toBeVisible();
    await choose(f.page, 'select-organisation-entity', `option-organisation-${ORG2}`);
    await choose(f.page, 'select-relationship-dirRelated', `option-relationship-dirRelated-${REL2}`);
    await review(f.page);
    const dialog = f.page.getByRole('dialog');
    await dialog.getByText('Review the frozen evidence answers', { exact: true }).click();
    await expect(dialog.getByText('Original immutable Guild name', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(ORG2, { exact: true }).first()).toBeVisible();
    assert.equal(f.state.posts.length, 0); await assertNoPipeline(f.page, f.state, f.errors);
  } finally { await f.close(); }
});

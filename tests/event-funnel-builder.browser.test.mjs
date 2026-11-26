// Real React Flow editor, isolated callbacks. No live app, tenant, database,
// payment or provider requests are permitted by this fixture.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

let server, browser, origin;
before(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import Builder from './client/src/components/events/EventFunnelBuilder.jsx';
      import {evaluateFunnelRoute} from './shared/eventFunnelGraph.mjs';
      const event = id => ({id,kind:'simple',tenantId:'tenant'});
      const graph={version:1,tenantId:'tenant',entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
        {id:'source',type:'source',event:event('admission'),ticketIds:['standard','premium'],requires:[],accept:'branch'},
        {id:'branch',type:'condition',rules:[
          {priority:20,match:'all',tests:[{event:event('admission'),ticketId:'standard',selected:true}],to:'parking'},
          {priority:10,match:'any',tests:[{event:event('admission'),ticketId:'premium',selected:true}],to:'dinner'}],fallback:'checkout'},
        {id:'parking',type:'addon',event:event('admission'),ticketIds:['parking'],requires:['source'],accept:'checkout',skip:'checkout'},
        {id:'dinner',type:'addon',event:event('admission'),ticketIds:['dinner'],requires:['source'],accept:'checkout',skip:'checkout'},
        {id:'checkout',type:'checkout'}]};
      const definition={id:'fixture',name:'Admission offers',revision:1,graph,layout:{positions:{
        source:{x:200,y:20},branch:{x:200,y:220},parking:{x:30,y:460},dinner:{x:400,y:460},checkout:{x:200,y:700}}}};
      const catalog=[{id:'admission',kind:'simple',title:'Annual conference',status:'active',tickets:[
        {id:'standard',name:'Standard admission'},{id:'premium',name:'Premium admission'},{id:'parking',name:'Parking'},{id:'dinner',name:'Dinner'}]}];
      window.previewCalls=[];window.saved=[];window.publishCalls=[];
      const membershipTiers=[{id:'00000000-0000-4000-8000-000000000011',name:'Individual',scope:'member',active:true},
        {id:'00000000-0000-4000-8000-000000000012',name:'Corporate',scope:'organization',active:true},
        {id:'00000000-0000-4000-8000-000000000013',name:'Retired tier',scope:'member',active:false}];
      createRoot(document.getElementById('root')).render(<Builder tenantId="tenant" catalog={catalog} membershipTiers={membershipTiers} definitions={[definition]} busy={false}
        onPreview={async input=>{window.previewCalls.push(input); if(window.failPreview)throw new Error('Preview unavailable');return evaluateFunnelRoute(input.graph,input);}}
        onSave={async input=>{window.saved.push(input);if(window.failSave)throw new Error('Concurrent edit: reload before saving');return {...input,revision:input.expectedRevision+1};}}
        onPublish={async input=>{window.publishCalls.push(input);throw new Error('Checkout activation is not ready');}} />);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outdir: '/tmp/funnel-fixture-build',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = output.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
    else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html><head><style>body{font-family:Arial;margin:20px;background:#f8fafc}button{cursor:pointer}*{box-sizing:border-box}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByTestId('funnel-definition-choice').selectOption('fixture');
  await page.getByTestId('funnel-node-source').waitFor();
  return { page, errors };
}
async function dragBy(page, locator, dx, dy) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}
test('connector bends, segments and labels save and reload without changing routing', async () => {
  const { page, errors } = await open();
  try {
    const label = page.getByRole('button', { name: 'Move label: Continue', exact: true });
    await label.click();
    await page.getByRole('button', { name: 'Add bend', exact: true }).click();
    assert.ok(await page.getByTestId('funnel-connector-bend').count() >= 4);
    const key = JSON.stringify(['source', 'accept', 'branch']);
    const path = () => page.evaluate(id => document.getElementById(id)?.getAttribute('d'), key);
    // All three edit controls support both pointer and keyboard input.
    await dragBy(page, label, 85, -45);
    const beforeSegment = await path();
    await dragBy(page, page.getByTestId('funnel-connector-segment').first(), 25, 25);
    assert.notEqual(await path(), beforeSegment);
    const beforeBend = await path();
    await dragBy(page, page.getByTestId('funnel-connector-bend').nth(1), 15, 20);
    assert.notEqual(await path(), beforeBend);
    await label.focus(); await page.keyboard.press('ArrowRight');
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const first = await page.evaluate(() => window.saved[0]);
    assert.ok(first.layout.connectors[key].bends.length >= 4);
    assert.ok(first.layout.connectors[key].labelOffset.x > 40);
    assert.equal(first.graph.nodes[0].accept, 'branch');
    assert.equal('connectors' in first.graph, false);
    const transform = await label.getAttribute('style');
    await page.getByTestId('funnel-definition-choice').selectOption('fixture');
    assert.equal(await label.getAttribute('style'), transform);
    // Adding a step or moving an existing one must not discard other layout.
    await label.click();
    await page.getByTestId('funnel-add-condition').click();
    await dragBy(page, page.getByTestId('funnel-node-source'), 20, 10);
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 2);
    const added = await page.evaluate(() => window.saved[1]);
    assert.deepEqual(added.layout.connectors[key], first.layout.connectors[key]);
    assert.equal(added.graph.nodes.length, first.graph.nodes.length + 1);
    await label.click();
    await page.getByRole('button', { name: 'Reset line', exact: true }).click();
    await page.getByRole('button', { name: 'Reset label', exact: true }).click();
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 3);
    const second = await page.evaluate(() => window.saved[2]);
    assert.deepEqual(second.layout.connectors[key], {});
    assert.deepEqual(second.graph, added.graph);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('editing lock blocks all authored changes but allows inspection, navigation and simulation', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('funnel-lock-editing').click();
    assert.equal(await page.getByTestId('funnel-lock-editing').getAttribute('aria-pressed'), 'true');
    for (const id of ['funnel-name', 'funnel-add-addon', 'funnel-auto-layout', 'funnel-save', 'funnel-publish', 'funnel-new']) {
      assert.equal(await page.getByTestId(id).isDisabled(), true, id);
    }
    await page.getByTestId('funnel-node-branch').click();
    assert.equal(await page.getByLabel('Condition name', { exact: true }).isDisabled(), true);
    await page.getByTestId('funnel-node-parking').click();
    assert.match(await page.locator('.efb-inspector').innerText(), /Step 3 · Annual conference — Parking/);
    assert.equal(await page.getByLabel('If accepted, continue to', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByTestId('funnel-delete-node').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Move label: Continue', exact: true }).isDisabled(), true);
    assert.equal(await page.getByTestId('funnel-connector-bend').count(), 0);
    const source = page.getByTestId('funnel-node-source');
    const originalPosition = await source.locator('..').getAttribute('style');
    await dragBy(page, source, 55, 35);
    assert.equal(await source.locator('..').getAttribute('style'), originalPosition);
    assert.equal(await page.locator('.react-flow__minimap-node').count(), 5);
    const viewport = page.locator('.react-flow__viewport');
    const beforeZoom = await viewport.getAttribute('style');
    await page.locator('.react-flow__controls-zoomin').click();
    await page.waitForFunction(previous => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== previous, beforeZoom);
    await page.getByTestId('funnel-quantity-source-standard').fill('1');
    await page.getByTestId('funnel-run-preview').click();
    await page.waitForFunction(() => window.previewCalls.length === 1);
    await page.getByTestId('funnel-lock-editing').click();
    await page.getByTestId('funnel-node-branch').click();
    assert.equal(await page.getByLabel('Condition name', { exact: true }).isDisabled(), false);
    await page.getByLabel('Condition name', { exact: true }).fill('Editable again');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('mini-map renders visible measured nodes and keeps them after edits', async () => {
  const { page, errors } = await open();
  try {
    const visibleMiniMapNodes = () => page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('.react-flow__minimap-node')];
      return nodes.length === 5 && nodes.every(node => {
        const box = node.getBoundingClientRect();
        const fill = getComputedStyle(node).fill;
        return box.width > 1 && box.height > 1 && fill !== 'none' && fill !== 'transparent';
      });
    }, null, { timeout: 5000 });
    await visibleMiniMapNodes();
    await page.getByTestId('funnel-node-branch').click();
    await page.getByLabel('Condition name', { exact: true }).fill('Renamed routing condition');
    await visibleMiniMapNodes();
    await page.getByTestId('funnel-auto-layout').click();
    await visibleMiniMapNodes();
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    assert.equal(await page.evaluate(() => window.saved[0].graph.nodes.some(node =>
      ['measured', 'width', 'height'].some(key => key in node))), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('step numbers, ticket labels and saved condition names identify every builder reference', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('funnel-node-branch').click();
    await page.getByLabel('Condition name', { exact: true }).fill('Check selected day');
    assert.match(await page.getByTestId('funnel-node-branch').innerText(), /Step 2 · Check selected day/);
    await page.getByTestId('funnel-node-parking').click();
    const inspector = page.locator('.efb-inspector');
    const requiredSource = inspector.locator('.efb-check').filter({ hasText: 'Step 1 · Annual conference' });
    assert.match(await requiredSource.innerText(), /Standard admission, Premium admission/);
    const options = await page.getByLabel('If accepted, continue to', { exact: true }).locator('option').evaluateAll(items =>
      items.map(item => ({ value: item.value, label: item.textContent })));
    assert.equal(options.find(option => option.value === 'branch').label, 'Step 2 · Check selected day');
    assert.match(options.find(option => option.value === 'parking').label, /^Step 3 · Annual conference — Parking/);
    assert.match(options.find(option => option.value === 'dinner').label, /^Step 4 · Annual conference — Dinner/);
    assert.equal(options.find(option => option.value === 'checkout').label, 'Step 5 · Checkout');
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    assert.equal(await page.evaluate(() => window.saved[0].graph.nodes.find(node => node.id === 'branch').name), 'Check selected day');
    assert.deepEqual(await page.evaluate(() => window.saved[0].graph.nodes.map(node => node.id)), ['source', 'branch', 'parking', 'dinner', 'checkout']);
    await page.getByTestId('funnel-node-branch').click();
    await page.getByLabel('Condition name', { exact: true }).fill('');
    assert.match(await page.getByTestId('funnel-node-branch').innerText(), /Step 2 · Selection condition/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('mounted editor previews prioritised branches and source-only completion', async () => {
  const { page, errors } = await open();
  try {
    assert.equal(await page.locator('.react-flow__minimap').count(), 1);
    await page.getByTestId('funnel-quantity-source-standard').fill('1');
    await page.getByTestId('funnel-quantity-source-premium').fill('1');
    await page.getByTestId('funnel-run-preview').click();
    await page.waitForFunction(() => window.previewCalls.length === 1);
    assert.match(await page.getByTestId('funnel-preview-result').innerText(), /matched priority 10/);
    await page.getByTestId('funnel-preview-checkout-now').check();
    await page.getByTestId('funnel-run-preview').click();
    await page.waitForFunction(() => window.previewCalls.length === 2);
    assert.equal(await page.evaluate(() => window.previewCalls[1].checkoutNow), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('failed saves and previews preserve edits and samples; publication failure is explicit', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('funnel-name').fill('Edited conference offers');
    await page.evaluate(() => { window.failSave = true; });
    await page.getByTestId('funnel-save').click();
    await page.getByText(/Concurrent edit: reload before saving/).waitFor();
    assert.equal(await page.getByTestId('funnel-name').inputValue(), 'Edited conference offers');
    await page.evaluate(() => { window.failSave = false; });
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 2);
    assert.equal(await page.evaluate(() => window.saved[1].expectedRevision), 1);
    await page.getByTestId('funnel-publish').click();
    await page.getByText(/Checkout activation is not ready/).waitFor();
    await page.getByTestId('funnel-quantity-source-standard').fill('2');
    await page.evaluate(() => { window.failPreview = true; });
    await page.getByTestId('funnel-run-preview').click();
    await page.getByTestId('funnel-preview-error').waitFor();
    assert.equal(await page.getByTestId('funnel-quantity-source-standard').inputValue(), '2');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('node layout remains separate from routing when dragged', async () => {
  const { page, errors } = await open();
  try {
    const source = page.getByTestId('funnel-node-source');
    const box = await source.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + 65, { steps: 8 });
    await page.mouse.up();
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    assert.equal(await page.evaluate(() => window.saved[0].graph.nodes[0].accept), 'branch');
    assert.notEqual(await page.evaluate(() => window.saved[0].layout.positions.source.x), 200);
    assert.equal(await page.evaluate(() => window.saved[0].graph.nodes.some(node => 'position' in node)), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test('auto layout preserves routing, saves positions and allows subsequent manual dragging', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('funnel-auto-layout').click();
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const saved = await page.evaluate(() => window.saved[0]);
    assert.equal(saved.graph.nodes[0].accept, 'branch');
    assert.equal(saved.graph.nodes.some(node => 'position' in node), false);
    assert.equal(Object.keys(saved.layout.positions).length, saved.graph.nodes.length);
    assert.ok(saved.layout.positions.source.y < saved.layout.positions.branch.y);
    // The fitted graph remains manually draggable after automatic arrangement.
    const source = page.getByTestId('funnel-node-source');
    await page.waitForTimeout(300); // fitView animation
    const box = await source.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 65, { steps: 8 });
    await page.mouse.up();
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 2);
    const moved = await page.evaluate(() => window.saved[1]);
    assert.deepEqual(moved.graph, saved.graph);
    assert.notDeepEqual(moved.layout.positions.source, saved.layout.positions.source);
    page.on('dialog', dialog => dialog.accept());
    await page.getByTestId('funnel-new').click();
    await page.getByTestId('funnel-definition-choice').selectOption('fixture');
    await page.getByTestId('funnel-node-source').waitFor();
    assert.equal(await page.getByTestId('funnel-save').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('membership stage chooses an active tier and recipient, and saves without ticket fields', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('funnel-add-membership').click();
    const tier = page.getByTestId('funnel-membership-tier');
    await tier.waitFor();
    assert.deepEqual(await tier.locator('option:not([disabled])').allInnerTexts(), ['Corporate', 'Individual']);
    await tier.selectOption({ label: 'Corporate' });
    assert.equal(await page.getByTestId('funnel-membership-recipient').count(), 0);
    await tier.selectOption({ label: 'Individual' });
    await page.getByTestId('funnel-membership-recipient').selectOption('attendees');
    await page.getByTestId('funnel-membership-description').fill('One year on us');
    await page.getByTestId('funnel-save').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const saved = await page.evaluate(() => window.saved[0]);
    const node = saved.graph.nodes.find(item => item.type === 'membership');
    assert.deepEqual(node.membership, { scheduleId: '00000000-0000-4000-8000-000000000011', scope: 'member',
      recipientMode: 'attendees', description: 'One year on us' });
    for (const field of ['event', 'ticketIds']) assert.equal(field in node, false);
    assert.ok(saved.graph.nodes.some(item => item.accept === node.id || item.fallback === node.id
      || item.rules?.some(rule => rule.to === node.id)));
    assert.equal(JSON.stringify(saved).includes('Retired tier'), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

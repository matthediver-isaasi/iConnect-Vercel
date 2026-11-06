// Isolated fixture built from the actual builder JSX and callbacks; no tenant APIs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let server, browser, origin;
const source = await readFile('client/src/pages/FormBuilder.jsx', 'utf8');
const picker = source.slice(source.indexOf('function LinkedEventCombobox('), source.indexOf('function PolicyMultiSelect('));
const start = source.indexOf('{!isSurveyForm && (', source.indexOf('data-testid="switch-is-job-posting"'));
const end = source.indexOf('<div className="flex flex-col gap-2 min-w-[260px]', start);
const settings = source.slice(start, end);
const load = source.match(/is_event_related: existingForm\.is_event_related \?\? false,\s*related_event_id: existingForm\.related_event_id \|\| null,/)[0];
const longTitle = 'Annual international research conference — ' + 'Long event name '.repeat(25);

async function startFixture(port = 0) {
  const bundle = await build({
    stdin: { contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Button} from '@/components/ui/button';
      import {Label} from '@/components/ui/label';
      import {Switch} from '@/components/ui/switch';
      import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
      import {Command, CommandInput, CommandList, CommandEmpty, CommandItem} from '@/components/ui/command';
      import {Check, ChevronsUpDown} from 'lucide-react';
      import {cn} from '@/lib/utils';
      import {prepareFormEditorUpdate,formEditorPatch} from '@/lib/formEditorSave';
      ${picker}
      const eventOptions = [
        {id:'long',title:${JSON.stringify(longTitle)},start_date:'2030-02-01'},
        {id:'workshop',title:'Zebra workshop',start_date:'2030-03-01'}
      ];
      function Fixture() {
        const [formData,setFormData] = useState(() => {
          const existingForm = JSON.parse(localStorage.getItem('saved') || '{}');
          return {${load}};
        });
        const isSurveyForm = new URLSearchParams(location.search).has('survey');
        return <main className="max-w-5xl mx-auto p-4">
          <section className="border rounded-lg p-6 space-y-3">
            ${settings}
            <div data-testid="following-settings">Other settings</div>
          </section>
          <button onClick={() => {
            const dataToSave = formEditorPatch(prepareFormEditorUpdate(formData, null), null);
            localStorage.setItem('saved',JSON.stringify(dataToSave));
          }}>Save fixture</button>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 10 * 1024 * 1024 });
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}

if (process.argv.includes('--serve')) {
  await startFixture(5173);
  console.log('Isolated linked-event fixture on port 5173');
} else {
  before(async () => {
    await startFixture();
    browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
  });
  after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  for (const width of [1280, 375]) {
    test(`linked event layout and save/reload behavior at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(origin);
        const trigger = page.getByTestId('select-related-event');
        assert.equal(await trigger.count(), 0);
        await page.getByTestId('switch-is-event-related').click();
        assert.equal(await trigger.count(), 1);
        assert.ok(await page.getByTestId('form-event-settings').evaluate(el =>
          el.children[0].querySelector('[role=switch]') && el.children[1].querySelector('[role=combobox]')));
        assert.ok(source.indexOf('data-testid="form-event-settings"') < source.indexOf('<FormAccessPolicyEditor', start));
        const groupBox = await page.getByTestId('form-event-settings').boundingBox();
        const triggerBox = await trigger.boundingBox();
        assert.ok(Math.abs(groupBox.width - triggerBox.width) < 2);
        if (width > 1000) assert.ok(triggerBox.width > 448, 'no old max-w-md cap');
        await trigger.click();
        await page.getByTestId('option-event-long').waitFor();
        await page.waitForTimeout(250);
        const popup = page.locator('[data-radix-popper-content-wrapper]');
        const popupBox = await popup.boundingBox();
        assert.ok(Math.abs(popupBox.width - triggerBox.width) < 2);
        assert.ok(popupBox.x >= 0 && popupBox.x + popupBox.width <= width);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.ok(await page.getByTestId('option-event-long').textContent().then(t => t.includes(longTitle)));
        await page.getByTestId('input-related-event-search').fill('ZEBRA');
        assert.equal(await page.locator('[cmdk-item]').count(), 1);
        await page.getByTestId('input-related-event-search').fill('absent');
        assert.ok(await page.getByText('No upcoming events found').isVisible());
        await page.getByTestId('input-related-event-search').fill('');
        await page.getByTestId('option-event-long').click();
        assert.ok((await trigger.textContent()).includes(longTitle));
        await page.getByText('Save fixture', { exact: true }).click();
        await page.reload();
        assert.ok((await trigger.textContent()).includes(longTitle));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await trigger.click();
        await page.getByTestId('option-event-long').click();
        assert.match(await trigger.textContent(), /Select an upcoming event/);
        await trigger.click();
        await page.getByTestId('option-event-workshop').click();
        await page.getByTestId('switch-is-event-related').click();
        assert.equal(await trigger.count(), 0);
        await page.getByText('Save fixture', { exact: true }).click();
        const saved = await page.evaluate(() => JSON.parse(localStorage.saved));
        assert.equal(saved.is_event_related, false);
        assert.equal(saved.related_event_id, null);
        await page.reload();
        assert.equal(await trigger.count(), 0);
        await page.getByTestId('switch-is-event-related').click();
        assert.match(await trigger.textContent(), /Select an upcoming event/);
      } finally { await page.close(); }
    });
  }
  test('survey retains assignment guidance, never exposes the standard selector', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      await page.evaluate(() => localStorage.setItem('saved', JSON.stringify({ is_event_related: true, related_event_id: 'long' })));
      await page.goto(`${origin}/?survey`);
      assert.equal(await page.getByTestId('switch-is-event-related').count(), 0);
      assert.equal(await page.getByTestId('select-related-event').count(), 0);
      assert.match(await page.getByTestId('survey-event-authority').textContent(), /Use the Events tab/);
      await page.getByText('Save fixture', { exact: true }).click();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.saved).related_event_id), 'long');
    } finally { await page.close(); }
  });
}

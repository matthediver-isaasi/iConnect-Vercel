import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('ticket provisioning controls and purchaser capture in a real isolated browser', { timeout: 60000 }, async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import Fields from './client/src/components/events/PublicTicketMemberFields.jsx';
        import Purchaser from './client/src/components/booking/PurchaserIdentityFields.jsx';
        import {updateTicketMemberField,ticketMemberPolicy} from './client/src/utils/publicTicketMembers.js';
        function Fixture(){
          const [ticket,setTicket]=useState({id:'ticket',visibility_mode:'public_only'});
          const [buyer,setBuyer]=useState({});
          const [saved,setSaved]=useState(null);
          return <main>
            <button onClick={()=>setTicket(t=>updateTicketMemberField(t,'visibility_mode','members_and_public'))}>Change audience</button>
            <button onClick={()=>setTicket(t=>updateTicketMemberField(t,'visibility_mode','public_only'))}>Public only</button>
            <Fields ticket={ticket} roles={[{id:'contact',name:'Contact'},{id:'admin',name:'Administrator',is_admin:true}]}
              onChange={patch=>setTicket(t=>({...t,...patch}))}/>
            <Purchaser value={buyer} onChange={setBuyer}/>
            <button onClick={()=>{const data={...ticket,...ticketMemberPolicy(ticket)};setSaved(data);window.savedPolicy=data;window.savedBuyer=buyer;}}>Save fixture policy</button>
            <button onClick={()=>setTicket(saved)}>Reload fixture policy</button>
          </main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    jsx: 'automatic', alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch({
    executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<!doctype html><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const toggle = page.getByRole('switch');
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.getByRole('combobox', { name: 'Role for new members' }).click();
    assert.equal(await page.getByRole('option', { name: 'Administrator', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'Contact', exact: true }).click();
    await page.getByRole('button', { name: 'Save fixture policy' }).click();
    assert.equal((await page.evaluate(() => window.savedPolicy)).new_member_role_id, 'contact');
    await toggle.click();
    await page.getByRole('button', { name: 'Reload fixture policy' }).click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: 'Change audience' }).click();
    assert.equal(await page.getByRole('switch').count(), 0);
    await page.getByRole('button', { name: 'Save fixture policy' }).click();
    assert.equal((await page.evaluate(() => window.savedPolicy)).create_member_records, false);
    assert.equal((await page.evaluate(() => window.savedPolicy)).new_member_role_id, null);
    const inputs = page.locator('input');
    assert.equal(await inputs.count(), 4);
    for (let index = 0; index < 4; index++) assert.equal(await inputs.nth(index).inputValue(), '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

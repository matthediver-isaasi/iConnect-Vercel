import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('isolated browser: select Department relationship boolean, serialize and reopen without API calls', async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Editor from './client/src/components/communications/CustomObjectAudienceCondition.jsx';
      const metadata = {custom_objects:[{id:'object-fixture',label:'Organisation department',relationships:[{
        id:'relationship-fixture',label:'Members',object_side:'source',record_fields:[{id:'record-fixture',key:'title',label:'Title',data_type:'text',operators:['equals']}],
        relationship_fields:[{id:'field-fixture',key:'survey_respondent',label:'Survey respondent',data_type:'boolean',operators:['is_true','is_false','is_empty','is_not_empty']}]
      }]}]};
      function App() {
        const [condition,setCondition] = React.useState({entity_scope:'custom_object'});
        const [available,setAvailable] = React.useState(true);
        window.savedCondition = condition;
        return <><Editor condition={condition} metadata={available ? metadata : null} disabled={!available} onChange={setCondition}/>
          <button onClick={()=>setCondition(JSON.parse(JSON.stringify(window.savedCondition)))}>Reopen saved</button>
          <button onClick={()=>setAvailable(!available)}>Toggle definitions</button></>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `, loader: 'jsx', resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
    alias: { '@': `${process.cwd()}/client/src` },
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const choose = async (label, option) => {
      await page.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    await choose('Custom Object', 'Organisation department');
    await choose('Member relationship', 'Members (Object → Member)');
    await choose('Record or relationship field', 'Relationship: Survey respondent');
    await choose('Operator', 'Yes');
    const saved = await page.evaluate(() => window.savedCondition);
    assert.equal(saved.operator, 'is_true');
    assert.equal(saved.field_key, 'survey_respondent');
    assert.equal(saved.field_id, 'field-fixture');
    assert.equal(saved.object_side, 'source');
    assert.equal(saved.version, 1);
    await page.getByRole('button', { name: 'Reopen saved' }).click();
    assert.match(await page.getByRole('combobox', { name: 'Record or relationship field', exact: true }).innerText(), /Survey respondent/);
    await page.getByRole('button', { name: 'Toggle definitions' }).click();
    assert.match(await page.getByRole('alert').innerText(), /Retry loading/);
    assert.deepEqual(await page.evaluate(() => window.savedCondition), saved);
    await page.getByRole('button', { name: 'Toggle definitions' }).click();
    await choose('Operator', 'No');
    assert.equal(await page.evaluate(() => window.savedCondition.operator), 'is_false');
  } finally {
    await browser.close();
  }
});
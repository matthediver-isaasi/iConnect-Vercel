// Real repository component, isolated data only; no tenant or storage writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const bundle = await build({
  stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import Page from './client/src/pages/FileManagement.jsx';
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
    base44.entities.FileRepository.list=async()=>files;
    base44.entities.FileRepositoryFolder.list=async()=>folders;
    base44.entities.SystemSettings.filter=async()=>[];
    window.fetch=async url=>{
      if(url!=='/api/admin/plan-usage') throw Error('Unexpected fixture request');
      return {ok:true,json:async()=>({})};
    };
    createRoot(document.getElementById('root')).render(<MemoryRouter>
      <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
        <Page/>
      </QueryClientProvider></MemoryRouter>);
  `, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  alias: { '@': `${process.cwd()}/client/src` },
  define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
});
const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css',
  '--content', 'client/src/pages/FileManagement.jsx,client/src/components/ui/**/*.{jsx,tsx}'], { maxBuffer: 10 * 1024 * 1024 });
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
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
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

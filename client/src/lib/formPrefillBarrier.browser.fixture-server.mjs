// Optional local screenshot fixture. No app startup, auth changes, DB or
// provider access. The only served documents are these in-memory assets.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const bundle = await build({
  entryPoints: ['client/src/lib/formPrefillBarrier.browser.fixture.jsx'],
  bundle: true, write: false, platform: 'browser', format: 'iife',
  jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
});
const css = await postcss([tailwindcss('tailwind.config.ts')]).process(
  await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' },
);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
const server = createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/fixture') {
    response.writeHead(404); response.end('Fixture has no API routes'); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(html);
});
server.listen(5059, '127.0.0.1', () => console.log('Isolated prefill fixture: http://127.0.0.1:5059/fixture'));
process.on('SIGTERM', () => server.close());

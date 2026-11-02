import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
const result=await build({entryPoints:['client/src/consentPreview.jsx'],bundle:true,format:'iife',platform:'browser',
  outfile:'preview.js',write:false,minify:true,define:{'process.env.NODE_ENV':'"production"'}});
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text.replaceAll('</script','<\\/script');
const css=result.outputFiles.find(f=>f.path.endsWith('.css'))?.text || '';
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consent preview</title><style>body{font-family:system-ui;padding:1rem}${css}</style></head><body><h1>Cookie consent preview</h1><p>This isolated preview does not save real consent or load analytics.</p><div id="root"></div><script>${js}</script></body></html>`;
const dir=process.argv.includes('--build')?'dist/public':'generated-artifacts';
await mkdir(dir,{recursive:true});await writeFile(`${dir}/cookie-consent-preview.html`,html);

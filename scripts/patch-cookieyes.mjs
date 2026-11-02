// Approved minimal extension to the pinned MIT SDK. Fail closed on upstream drift.
// No replacement consent logic: namespacing, revision and dispatcher disposal only.
import fs from 'node:fs';
import { buildSync } from 'esbuild';
const root = new URL('../node_modules/@cookieyes/core/', import.meta.url);
if (JSON.parse(fs.readFileSync(new URL('package.json', root))).version !== '0.12.0') throw new Error('Review CookieYes isolation patch for new core version');
const path = new URL('dist/index.js', root);
let code = fs.readFileSync(path, 'utf8');
if (code.includes('/* iconn-isolation-v1 */')) {
  code = code.replace('const cookieName=e.backend?.storageScope?t+"-"+e.backend.storageScope:t;', 'const cookieName=e.backend?.storageScope?"cookieyes-consent-"+e.backend.storageScope:"cookieyes-consent";');
  fs.writeFileSync(path, code);
}
if (!code.includes('/* iconn-isolation-v1 */')) {
  function replace(old, next) {
    if (!code.includes(old) || code.indexOf(old) !== code.lastIndexOf(old)) throw new Error(`CookieYes patch drift: ${old.slice(0, 65)}`);
    code = code.replace(old, next);
  }
  // backend scope is deliberately captured per manager/queue, never global.
  replace('function d(e){for(const n of e.split(";"))', 'function d(e,name=t){for(const n of e.split(";"))');
  replace('!==t)continue', '!==name)continue');
  replace('function l(e){if("undefined"==typeof document)return;', 'function l(e,name=t){if("undefined"==typeof document)return;');
  replace('`${t}=${n}; max-age=31536000; path=/; SameSite=Lax`', '`${name}=${n}; max-age=31536000; path=/; SameSite=Lax${location.protocol==="https:"?"; Secure":""}`');
  replace('function g(){"undefined"!=typeof document', 'function g(name=t){"undefined"!=typeof document');
  replace('`${t}=; max-age=0; path=/`', '`${name}=; max-age=0; path=/; SameSite=Lax`');
  replace('function z(){', 'function z(key=Y){');
  replace('localStorage.getItem(Y)', 'localStorage.getItem(key)');
  replace('function J(e){', 'function J(e,key=Y){');
  replace('localStorage.setItem(Y,JSON.stringify(e))', 'localStorage.setItem(key,JSON.stringify(e))');
  replace('localStorage.removeItem(Y)', 'localStorage.removeItem(key)');
  const start = code.indexOf('function W(e){'), end = code.indexOf('const Q=', start);
  if (start < 0 || end < 0) throw new Error('Queue boundary changed');
  let queue = code.slice(start, end);
  queue = queue.replace('const n=new Set;', 'const key=e.backend?.storageScope?Y+"-"+e.backend.storageScope:Y;let disposed=false;const n=new Set;');
  queue = queue.replace('async function r(){', 'async function r(){if(disposed)return;');
  queue = queue.replaceAll('z()', 'z(key)').replaceAll('J(i)', 'J(i,key)').replaceAll('J(G(z(key),t.recordId))', 'J(G(z(key),t.recordId),key)').replaceAll('J([...G(z(key),n.recordId),n].slice(-10))','J([...G(z(key),n.recordId),n].slice(-10),key)');
  queue = queue.replace('if(void 0!==t)return;', 'if(disposed||void 0!==t)return;');
  queue = queue.replace('("online",()=>{r()})', '("online",r)');
  queue = queue.replace('send(n){', 'dispose(){disposed=true;clearTimeout(t);if(typeof window!=="undefined")window.removeEventListener("online",r)},send(n){if(disposed)return;');
  code = code.slice(0,start) + queue + code.slice(end);
  replace('function le(e){', 'function le(e){const cookieName=e.backend?.storageScope?"cookieyes-consent-"+e.backend.storageScope:"cookieyes-consent";');
  // Bind private cookie helpers in the manager only.
  const ms = code.indexOf('function le(e){'), me = code.indexOf('function ge(', ms);
  let manager = code.slice(ms, me);
  manager = manager.replaceAll('d(document.cookie)', 'd(document.cookie,cookieName)').replaceAll('l(s)', 'l(s,cookieName)').replaceAll('g()', 'g(cookieName)');
  manager = manager.replace('const x={', 'const x={dispose(){t?.dispose();n.clear()},');
  code = code.slice(0,ms) + manager + code.slice(me);
  replace('function Ce(){', 'function Ce(){me?.consentManager.dispose?.();');
  code = '/* iconn-isolation-v1 */\n' + code;
  fs.writeFileSync(path, code);
  // CJS gets the same extension; relative requires continue using official files.
}
// Opaque-origin previews and browsers with blocked cookies remain usable in memory.
code = code.replace('d(document.cookie,cookieName)', '(()=>{try{return d(document.cookie,cookieName)}catch{return null}})()');
code = code.replace('document.cookie=`${name}=${n}; max-age=31536000; path=/; SameSite=Lax${location.protocol==="https:"?"; Secure":""}`',
  '(()=>{try{document.cookie=`${name}=${n}; max-age=31536000; path=/; SameSite=Lax${location.protocol==="https:"?"; Secure":""}`}catch{}})()');
code = code.replace('(document.cookie=`${name}=; max-age=0; path=/; SameSite=Lax`)',
  '(()=>{try{document.cookie=`${name}=; max-age=0; path=/; SameSite=Lax`}catch{}})()');
fs.writeFileSync(path, code);
buildSync({entryPoints:[path.pathname],outfile:new URL('dist/index.cjs',root).pathname,bundle:true,format:'cjs',platform:'browser',target:'es2020'});
console.log('CookieYes core isolation patch ready');

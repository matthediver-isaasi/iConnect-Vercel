// Explicit opt-in, read-only report replay. Auth is supplied by this diagnostic,
// not a browser session: this verifies queries/data, not deployed authorization/UI.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';

if (!process.argv.includes('--bnms-read-only')) throw new Error('Requires --bnms-read-only');
if (new URL(process.env.DEST_SUPABASE_URL).hostname !== 'lvmzliemqnieeoruhkik.supabase.co') {
  throw new Error('Unexpected database target');
}
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const host = process.argv.includes('--deployed-db-host') ? 'https://vault.iconn.app' : process.env.DEST_SUPABASE_URL;
let failures = 0;
globalThis.reportProbeDb = createClient(host, process.env.DEST_SUPABASE_KEY, {
  global: { fetch: async (url, options) => {
    if (options?.method && !['GET', 'HEAD'].includes(options.method)) throw new Error('Read-only boundary');
    const response = await fetch(url, options);
    if (!response.ok) {
      failures++;
      let code = 'UNKNOWN';
      try {
        const body = await response.clone().json();
        if (/^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(body.code || '')) code = body.code;
      } catch {}
      console.log(JSON.stringify({ stage: new URL(url).pathname.split('/').pop(), status: response.status, code, urlLength: String(url).length }));
    }
    return response;
  } },
});
function absoluteImports(source, path) {
  return source.replace(/from '([^']+)'/g, (original, specifier) =>
    specifier.startsWith('.') ? `from '${new URL(specifier, pathToFileURL(path)).href}'` : original);
}
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const root = process.cwd();
let checkin = await readFile('api/_lib/checkinService.js', 'utf8');
checkin = checkin.replace("import { supabase } from './database.js';", 'const supabase = globalThis.reportProbeDb;');
const checkinModule = asModule(absoluteImports(checkin, `${root}/api/_lib/checkinService.js`));
let source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:api/reports/event-registration-report.js'], { encoding: 'utf8' })
  : await readFile('api/reports/event-registration-report.js', 'utf8');
source = source
  .replace("import { supabase } from '../_lib/database.js';", 'const supabase = globalThis.reportProbeDb;')
  .replace(/import .* from '..\/_lib\/tenantContext.js';/, `const getTenantContext=async()=>({tenantId:'${tenantId}',isAuthenticated:true,isSuperAdmin:true}); const hasAdminAccess=async()=>true; const hasFeatureAccess=async()=>true;`)
  .replace("from '../_lib/checkinService.js'", `from '${checkinModule}'`);
const { default: handler } = await import(asModule(absoluteImports(source, `${root}/api/reports/event-registration-report.js`)));
// Suppress raw diagnostics from unchanged dependencies; the fetch observer above
// supplies only safe stage/code/status. Never print report rows or identity data.
console.error = () => {};
for (const name of ['Sarah', '__no_match_readonly_probe_5465__']) {
  const res = {
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) {
      console.log(JSON.stringify({ probe: name === 'Sarah' ? 'name-only' : 'no-match', status: this.code,
        groups: body.bookingGroups?.length, bookings: body.summary?.totalBookings, failures }));
      if (this.code !== 200) process.exitCode = 1;
      return this;
    },
  };
  await handler({ method: 'GET', query: { generate: 'true', name } }, res);
}

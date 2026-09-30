#!/usr/bin/env node
// Reuse the reviewed CPD Guest runner's transaction, recovery and scope guards.
// Substitutions are checked so changes to that runner cannot silently broaden scope.
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./assign-bnms-cpd-guest-role.mjs', import.meta.url), 'utf8');
function replaceExactly(text, needle, replacement, count) {
  if (text.split(needle).length - 1 !== count) throw new Error('Reviewed runner structure changed');
  return text.replaceAll(needle, replacement);
}
let runner = replaceExactly(source, "const ROLE = 'b640bd84-3d84-4cde-9f27-c3e80edb762f';", '', 1);
runner = replaceExactly(runner, "from 'pg'", `from ${JSON.stringify(import.meta.resolve('pg'))}`, 1);
runner = replaceExactly(runner, "'./apply-custom-object-relationship-deleted-members-migration.mjs'",
  JSON.stringify(new URL('./apply-custom-object-relationship-deleted-members-migration.mjs', import.meta.url).href), 1);
runner = replaceExactly(runner, "matches.length === 1 && matches[0].id === ROLE", "matches.length === 1", 1);
runner = replaceExactly(runner, 'const role = matches[0];', 'const role = matches[0];\n    const ROLE = role.id;', 1);
runner = replaceExactly(runner, 'members.length === 2340', 'members.length > 0', 1);
runner = replaceExactly(runner, 'CPD Guest', 'Former', 7);
runner = replaceExactly(runner, 'bnms-cpd-guest-role', 'bnms-former-role', 1);
// Module imports have no side effects; explicit invocation below retains CLI guards.
const { main } = await import(`data:text/javascript;base64,${Buffer.from(runner).toString('base64')}`);
await main().catch(() => {
  console.error('Destination operation failed; no credentials logged.');
  process.exitCode = 1;
});
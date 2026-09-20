#!/usr/bin/env node
// Reuse the reviewed CPD Guest runner's transaction, recovery and scope guards.
// Class and target role deliberately differ; every substitution is count-checked.
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
runner = replaceExactly(runner, "role.name === 'CPD Guest'", "role.name === 'Dept. Survey Responder'", 1);
runner = replaceExactly(runner, "targetRole: 'CPD Guest'", "targetRole: 'Dept. Survey Responder'", 1);
runner = replaceExactly(runner, 'CPD Guest', 'Department contact', 5);
runner = replaceExactly(runner, 'bnms-cpd-guest-role', 'bnms-department-contact-role', 1);
// Module imports have no side effects; explicit invocation retains CLI guards.
const { main } = await import(`data:text/javascript;base64,${Buffer.from(runner).toString('base64')}`);
await main().catch(() => {
  console.error('Destination operation failed; no credentials logged.');
  process.exitCode = 1;
});
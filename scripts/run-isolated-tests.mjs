#!/usr/bin/env node
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const usage = `Usage:
  node scripts/run-isolated-tests.mjs [--allow-local-postgres] <command> [args...]
  node scripts/run-isolated-tests.mjs [--allow-local-postgres] --shell <command>

The command runs with a fail-closed test boundary. It blocks fetch, HTTP(S),
TCP/TLS, UDP, and child processes. Node children inherit the boundary.

--allow-local-postgres permits only initdb/pg_ctl/psql commands scoped to a
temporary directory and PostgreSQL connections over a UNIX-domain socket.
It does not permit TCP localhost, application previews, proxies, or remote DBs.

Tests may replace blocked APIs with controlled in-memory mocks after startup.
Native addons, worker threads, and browser processes are outside this JS guard
and must not be used as a substitute for an explicitly authorized live check.`;

let argv = process.argv.slice(2);
let allowLocalPostgres = false;
if (argv[0] === '--allow-local-postgres') {
  allowLocalPostgres = true;
  argv = argv.slice(1);
}
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(usage);
  process.exit(argv.length === 0 ? 2 : 0);
}

let command;
let commandArgs;
if (argv[0] === '--shell') {
  if (argv.length !== 2) {
    console.error('--shell requires exactly one command string');
    process.exit(2);
  }
  const shellCommand = argv[1];
  // Shell mode exists for existing validation strings that need glob expansion
  // or `&&`. Keep it declarative: each segment must launch a Node tool, and
  // reject substitution/redirection constructs that could launch an unguarded
  // native command from the shell itself.
  if (/[\n\r;|<>`$]/.test(shellCommand)) {
    console.error('--shell rejects substitution, pipelines, redirection, and command separators other than &&');
    process.exit(2);
  }
  const segments = shellCommand.split(/\s*&&\s*/);
  if (segments.some(segment => !/^(?:node|npx|tsx)(?:\s|$)/.test(segment.trim()))) {
    console.error('--shell only permits node, npx, or tsx command segments');
    process.exit(2);
  }
  command = '/bin/sh';
  commandArgs = ['-c', shellCommand];
} else {
  [command, ...commandArgs] = argv;
}

const auditDirectory = mkdtempSync(join(tmpdir(), 'test-isolation-'));
const auditFile = join(auditDirectory, 'blocked-attempts.jsonl');
const postgresStateFile = join(auditDirectory, 'postgres-paths.txt');
openSync(auditFile, 'a', 0o600);
openSync(postgresStateFile, 'a', 0o600);
const boundary = new URL('./test-support/isolation-boundary.mjs', import.meta.url).pathname;
const existingNodeOptions = String(process.env.NODE_OPTIONS || '')
  .split(/\s+/)
  .filter(Boolean)
  .filter(part => !part.includes('isolation-boundary.mjs'));
const env = {
  ...process.env,
  TEST_ISOLATION_ACTIVE: '1',
  TEST_ISOLATION_AUDIT_FILE: auditFile,
  TEST_ISOLATION_PG_STATE_FILE: postgresStateFile,
  TEST_ISOLATION_ALLOW_LOCAL_PG: allowLocalPostgres ? '1' : '0',
  NODE_OPTIONS: [`--import=${boundary}`, ...existingNodeOptions].join(' '),
  PATH: String(process.env.PATH || '').split(delimiter).join(delimiter),
};

const commandName = command.split('/').pop();
if (!['node', 'npx', 'tsx'].includes(commandName) && command !== process.execPath && command !== '/bin/sh') {
  console.error('isolated commands must be node, npx, or tsx tools');
  rmSync(auditDirectory, { recursive: true, force: true });
  process.exit(2);
}
// Install the boundary in the runner too. When this script was itself started
// under a boundary, the preload is already active and this resolves from cache.
await import('./test-support/isolation-boundary.mjs');

let result;
try {
  result = spawnSync(command, commandArgs, { env, stdio: 'inherit' });
  const attempts = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
  if (attempts.length > 0) {
    const mechanisms = [...new Set(attempts.map(line => {
      try {
        return JSON.parse(line).mechanism;
      } catch {
        return 'unknown mechanism';
      }
    }))];
    console.error(
      `\nTest isolation failed: ${attempts.length} blocked attempt(s) were made `
      + `(including attempts caught by test code): ${mechanisms.join(', ')}`,
    );
    process.exitCode = 1;
  } else if (result.error) {
    console.error(`Unable to start isolated command: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(auditDirectory, { recursive: true, force: true });
}

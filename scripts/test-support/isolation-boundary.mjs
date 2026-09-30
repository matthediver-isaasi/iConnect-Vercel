import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

const auditFile = process.env.TEST_ISOLATION_AUDIT_FILE;
const postgresStateFile = process.env.TEST_ISOLATION_PG_STATE_FILE;
const active = true;
const allowLocalPostgres = process.env.TEST_ISOLATION_ALLOW_LOCAL_PG === '1';
const boundaryImport = new URL(import.meta.url).pathname;

// The server role-access module normally primes its database-backed hierarchy
// overlay during module evaluation. Isolated tests must opt out before any API
// module graph is loaded; authorization still uses the generated fail-safe
// hierarchy and production startup remains unchanged.
if (active) {
  process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
}
let blockedAttemptCount = 0;
const runnerPath = resolve(new URL('../run-isolated-tests.mjs', import.meta.url).pathname);
const isRunnerProcess = process.argv[1] && resolve(process.argv[1]) === runnerPath;
const runnerShellIndex = isRunnerProcess ? process.argv.indexOf('--shell') : -1;
const runnerShellCommand = runnerShellIndex === -1 ? null : process.argv[runnerShellIndex + 1];

class TestIsolationError extends Error {
  constructor(mechanism) {
    super(`Test isolation boundary blocked ${mechanism}`);
    this.name = 'TestIsolationError';
    this.code = 'TEST_ISOLATION_BLOCKED';
  }
}

function recordBlocked(mechanism) {
  blockedAttemptCount += 1;
  if (auditFile) {
    appendFileSync(auditFile, `${JSON.stringify({
      pid: process.pid,
      mechanism,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  throw new TestIsolationError(mechanism);
}

process.on('exit', () => {
  if (blockedAttemptCount > 0 && (!process.exitCode || process.exitCode === 0)) {
    process.exitCode = 1;
  }
});

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function isTemporaryPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const candidate = resolve(value);
  const temporaryRoot = `${resolve(tmpdir())}/`;
  return candidate.startsWith(temporaryRoot);
}

function postgresState() {
  if (!postgresStateFile || !existsSync(postgresStateFile)) return [];
  return readFileSync(postgresStateFile, 'utf8').split('\n').filter(Boolean);
}

function rememberPostgresPath(kind, value) {
  if (postgresStateFile && isTemporaryPath(value)) {
    appendFileSync(postgresStateFile, `${kind}:${resolve(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function hasPostgresPath(kind, value) {
  const expected = `${kind}:${resolve(value)}`;
  return postgresState().includes(expected);
}

function isScopedPostgresCommand(command, args, options = {}) {
  if (!allowLocalPostgres || typeof command !== 'string') return false;
  const name = basename(command);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (name === 'initdb') {
    return isTemporaryPath(optionValue(argv, '-D') || optionValue(argv, '--pgdata'));
  }
  if (name === 'pg_ctl') {
    const dataDirectory = optionValue(argv, '-D') || optionValue(argv, '--pgdata');
    if (!isTemporaryPath(dataDirectory) || !hasPostgresPath('cluster', dataDirectory)) return false;
    const operation = argv.includes('start') ? 'start' : argv.includes('stop') ? 'stop' : null;
    if (operation === 'stop') return true;
    const serverOptions = optionValue(argv, '-o') || '';
    return operation === 'start'
      && /(?:^|\s)-k\s+\S+/.test(serverOptions)
      && isTemporaryPath(serverOptions.match(/(?:^|\s)-k\s+(\S+)/)?.[1]);
  }
  if (name === 'sh') {
    return argv.length === 2
      && argv[0] === '-c'
      && /^command -v (?:initdb|pg_ctl|psql|createdb|dropdb)$/.test(argv[1]);
  }
  if (name === 'mkdir') {
    return argv.length === 2 && argv[0] === '-p' && isTemporaryPath(argv[1]);
  }
  if (['psql', 'createdb', 'dropdb'].includes(name)) {
    const host = optionValue(argv, '-h')
      || optionValue(argv, '--host');
    const database = optionValue(argv, '-d') || optionValue(argv, '--dbname') || '';
    const unsafeConnectionArgument = argv.some(value =>
      /postgres(?:ql)?:\/\/|(?:^|\s)(?:host|hostaddr|service)=/i.test(value));
    const unsafeEnvironment = Object.keys(options?.env || {}).some(key =>
      ['PGHOST', 'PGSERVICE', 'PGSERVICEFILE', 'PGCONNECT_TIMEOUT'].includes(key)
      && options.env[key] !== process.env[key]);
    return isTemporaryPath(host)
      && hasPostgresPath('socket', host)
      && !unsafeConnectionArgument
      && !/^(?:postgres(?:ql)?:\/\/|host=|service=)/i.test(database)
      && !unsafeEnvironment;
  }
  return false;
}

function isControlledEsbuildService(command, args) {
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  let actual;
  try {
    actual = realpathSync(command);
  } catch {
    return false;
  }
  const workspace = `${resolve(process.cwd())}/node_modules/`;
  if (!actual.startsWith(workspace)
      || !/\/node_modules\/@esbuild\/[^/]+\/bin\/esbuild$/.test(actual)) {
    return false;
  }
  return args.length === 2
    && /^--service=\d+\.\d+\.\d+$/.test(String(args[0]))
    && args[1] === '--ping';
}

function isControlledEsbuildWorker(filename, options) {
  if (typeof filename !== 'string' || !options || typeof options !== 'object') return false;
  let actual;
  try {
    actual = realpathSync(filename);
  } catch {
    return false;
  }
  const workspace = `${resolve(process.cwd())}/node_modules/`;
  const workerPort = options.workerData?.workerPort;
  return actual.startsWith(workspace)
    && /\/node_modules\/esbuild\/lib\/main\.js$/.test(actual)
    && Array.isArray(options.execArgv)
    && options.execArgv.length === 0
    && Array.isArray(options.transferList)
    && options.transferList.length === 1
    && options.transferList[0] === workerPort
    && workerPort
    && /^(\d+)\.(\d+)\.(\d+)$/.test(String(options.workerData?.esbuildVersion || ''))
    && resolve(options.workerData?.defaultWD || '') === resolve(process.cwd());
}

function isNodeCommand(command) {
  if (typeof command !== 'string') return false;
  return resolve(command) === resolve(process.execPath) || basename(command) === 'node';
}

function guardedChildOptions(options) {
  const supplied = options && typeof options === 'object' ? options : {};
  const env = { ...process.env, ...(supplied.env || {}) };
  env.TEST_ISOLATION_ACTIVE = '1';
  const delegatedAudit = supplied.env?.TEST_ISOLATION_AUDIT_FILE;
  const delegatedPostgresState = supplied.env?.TEST_ISOLATION_PG_STATE_FILE;
  const delegatedDirectory = delegatedAudit ? dirname(resolve(delegatedAudit)) : '';
  const runnerMayDelegate = isRunnerProcess
    && delegatedAudit
    && delegatedPostgresState
    && delegatedDirectory === dirname(resolve(delegatedPostgresState))
    && delegatedDirectory.startsWith(`${resolve(tmpdir())}/test-isolation-`)
    && basename(delegatedAudit) === 'blocked-attempts.jsonl'
    && basename(delegatedPostgresState) === 'postgres-paths.txt';
  env.TEST_ISOLATION_AUDIT_FILE = runnerMayDelegate
    ? delegatedAudit
    : auditFile || '';
  env.TEST_ISOLATION_PG_STATE_FILE = runnerMayDelegate
    ? delegatedPostgresState
    : postgresStateFile || '';
  env.NODE_OPTIONS = [
    `--import=${boundaryImport}`,
    ...(String(env.NODE_OPTIONS || '')
      .split(/\s+/)
      .filter(Boolean)
      .filter(part => !part.includes('isolation-boundary.mjs'))),
  ].join(' ');
  return { ...supplied, env };
}

function isScopedUnixSocket(args) {
  // Node's createConnection passes its normalized argument tuple as the first
  // value to Socket.connect; direct Socket.connect calls pass the options.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const socketPath = typeof first === 'string'
    ? first
    : first && typeof first === 'object'
      ? first.path
      : null;
  const tsxPipe = join(tmpdir(), `tsx-${process.getuid?.() ?? 'unknown'}`, `${process.ppid}.pipe`);
  if (typeof socketPath === 'string' && resolve(socketPath) === resolve(tsxPipe)) {
    return true;
  }
  if (!allowLocalPostgres) return false;
  if (!isTemporaryPath(socketPath)) return false;
  return postgresState().some(line => {
    if (!line.startsWith('socket:')) return false;
    const socketDirectory = line.slice('socket:'.length);
    return resolve(socketPath) === socketDirectory
      || resolve(socketPath).startsWith(`${socketDirectory}/`)
      || dirname(resolve(socketPath)) === socketDirectory;
  });
}

function hardenedPostgresArgs(command, args) {
  if (!allowLocalPostgres || basename(String(command)) !== 'pg_ctl' || !args.includes('start')) {
    return args;
  }
  const hardened = [...args];
  const optionIndex = hardened.indexOf('-o');
  if (optionIndex !== -1 && !/(?:^|\s)-h(?:\s|=)/.test(String(hardened[optionIndex + 1] || ''))) {
    // Existing local harnesses historically omitted -h. Force PostgreSQL to
    // expose only its temporary UNIX socket, never a localhost TCP listener.
    hardened[optionIndex + 1] = `${hardened[optionIndex + 1]} -h ''`;
  }
  return hardened;
}

function guardChildFunction(name, original) {
  return function guardedChild(command, ...rest) {
    const hasArgs = Array.isArray(rest[0]);
    const args = hasArgs ? rest[0] : [];
    const optionsIndex = hasArgs ? 1 : 0;
    const options = rest[optionsIndex] && typeof rest[optionsIndex] === 'object'
      ? rest[optionsIndex]
      : {};
    if (options.shell === true || typeof options.shell === 'string') {
      return recordBlocked(`child_process.${name}(shell)`);
    }
    const validatedRunnerShell = isRunnerProcess
      && command === '/bin/sh'
      && args[0] === '-c'
      && runnerShellCommand === args[1];
    const scopedPostgres = isScopedPostgresCommand(command, args, options);
    const controlledEsbuild = isControlledEsbuildService(command, args);
    if (!validatedRunnerShell && !isNodeCommand(command) && !scopedPostgres && !controlledEsbuild) {
      return recordBlocked(`child_process.${name}`);
    }
    if (hasArgs) rest[0] = hardenedPostgresArgs(command, args);
    const safeOptions = guardedChildOptions(options);
    if (rest[optionsIndex] && typeof rest[optionsIndex] === 'object') {
      rest[optionsIndex] = safeOptions;
    } else {
      rest.splice(optionsIndex, 0, safeOptions);
    }
    if (scopedPostgres) {
      for (const key of [
        'DATABASE_URL', 'DEST_DATABASE_URL', 'SOURCE_DATABASE_URL',
        'PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE',
      ]) {
        delete safeOptions.env[key];
      }
    }
    const result = original.call(childProcess, command, ...rest);
    const commandName = basename(String(command));
    const successfulSyncCall = name.endsWith('Sync')
      && (result?.status === undefined || result.status === 0);
    if (successfulSyncCall && commandName === 'initdb') {
      rememberPostgresPath('cluster', optionValue(args, '-D') || optionValue(args, '--pgdata'));
    }
    if (successfulSyncCall && commandName === 'pg_ctl' && args.includes('start')) {
      const serverOptions = optionValue(args, '-o') || '';
      rememberPostgresPath('socket', serverOptions.match(/(?:^|\s)-k\s+(\S+)/)?.[1]);
    }
    return result;
  };
}

if (active && !globalThis.__testIsolationBoundaryInstalled) {
  Object.defineProperty(globalThis, '__testIsolationBoundaryInstalled', {
    value: true,
    configurable: false,
  });

  globalThis.fetch = () => recordBlocked('fetch');

  http.request = () => recordBlocked('http.request');
  http.get = () => recordBlocked('http.get');
  https.request = () => recordBlocked('https.request');
  https.get = () => recordBlocked('https.get');
  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalSocketConnect = net.Socket.prototype.connect;
  net.connect = function guardedNetConnect(...args) {
    if (!isScopedUnixSocket(args)) return recordBlocked('net.connect');
    return originalNetConnect.apply(net, args);
  };
  net.createConnection = function guardedNetCreateConnection(...args) {
    if (!isScopedUnixSocket(args)) return recordBlocked('net.createConnection');
    return originalNetCreateConnection.apply(net, args);
  };
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    if (!isScopedUnixSocket(args)) return recordBlocked('net.Socket.connect');
    return originalSocketConnect.apply(this, args);
  };
  tls.connect = () => recordBlocked('tls.connect');

  const originalCreateSocket = dgram.createSocket;
  dgram.createSocket = function guardedCreateSocket(...args) {
    const socket = originalCreateSocket.apply(dgram, args);
    socket.bind = () => recordBlocked('dgram.Socket.bind');
    socket.connect = () => recordBlocked('dgram.Socket.connect');
    socket.send = () => recordBlocked('dgram.Socket.send');
    return socket;
  };

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const guarded = guardChildFunction(name, childProcess[name]);
    if (name === 'execFile') {
      // Node's original promisify.custom implementation closes over the
      // original, unguarded execFile. Recreate its result contract using the
      // guarded callback path instead of copying that bypass-capable function.
      Object.defineProperty(guarded, Symbol.for('nodejs.util.promisify.custom'), {
        configurable: true,
        value(command, args, options) {
          return new Promise((resolvePromise, rejectPromise) => {
            const callback = (error, stdout, stderr) => {
              if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                rejectPromise(error);
              } else {
                resolvePromise({ stdout, stderr });
              }
            };
            if (Array.isArray(args)) {
              guarded(command, args, options || {}, callback);
            } else {
              guarded(command, args || {}, callback);
            }
          });
        },
      });
    }
    childProcess[name] = guarded;
  }
  childProcess.exec = () => recordBlocked('child_process.exec');
  childProcess.execSync = () => recordBlocked('child_process.execSync');
  const originalFork = childProcess.fork;
  childProcess.fork = function guardedFork(modulePath, args, options) {
    return Array.isArray(args)
      ? originalFork.call(childProcess, modulePath, args, guardedChildOptions(options))
      : originalFork.call(childProcess, modulePath, guardedChildOptions(args));
  };
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class GuardedWorker extends OriginalWorker {
    constructor(filename, options) {
      if (isControlledEsbuildWorker(filename, options)) {
        super(filename, options);
        return;
      }
      return recordBlocked('worker_threads.Worker');
    }
  };

  syncBuiltinESMExports();
}

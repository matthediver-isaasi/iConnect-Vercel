import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runner = new URL('./run-isolated-tests.mjs', import.meta.url).pathname;

function runSource(source, extraArgs = []) {
  const directory = mkdtempSync(join(tmpdir(), 'isolation-boundary-test-'));
  const script = join(directory, 'probe.mjs');
  writeFileSync(script, source);
  try {
    return spawnSync(process.execPath, [runner, ...extraArgs, process.execPath, script], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('caught fetch and native child-process attempts still fail the run', () => {
  const result = runSource(`
    import { execFileSync } from 'node:child_process';
    try { await fetch('https://example.test'); } catch {}
    try { execFileSync('curl', ['https://example.test']); } catch {}
    console.log('probe completed');
  `);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /probe completed/);
  assert.match(result.stderr, /fetch/);
  assert.match(result.stderr, /child_process\.execFileSync/);
});

test('http, https, TCP, TLS and UDP paths are blocked', () => {
  const result = runSource(`
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import dgram from 'node:dgram';
    for (const attempt of [
      () => http.get('http://example.test'),
      () => https.request('https://example.test'),
      () => net.connect(443, 'example.test'),
      () => tls.connect(443, 'example.test'),
      () => dgram.createSocket('udp4').send('x', 53, '8.8.8.8'),
    ]) try { attempt(); } catch {}
  `);
  assert.equal(result.status, 1);
  for (const mechanism of ['http.get', 'https.request', 'net.connect', 'tls.connect', 'dgram.Socket.send']) {
    assert.match(result.stderr, new RegExp(mechanism.replace('.', '\\.')));
  }
});

test('controlled mocks remain usable without recording a blocked attempt', () => {
  const result = runSource(`
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ mocked: true }) });
    const response = await fetch('https://mock.invalid');
    if (!(await response.json()).mocked) process.exitCode = 2;
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('promisified execFile preserves stdout and stderr without bypassing the guard', () => {
  const result = runSource(`
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const output = await promisify(execFile)(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { encoding: 'utf8' },
    );
    if (output.stdout !== 'out' || output.stderr !== 'err') process.exitCode = 2;
    try { await promisify(execFile)('curl', ['https://example.test']); } catch {}
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /child_process\.execFile/);
});

test('local PostgreSQL opt-in does not permit an unregistered temp socket or localhost TCP', () => {
  const result = runSource(`
    import net from 'node:net';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    const socketPath = join(tmpdir(), 'isolation-boundary-' + process.pid + '.sock');
    try { net.createConnection({ path: socketPath }); } catch {}
    try { net.connect(5432, '127.0.0.1'); } catch {}
  `, ['--allow-local-postgres']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /net\.connect/);
  assert.match(result.stderr, /net\.createConnection/);
});

test('node children inherit the boundary and cannot hide caught attempts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'isolation-child-probe-'));
  const child = join(directory, 'child.mjs');
  const parent = join(directory, 'parent.mjs');
  writeFileSync(child, `try { await fetch('https://example.test'); } catch {}`);
  writeFileSync(parent, `
    import { spawnSync } from 'node:child_process';
    spawnSync(process.execPath, [${JSON.stringify(child)}], {
      stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  `);
  try {
    const result = spawnSync(process.execPath, [runner, process.execPath, parent], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fetch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker threads and shell-enabled children cannot bypass the boundary', () => {
  const result = runSource(`
    import { Worker } from 'node:worker_threads';
    import { spawnSync } from 'node:child_process';
    try { new Worker('fetch("https://example.test")', { eval: true }); } catch {}
    try { spawnSync(process.execPath, ['-e', '0'], { shell: true }); } catch {}
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worker_threads\.Worker/);
  assert.match(result.stderr, /child_process\.spawnSync\(shell\)/);
});

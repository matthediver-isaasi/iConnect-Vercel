import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';

const PROJECT = 'lvmzliemqnieeoruhkik';

// No credential values are returned to logs. Pin both independently supplied
// connections before any access; clones cannot satisfy this destination guard.
export function destinationConfig(restUrl, databaseUrl) {
  assert.equal(restUrl, `https://${PROJECT}.supabase.co`, 'Unapproved REST destination');
  if (!databaseUrl) throw Error('DEST_DATABASE_URL required; no fallback');
  const db = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(db.protocol), 'Invalid SQL protocol');
  const direct = db.hostname === `db.${PROJECT}.supabase.co` && db.username === 'postgres';
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname)
    && db.username === `postgres.${PROJECT}`;
  assert.ok(direct || pooler, 'Unapproved SQL destination');
  assert.ok(!db.search, 'SQL query parameters forbidden (including TLS overrides)');
  return { connectionString: databaseUrl };
}

export function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeComplete(fd, content) {
  const data = Buffer.from(content);
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw Error('Incomplete audit write');
    offset += written;
  }
  fsyncSync(fd);
}

export function durableFile(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeComplete(fd, content); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
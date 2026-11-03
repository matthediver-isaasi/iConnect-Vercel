import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('deployment trimming excludes only root evidence, not runtime report directories', () => {
  const rules = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  for (const root of ['reports', 'screenshots', '.agents']) {
    assert.ok(rules.includes(`/${root}/`));
    assert.ok(!rules.includes(`${root}/`), `${root} must be root anchored`);
    assert.ok(!rules.includes(`**/${root}/`));
  }
  for (const required of ['api/', 'api/_lib/', 'api/reports/', 'client/', 'scripts/', 'attached_assets/', 'shared/']) {
    assert.ok(!rules.includes(required) && !rules.includes(`/${required}`), required);
  }
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.match(config.buildCommand, /patch-cookieyes/);
  assert.match(config.buildCommand, /vite build/);
  assert.match(config.buildCommand, /build-cookie-preview/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Regression guard for the empty membership-structure dropdown.
//
// isConfigInEffect(config, onDate = todayStr()) defaults its second
// argument, so passing it BARE to an array method (filter/map/find/some/
// every) hands it the element index as onDate — "2026-07-29" <= 0 is
// false, silently dropping every dated config from activeConfigs while
// history (which calls it correctly) still reports them active.

const tiersSrc = fs.readFileSync(new URL('../membership/tiers.js', import.meta.url), 'utf8');

test('date-aware config helpers are never passed bare to array methods', () => {
  for (const helper of ['isConfigInEffect', 'configLifecycleStatus']) {
    const bare = new RegExp(`\\.(filter|map|find|findIndex|some|every)\\(${helper}\\)`);
    assert.ok(!bare.test(tiersSrc), `${helper} must be wrapped in an explicit lambda (c => ${helper}(c)) — array methods pass the index as its onDate argument`);
  }
});

test('activeConfigs filter keeps a dated, currently-in-effect config', () => {
  // Behavioral proof of the fix: replicate the helper and the endpoint's
  // filter call shape against a dated config.
  const todayStr = () => new Date().toISOString().split('T')[0];
  function isConfigInEffect(config, onDate = todayStr()) {
    if (!config) return false;
    const startsOk = !config.effective_from || config.effective_from <= onDate;
    const endsOk = config.effective_to === null || config.effective_to === undefined || config.effective_to >= onDate;
    return startsOk && endsOk;
  }
  const dated = { effective_from: '2000-01-01', effective_to: null };
  // The buggy shape drops it (documents WHY the lambda is required)…
  assert.deepEqual([dated].filter(isConfigInEffect), []);
  // …the fixed shape keeps it, and the endpoint uses the fixed shape.
  assert.deepEqual([dated].filter(c => isConfigInEffect(c)), [dated]);
  assert.match(tiersSrc, /const configs = all\.filter\(c => isConfigInEffect\(c\)\)/);
});

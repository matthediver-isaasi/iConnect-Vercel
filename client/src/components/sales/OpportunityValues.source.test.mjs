import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./OpportunitiesWorkspace.jsx', import.meta.url), 'utf8');

test('opportunities request independent converted values without changing pipeline net mode', () => {
  assert.match(source, /destination === "pipeline"\) params\.set\("moneyBasis", "net"\)/);
  assert.match(source, /else params\.set\("includeConverted", "true"\)/);
  assert.match(source, /"Net value \(excluding tax\)" : "Converted"/);
  assert.match(source, /netMoney\(item\.convertedValueMinor, item\.currency, item\.convertedValueSource\)/);
  assert.match(source, /destination !== "pipeline" && <th[^>]*>Forecasted value<\/th>/);
  assert.match(source, /item\.value_minor == null && item\.value == null \? "—" : money\(opportunityValue\(item\), item\.currency\)/);
});

test('creation and overview use the same Forecasted value label and retain existing save bindings', () => {
  assert.equal((source.match(/<Label>Forecasted value<\/Label>/g) || []).length, 2);
  assert.doesNotMatch(source, /<Label>Value<\/Label>|<Label>Net estimate \(excluding tax\)<\/Label>/);
  assert.match(source, /valueMinor: form\.value === "" \? null : Math\.round\(Number\(form\.value\) \* 100\)/);
});

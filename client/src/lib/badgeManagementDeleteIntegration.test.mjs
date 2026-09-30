import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../pages/BadgeManagement.jsx', import.meta.url), 'utf8');

test('Badge Management reports delete versus deactivate and refreshes the library', () => {
  assert.match(page, /result\?\.outcome === "deactivated" \? "Badge deactivated" : "Badge deleted"/);
  assert.match(page, /setDeleteTarget\(null\);[\s\S]*invalidate\(\);/);
  assert.match(page, /Referenced badges will be preserved and marked inactive/);
});
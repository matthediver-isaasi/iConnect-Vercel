import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const files = [
  'client/src/pages/MembershipTierManagement.jsx',
  'client/src/pages/MembershipSettings.jsx',
  'client/src/pages/CreateEvent.jsx',
  'client/src/pages/EditEvent.jsx',
  'client/src/pages/EventSettings.jsx',
  'client/src/pages/CreateComplexEvent.jsx',
  'client/src/components/events/ComplexEventTicketManager.jsx',
];

for (const file of files) {
  test(`${file}: provider tax choices never offer the built-in no-tax fallback`, async () => {
    const source = await readFile(file, 'utf8');
    await transform(source, { loader: 'jsx', format: 'esm' });
    assert.doesNotMatch(source, /<SelectItem[^>]*>\s*No VAT/);
    assert.doesNotMatch(source, /placeholder="No VAT"/);
    const placeholders = [...source.matchAll(/<SelectItem\s+value="(?:__none|_none|none)"([^>]*)>Not configured — select an accounting tax rate<\/SelectItem>/g)];
    assert.ok(placeholders.length > 0);
    for (const match of placeholders) assert.match(match[1], /\bdisabled\b/);
    assert.match(source, /rate\.taxType/);
    assert.match(source, /rate\.name/);
  });
}

test('flat-rate schedule shows missing accounting configuration even before rates are synced', async () => {
  const source = await readFile(files[0], 'utf8');
  assert.doesNotMatch(source, /availableVatRates\.length > 0 && \(\s*<div className="space-y-1 mt-3"/);
  assert.match(source, /No accounting tax rate is configured; review this before invoicing/);
});

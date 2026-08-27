import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'FloaterDisplay.jsx'), 'utf8');

test('floater form submissions use the public client submission contract', () => {
  assert.match(source, /return publicClient\.submitForm\(\{/);
  assert.match(source, /form_id: formId/);
  assert.match(source, /form_name: formName/);
  assert.match(source, /submission_data: data/);
  assert.doesNotMatch(source, /\.from\("form_submission"\)\s*\.insert/);
});

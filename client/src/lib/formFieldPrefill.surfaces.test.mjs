import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const surfaces = [
  '../pages/FormView.jsx',
  '../pages/EmbedForm.jsx',
  '../components/iedit/elements/IEditFormElement.jsx',
  '../components/ManualSubmissionDialog.jsx',
];

test('every form runtime uses the shared dropdown-prefill hook', async () => {
  for (const relativePath of surfaces) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /import\s+\{\s*useFormFieldPrefill\s*\}/);
    assert.match(source, /useFormFieldPrefill\s*\(\s*\{/);
  }
});

test('manual entry gates reactive requests to the open dialog', async () => {
  const source = await readFile(
    new URL('../components/ManualSubmissionDialog.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useFormFieldPrefill\s*\(\s*\{[\s\S]*?enabled:\s*open[\s\S]*?\}\s*\)/);
});
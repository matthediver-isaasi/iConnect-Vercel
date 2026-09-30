import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const selectSource = await readFile(
  new URL('./select.jsx', import.meta.url),
  'utf8',
);

test('shared select menus render above sticky application headers', () => {
  assert.match(selectSource, /relative z-\[60\] max-h-96/);
  assert.doesNotMatch(selectSource, /relative z-50 max-h-96/);
  assert.doesNotMatch(selectSource, /relative z-\[100\] max-h-96/);
});

test('shared select menus retain their portal and collision positioning', () => {
  assert.match(
    selectSource,
    /<SelectPrimitive\.Portal>[\s\S]*<SelectPrimitive\.Content/,
  );
  assert.match(selectSource, /position = "popper"/);
  assert.match(selectSource, /position=\{position\}/);
  assert.match(selectSource, /data-\[side=top\]:-translate-y-1/);
  assert.match(selectSource, /<SelectScrollUpButton \/>/);
  assert.match(selectSource, /<SelectScrollDownButton \/>/);
});
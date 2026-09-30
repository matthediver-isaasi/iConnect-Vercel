import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const rendererSource = await readFile(
  new URL('../components/forms/FormRenderer.jsx', import.meta.url),
  'utf8',
);
const builderSource = await readFile(
  new URL('../pages/FormBuilder.jsx', import.meta.url),
  'utf8',
);
const viewerSources = await Promise.all([
  readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../pages/EmbedForm.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/iedit/elements/IEditFormElement.jsx', import.meta.url), 'utf8'),
]);

test('FormRenderer applies the UTC future-date contract to native date inputs', () => {
  assert.match(rendererSource, /futureDateError/);
  assert.match(rendererSource, /tomorrowUtcDate/);
  assert.match(rendererSource, /min=\{futureDateMinimum\}/);
  assert.match(rendererSource, /aria-invalid=\{futureDateValidationError/);
  assert.match(rendererSource, /visibilitychange/);
  assert.match(rendererSource, /nextUtcMidnight/);
  assert.match(rendererSource, /setTimeout\(\(\) =>/);
  assert.match(rendererSource, /clearTimeout\(boundaryTimer\)/);
  assert.match(rendererSource, /futureDateValidityFieldId\.current/);
});

test('FormBuilder exposes future-only controls for top-level and repeatable dates', () => {
  assert.match(builderSource, /switch-future-only-\$\{field\.id\}/);
  assert.match(builderSource, /switch-repeatable-child-future-only-\$\{child\.id\}/);
  assert.match(builderSource, /tomorrowUtcDate\(\)/);
  assert.match(builderSource, /future_only === true/);
});

test('all submitting form viewers validate future dates before building submissions', () => {
  for (const source of viewerSources) {
    assert.match(source, /validateFutureDateFields/);
    assert.match(source, /hiddenFieldIds/);
    assert.match(source, /now: new Date\(\)/);
  }
});
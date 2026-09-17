import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editor = await readFile(new URL('./RepeatableRowVisibilityEditor.jsx', import.meta.url), 'utf8');
const builder = await readFile(new URL('../../pages/FormBuilder.jsx', import.meta.url), 'utf8');

test('repeatable row visibility editor exposes all supported modes and same-row source guidance', () => {
  assert.match(editor, /Always visible/);
  assert.match(editor, /Show when/);
  assert.match(editor, /Hide when/);
  assert.match(editor, /static,[\s\S]*single-select Dropdown or Select/);
  assert.match(editor, /repeatableRowVisibilitySources/);
  assert.match(editor, /repeatableRowVisibilityOptions/);
});

test('FormBuilder mounts the child visibility editor and validates its saved rules', () => {
  assert.match(builder, /<RepeatableRowVisibilityEditor/);
  assert.match(builder, /validateRepeatableRowVisibilityConfiguration\(container\)/);
  assert.match(builder, /has invalid visibility/);
});

test('FormBuilder save validation stays in the repeatable-field loop', () => {
  const handleSubmitStart = builder.indexOf('const handleSubmit = () =>');
  const repeatableLoopStart = builder.indexOf(
    'for (const container of (formData.fields || []).filter(isRepeatableRowField))',
    handleSubmitStart,
  );
  const visibilityValidation = builder.indexOf(
    'const visibilityErrors = validateRepeatableRowVisibilityConfiguration(container);',
    repeatableLoopStart,
  );
  const topLevelRulesStart = builder.indexOf(
    'for (const rule of formData.visibility_rules || [])',
    repeatableLoopStart,
  );
  assert.ok(handleSubmitStart >= 0, 'save handler should be present');
  assert.ok(repeatableLoopStart > handleSubmitStart, 'repeatable save loop should be in save handler');
  assert.ok(visibilityValidation > repeatableLoopStart, 'visibility validation should run for repeatable containers');
  assert.ok(visibilityValidation < topLevelRulesStart, 'visibility validation should run before top-level rules');

  const topLevelRulesEnd = builder.indexOf(
    '// Task #3483: generic Payment fields',
    topLevelRulesStart,
  );
  const topLevelRulesBlock = builder.slice(topLevelRulesStart, topLevelRulesEnd);
  assert.doesNotMatch(topLevelRulesBlock, /validateRepeatableRowVisibilityConfiguration\(container\)/);
  assert.doesNotMatch(topLevelRulesBlock, /\bcontainer\b/);
  assert.doesNotMatch(topLevelRulesBlock, /\bchildren\b/);
});

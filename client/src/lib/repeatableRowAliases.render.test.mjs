import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRepeatableRowField } from '../../../shared/formRepeatableRows.js';
import { formatRepeatableRows } from '../../../shared/repeatableFormRowsFormat.js';

const aliases = ['repeatable_row', 'repeatable_grid'];

test('shared repeatable aliases are recognized and produce table rows', () => {
  for (const type of aliases) {
    const field = {
      id: `${type}-field`,
      type,
      repeatable_row: { children: [{ id: 'name', type: 'text', label: 'Name' }] },
    };
    assert.equal(isRepeatableRowField(field), true);
    const model = formatRepeatableRows(field, [{ _row_id: 'one', name: 'Ada' }]);
    assert.deepEqual(model.columns.map(column => [column.id, column.label]), [['name', 'Name']]);
    assert.deepEqual(model.rows, [{ rowId: 'one', cells: ['Ada'] }]);
  }
});

test('respondent and submission surfaces dispatch aliases through shared repeatable checks', () => {
  const renderer = readFileSync(new URL('../components/forms/FormRenderer.jsx', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../pages/FormSubmissionView.jsx', import.meta.url), 'utf8');
  const list = readFileSync(new URL('../pages/FormSubmissions.jsx', import.meta.url), 'utf8');
  assert.match(renderer, /isRepeatableRowField\(field\)[\s\S]*?return renderRepeatableRows\(\)/);
  assert.match(renderer, /case 'repeatable_rows':\s*return renderRepeatableRows\(\)/);
  assert.match(detail, /isRepeatableRowField\(field\)[\s\S]*?<RepeatableRowsTable/);
  assert.match(list, /isRepeatableRowField\(fieldDef\)[\s\S]*?formatRepeatableRowsText/);
  assert.match(list, /isRepeatableRowField\(field\)[\s\S]*?<RepeatableRowsTable/);
});
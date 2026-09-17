import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCurrentSetFormValues,
  currentSetMetadata,
  DEPARTMENT_CURRENT_SET_METADATA_KEY,
  DepartmentCurrentSetError,
  DEPARTMENT_CURRENT_SET_FORM_ID,
  DEPARTMENT_CURRENT_SET_TENANT_ID,
  rpcError,
} from './departmentCurrentSet.js';

const config = {
  workforce_container_field_id: 'workforce',
  equipment_container_field_id: 'equipment',
};
const departmentId = '11111111-1111-4111-8111-111111111111';

test('current set needs complete metadata and both explicit arrays', () => {
  const values = {
    ...currentSetMetadata({ departmentId, version: 'version', completeSections: ['workforce', 'equipment'] }),
    workforce: [], equipment: [],
  };
  assert.deepEqual(assertCurrentSetFormValues({ values, configuration: config }), {
    departmentId, version: 'version', workforce: [], equipment: [],
  });
  assert.equal(values[DEPARTMENT_CURRENT_SET_METADATA_KEY].department_id, departmentId);
});

test('current set refuses omission so a failed/hidden section cannot clear', () => {
  assert.throws(() => assertCurrentSetFormValues({
    values: { workforce: [], [DEPARTMENT_CURRENT_SET_METADATA_KEY]: { department_id: departmentId, version: 'v', complete_sections: ['workforce'] } },
    configuration: config,
  }), error => error instanceof DepartmentCurrentSetError && error.code === 'CURRENT_SET_INCOMPLETE');
});

test('BNMS current-set integration has immutable destination identifiers', () => {
  assert.equal(DEPARTMENT_CURRENT_SET_FORM_ID, '8b6f44d3-83f8-449e-9496-b10b1dc28e5f');
  assert.equal(DEPARTMENT_CURRENT_SET_TENANT_ID, 'ff2df806-b321-4254-b651-3af11fccf1db');
});

test('transaction retry and deadlock failures return a clear current-set conflict', () => {
  for (const code of ['40001', '40P01']) {
    const error = rpcError({ code, message: 'deadlock detected' });
    assert.equal(error.status, 409);
    assert.equal(error.code, 'CURRENT_SET_CONFLICT');
    assert.match(error.message, /reload and review/i);
  }
});
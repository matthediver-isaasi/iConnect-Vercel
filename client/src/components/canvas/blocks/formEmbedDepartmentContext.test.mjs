import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardCanvasDepartmentContext } from './formEmbedDepartmentContext.js';

const departmentId = 'db0587fd-ea58-44ac-9942-ddeef0413a3e';

test('forwards only a valid Department UUID into a Canvas form embed URL', () => {
  const params = new URLSearchParams('font=Inter');
  forwardCanvasDepartmentContext(
    params,
    `?department_id=${departmentId}&draft=secret&payment_intent=pi_secret&other=value`,
  );

  assert.equal(params.get('department_id'), departmentId);
  assert.equal(params.get('font'), 'Inter');
  assert.equal(params.has('draft'), false);
  assert.equal(params.has('payment_intent'), false);
  assert.equal(params.has('other'), false);
});

test('does not forward malformed Department context', () => {
  const params = new URLSearchParams();
  assert.equal(forwardCanvasDepartmentContext(params, '?department_id=not-a-uuid'), null);
  assert.equal(params.has('department_id'), false);
});
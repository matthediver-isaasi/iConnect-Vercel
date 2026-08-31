import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSalesDestination,
  getVisibleSalesDestinations,
  SALES_DESTINATIONS,
} from './salesNavigation.js';

test('each Sales destination has its own page permission and route', () => {
  assert.equal(SALES_DESTINATIONS.length, 9);
  assert.equal(
    new Set(SALES_DESTINATIONS.map(({ permissionId }) => permissionId)).size,
    SALES_DESTINATIONS.length,
  );
  for (const destination of SALES_DESTINATIONS) {
    assert.equal(destination.permissionId, `sales.${destination.key}`);
    assert.equal(destination.path, `/sales/${destination.key}`);
  }
});

test('Sales navigation is hidden when baseline Sales access is excluded', () => {
  const visible = getVisibleSalesDestinations((id) => id === 'sales.view');
  assert.deepEqual(visible, []);
});

test('Sales navigation independently removes excluded destinations', () => {
  const visible = getVisibleSalesDestinations(
    (id) => id === 'sales.quotes' || id === 'sales.settings',
  );
  assert.equal(visible.length, 7);
  assert.equal(visible.some(({ key }) => key === 'quotes'), false);
  assert.equal(visible.some(({ key }) => key === 'settings'), false);
  assert.equal(getSalesDestination('pipeline')?.permissionId, 'sales.pipeline');
});

test('excluding Dashboard does not hide other permitted Sales destinations', () => {
  const visible = getVisibleSalesDestinations((id) => id === 'sales.dashboard');
  assert.equal(visible.length, 8);
  assert.equal(visible.some(({ key }) => key === 'dashboard'), false);
  assert.equal(visible.some(({ key }) => key === 'pipeline'), true);
});
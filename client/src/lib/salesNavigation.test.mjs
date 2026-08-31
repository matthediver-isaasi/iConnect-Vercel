import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSalesDestination,
  getVisibleSalesDestinations,
  SALES_DESTINATIONS,
} from './salesNavigation.js';

test('each Sales destination has its own page permission and route', () => {
  assert.ok(SALES_DESTINATIONS.length >= 9);
  for (const destination of SALES_DESTINATIONS) {
    assert.ok(destination.permissionId.startsWith('sales.'));
    assert.equal(destination.path, `/sales/${destination.key}`);
  }
  for (const key of ['pipeline', 'opportunities', 'settings']) {
    assert.equal(getSalesDestination(key)?.permissionId, `sales.${key}`);
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
  assert.equal(visible.length, SALES_DESTINATIONS.length - 2);
  assert.equal(visible.some(({ key }) => key === 'quotes'), false);
  assert.equal(visible.some(({ key }) => key === 'settings'), false);
  assert.equal(getSalesDestination('pipeline')?.permissionId, 'sales.pipeline');
});

test('excluding Dashboard does not hide other permitted Sales destinations', () => {
  const visible = getVisibleSalesDestinations((id) => id === 'sales.dashboard');
  assert.equal(visible.length, SALES_DESTINATIONS.length - 1);
  assert.equal(visible.some(({ key }) => key === 'dashboard'), false);
  assert.equal(visible.some(({ key }) => key === 'pipeline'), true);
});
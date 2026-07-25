import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikePoReference,
  extractPoFromReference,
  resolvePoCandidate,
  isPlaceholderPoValue,
  buildMembershipPoMaps,
  findMembershipPoForRecord,
} from './pendingPoInvoice.js';

test('extractPoFromReference extracts PO from our membership reference convention', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026 - PO: test2407'), 'test2407');
  assert.equal(extractPoFromReference('Membership 2026/27 - PO: PO-00123'), 'PO-00123');
  assert.equal(extractPoFromReference('PO: ABC123'), 'ABC123');
});

test('extractPoFromReference rejects placeholder junk values', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026 - PO: TBC'), null);
  assert.equal(extractPoFromReference('PO: TBC'), null);
  assert.equal(extractPoFromReference('PO: n/a'), null);
  assert.equal(extractPoFromReference('PO: pending'), null);
  assert.equal(extractPoFromReference('PO: '), null);
  assert.equal(extractPoFromReference('PO: -'), null);
});

test('extractPoFromReference returns null for purely descriptive references', () => {
  assert.equal(extractPoFromReference('Membership 2025/2026'), null);
  assert.equal(extractPoFromReference('Training Fund top-up'), null);
  assert.equal(extractPoFromReference(''), null);
  assert.equal(extractPoFromReference(null), null);
});

test('looksLikePoReference still rejects descriptive/placeholder references', () => {
  assert.equal(looksLikePoReference('Membership 2025/2026'), false);
  assert.equal(looksLikePoReference('Membership 2025/2026 - PO: test2407'), false);
  assert.equal(looksLikePoReference('Training Fund top-up'), false);
  assert.equal(looksLikePoReference('TBC'), false);
  assert.equal(looksLikePoReference('PO12345'), true);
});

test('resolvePoCandidate prefers a real PO value and falls back to embedded extraction', () => {
  assert.equal(resolvePoCandidate('PO9999', 'Membership 2025/2026'), 'PO9999');
  assert.equal(resolvePoCandidate(null, 'Membership 2025/2026 - PO: test2407'), 'test2407');
  assert.equal(resolvePoCandidate('', 'Membership 2025/2026'), null);
  assert.equal(resolvePoCandidate(null, 'Training Fund top-up'), null);
  assert.equal(resolvePoCandidate(null, 'PO: TBC'), null);
});

test('isPlaceholderPoValue', () => {
  assert.equal(isPlaceholderPoValue('TBC'), true);
  assert.equal(isPlaceholderPoValue(' n/a '), true);
  assert.equal(isPlaceholderPoValue('test2407'), false);
});

test('membership-row PO propagates to a sibling training fund row on the same invoice', () => {
  const historyRows = [{
    id: 'h1',
    purchase_order_number: 'test2407',
    xero_invoice_id: 'inv-uuid-1',
    xero_invoice_number: 'SI-44584',
    accounting_invoice_id: 'inv-uuid-1',
    accounting_invoice_number: 'SI-44584',
  }];
  const maps = buildMembershipPoMaps(historyRows);
  const tfRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: 'inv-uuid-1',
    xero_invoice_number: 'SI-44584',
  };
  assert.equal(findMembershipPoForRecord(tfRecord, maps), 'test2407');
  // Match by accounting_* columns too (QBO dual-column gotcha).
  const qboRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: null,
    accounting_invoice_id: 'inv-uuid-1',
  };
  assert.equal(findMembershipPoForRecord(qboRecord, maps), 'test2407');
  // Match by invoice number when ids are absent.
  const numRecord = { entityType: 'booking', xero_invoice_number: 'SI-44584' };
  assert.equal(findMembershipPoForRecord(numRecord, maps), 'test2407');
});

test('regression: top-up with descriptive reference and no PO anywhere stays visible', () => {
  // No membership row carries a PO for this invoice.
  const maps = buildMembershipPoMaps([{
    id: 'h2',
    purchase_order_number: null,
    xero_invoice_id: 'inv-uuid-2',
    xero_invoice_number: 'SI-99999',
  }]);
  const tfRecord = {
    entityType: 'training_fund_purchase',
    xero_invoice_id: 'inv-uuid-2',
    xero_invoice_number: 'SI-99999',
  };
  assert.equal(findMembershipPoForRecord(tfRecord, maps), null);
  // And the Xero reference path also keeps it visible.
  assert.equal(resolvePoCandidate(null, 'Training Fund top-up'), null);
});

test('placeholder PO on a membership row never propagates', () => {
  const maps = buildMembershipPoMaps([{
    id: 'h3',
    purchase_order_number: 'TBC',
    xero_invoice_id: 'inv-uuid-3',
  }]);
  assert.equal(findMembershipPoForRecord({ xero_invoice_id: 'inv-uuid-3' }, maps), null);
});

test('records with no matching invoice keys are untouched', () => {
  const maps = buildMembershipPoMaps([{
    id: 'h4',
    purchase_order_number: 'PO777',
    xero_invoice_id: 'inv-uuid-4',
  }]);
  assert.equal(findMembershipPoForRecord({ xero_invoice_id: 'other' }, maps), null);
  assert.equal(findMembershipPoForRecord({}, maps), null);
});

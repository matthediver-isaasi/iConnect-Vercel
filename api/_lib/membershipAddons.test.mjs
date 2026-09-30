// Tests for membership invoice add-on line items (Task: add-on lines).
//
// Covers the pure helpers in membershipAddons.js plus the billing invariant
// used by the renewal cron: the stored history record's final_cost includes
// the addon subtotal, and the membership fee line on the invoice is derived
// by subtracting it back out — so membership line + addon lines must always
// sum to the stored final_cost (no under- or over-billing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAddonLines,
  computeAddonTotals,
  buildExtraLineItems,
} from './membershipAddons.js';

const SETTINGS = {
  enabled: true,
  trainingFundEnabled: true,
  freeformEnabled: true,
  trainingFundNominalCode: '210',
  trainingFundVatRate: { taxType: 'OUTPUT2', name: 'Standard 20%', effectiveRate: 20 },
};

test('validateAddonLines: empty / null input is valid and yields no lines', () => {
  assert.deepEqual(validateAddonLines(null, SETTINGS), { valid: true, lines: [] });
  assert.deepEqual(validateAddonLines([], SETTINGS), { valid: true, lines: [] });
});

test('validateAddonLines: rejects when add-ons are disabled', () => {
  const res = validateAddonLines(
    [{ type: 'freeform', description: 'X', nominalCode: '200', unitCost: 10, quantity: 1 }],
    { ...SETTINGS, enabled: false }
  );
  assert.equal(res.valid, false);
});

test('validateAddonLines: rejects disabled sub-type', () => {
  const res = validateAddonLines(
    [{ type: 'training_fund', unitCost: 100, quantity: 1 }],
    { ...SETTINGS, trainingFundEnabled: false }
  );
  assert.equal(res.valid, false);
});

test('validateAddonLines: training fund lines are FORCED to tenant defaults', () => {
  const res = validateAddonLines(
    [{
      type: 'training_fund',
      description: 'Training Fund top-up',
      // Client-sent values must be ignored:
      nominalCode: '999',
      vatRate: { taxType: 'NONE', name: 'No VAT', effectiveRate: 0 },
      unitCost: 250,
      quantity: 1,
    }],
    SETTINGS
  );
  assert.equal(res.valid, true);
  assert.equal(res.lines[0].nominal_code, '210');
  assert.equal(res.lines[0].vat_rate.taxType, 'OUTPUT2');
  assert.equal(res.lines[0].vat_rate.effectiveRate, 20);
  assert.equal(res.lines[0].line_total, 250);
});

test('validateAddonLines: freeform requires description + nominal, positive amounts', () => {
  assert.equal(validateAddonLines([{ type: 'freeform', description: '', nominalCode: '200', unitCost: 10, quantity: 1 }], SETTINGS).valid, false);
  assert.equal(validateAddonLines([{ type: 'freeform', description: 'A', nominalCode: '', unitCost: 10, quantity: 1 }], SETTINGS).valid, false);
  assert.equal(validateAddonLines([{ type: 'freeform', description: 'A', nominalCode: '200', unitCost: 0, quantity: 1 }], SETTINGS).valid, false);
  assert.equal(validateAddonLines([{ type: 'freeform', description: 'A', nominalCode: '200', unitCost: 10, quantity: 0 }], SETTINGS).valid, false);
  assert.equal(validateAddonLines([{ type: 'freeform', description: 'A', nominalCode: '200', unitCost: 10, quantity: 1.5 }], SETTINGS).valid, false);
});

test('validateAddonLines: computes rounded line totals and accepts snake_case', () => {
  const res = validateAddonLines(
    [{ type: 'freeform', description: 'Badges', nominal_code: '220', unit_cost: 3.333, quantity: 3 }],
    SETTINGS
  );
  assert.equal(res.valid, true);
  assert.equal(res.lines[0].unit_cost, 3.33);
  assert.equal(res.lines[0].line_total, 9.99);
});

test('computeAddonTotals: subtotal, VAT from effectiveRate, rounding', () => {
  const totals = computeAddonTotals([
    { line_total: 100, vat_rate: { effectiveRate: 20 } },
    { line_total: 50.55, vat_rate: null },
  ]);
  assert.equal(totals.subtotal, 150.55);
  assert.equal(totals.vat, 20);
  assert.equal(totals.total, 170.55);
});

test('buildExtraLineItems maps stored shape to provider shape', () => {
  const items = buildExtraLineItems([
    { description: 'TF', nominal_code: '210', vat_rate: { taxType: 'OUTPUT2' }, unit_cost: 250, quantity: 1 },
  ]);
  assert.deepEqual(items, [
    { description: 'TF', nominalCode: '210', vatRate: { taxType: 'OUTPUT2' }, unitCost: 250, quantity: 1 },
  ]);
});

// --- Scheduled-renewal billing invariant -----------------------------------
// The cron bakes addon totals into the stored record at creation time and
// marks the notes with "add-on line(s) included". invoiceExistingRecord later
// derives the membership fee line as final_cost - addon subtotal ONLY when
// that marker is present. This mirrors that arithmetic and asserts the
// invoice (membership line + addon lines) always sums to the stored total.

function deriveMembershipFeeCost(record, addonLines) {
  const addonTotals = computeAddonTotals(addonLines);
  const addonsBaked = /add-on line\(s\) included/.test(record.notes || '');
  return addonsBaked
    ? Math.max(0, Math.round((record.final_cost - addonTotals.subtotal) * 100) / 100)
    : Math.round(record.final_cost * 100) / 100;
}

test('scheduled flow: record baked with add-ons → membership line + add-ons = stored final_cost', () => {
  const addonLines = [
    { type: 'training_fund', line_total: 250, vat_rate: { effectiveRate: 20 } },
    { type: 'freeform', line_total: 30, vat_rate: null },
  ];
  const baseFee = 1200;
  const addonTotals = computeAddonTotals(addonLines);
  const record = {
    final_cost: baseFee + addonTotals.subtotal, // baked at creation
    notes: 'Scheduled renewal via cron job (year 2, go-live: 2026-01-01). 2 add-on line(s) included.',
  };
  const membershipFee = deriveMembershipFeeCost(record, addonLines);
  assert.equal(membershipFee, baseFee);
  assert.equal(
    Math.round((membershipFee + addonTotals.subtotal) * 100) / 100,
    record.final_cost
  );
});

test('scheduled flow: legacy record WITHOUT bake marker never has add-ons subtracted (no underbilling)', () => {
  const addonLines = [{ type: 'training_fund', line_total: 250, vat_rate: null }];
  const record = {
    final_cost: 1200, // stored WITHOUT add-ons
    notes: 'Scheduled renewal via cron job (year 2, go-live: 2026-01-01)',
  };
  const membershipFee = deriveMembershipFeeCost(record, addonLines);
  assert.equal(membershipFee, 1200); // full fee retained
});

test('scheduled flow: membership fee never goes negative', () => {
  const addonLines = [{ type: 'freeform', line_total: 500, vat_rate: null }];
  const record = { final_cost: 300, notes: '1 add-on line(s) included.' };
  assert.equal(deriveMembershipFeeCost(record, addonLines), 0);
});

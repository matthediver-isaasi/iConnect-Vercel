import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configToFormState,
  formStateToConfig,
  resolveSpeakerAwardFormValue,
} from './speakerAwardsConfig.js';

test('configuration round-trips defaults, overrides, exclusions and stored timestamps', () => {
  const form = configToFormState({
    enabled: true,
    default: { voucher_value: 100, voucher_expiry: '2027-01-31T12:00:00Z', badge_id: 'b1' },
    overrides: {
      s1: { voucher_value: 50, voucher_expiry: '2027-02-01', badge_id: 'b2' },
      s2: { excluded: true },
    },
  });
  assert.equal(form.default.voucher_value, '100');
  assert.equal(form.default.voucher_expiry, '2027-01-31');
  assert.deepEqual(form.overrides.s2, { excluded: true });
  assert.deepEqual(formStateToConfig(form), {
    enabled: true,
    default: { voucher_value: 100, voucher_expiry: '2027-01-31', badge_id: 'b1' },
    overrides: {
      s1: { voucher_value: 50, voucher_expiry: '2027-02-01', badge_id: 'b2' },
      s2: { excluded: true },
    },
  });
});

test('disabled configuration persists as null and empty overrides are omitted', () => {
  assert.equal(formStateToConfig(configToFormState(null)), null);
  const state = configToFormState({ enabled: true, default: {}, overrides: { s1: {} } });
  assert.deepEqual(formStateToConfig(state).overrides, {});
});

test('override values take precedence while blank fields inherit defaults', () => {
  const state = configToFormState({
    enabled: true,
    default: { voucher_value: 100, voucher_expiry: '2027-01-31', badge_id: 'b1' },
    overrides: { s1: { voucher_value: 50 }, s2: { excluded: true } },
  });
  assert.deepEqual(resolveSpeakerAwardFormValue(state, 's1'), {
    voucher_value: '50', voucher_expiry: '2027-01-31', badge_id: 'b1',
  });
  assert.deepEqual(resolveSpeakerAwardFormValue(state, 's2'), { excluded: true });
});
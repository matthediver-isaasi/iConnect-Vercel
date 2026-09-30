import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../pages/EventSettings.jsx'), 'utf8');

test('event payment method settings load through the shared default-on policy', () => {
  assert.match(source, /const \[allowVoucherPayment, setAllowVoucherPayment\] = useState\(true\)/);
  assert.match(source, /const \[allowTrainingFundPayment, setAllowTrainingFundPayment\] = useState\(true\)/);
  assert.match(source, /resolveEventPaymentPolicy\(settings\)/);
  assert.match(source, /setAllowVoucherPayment\(eventPaymentPolicy\.allowVoucherPayment\)/);
  assert.match(source, /setAllowTrainingFundPayment\(eventPaymentPolicy\.allowTrainingFundPayment\)/);
});

test('event payment method settings are independently persisted under tenant setting keys', () => {
  for (const [key, state] of [
    ['event_allow_voucher_payment', 'allowVoucherPayment'],
    ['event_allow_training_fund_payment', 'allowTrainingFundPayment'],
  ]) {
    const keyOccurrences = source.match(new RegExp(key, 'g')) || [];
    assert.ok(keyOccurrences.length >= 2, `${key} must be handled for both existing and new settings`);
    assert.match(source, new RegExp(`setting_value: ${state}\\.toString\\(\\)`));
  }
  assert.match(source, /invalidateQueries\(\{ queryKey: \['system-settings'\] \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \['public-system-settings'\] \}\)/);
});

test('event payment methods have separate labelled switches and cannot save before settings load', () => {
  assert.match(source, /<CardTitle>Event Payment Methods<\/CardTitle>/);
  assert.match(source, /Allow voucher payment/);
  assert.match(source, /Allow training fund payment/);
  assert.match(source, /data-testid="switch-event-allow-voucher-payment"/);
  assert.match(source, /data-testid="switch-event-allow-training-fund-payment"/);
  assert.match(
    source,
    /disabled=\{isSaving \|\| loadingSettings \|\| settingsLoadFailed\}[\s\S]*?data-testid="button-save-event-payment-methods"/,
  );
  assert.match(source, /if \(loadingSettings \|\| settingsLoadFailed\)/);
  assert.match(source, /Payment method settings could not be loaded/);
});
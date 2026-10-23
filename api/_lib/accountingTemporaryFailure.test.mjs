import test from 'node:test';
import assert from 'node:assert/strict';
import { isTemporaryAccountingFailure } from './accountingTemporaryFailure.js';
test('temporary provider and transport errors are exempt, conflicts and validation are not', () => {
  for (const status of [408,429,500,502,503,504]) assert.equal(isTemporaryAccountingFailure({status}),true);
  for (const status of [400,401,403,404,409,422]) assert.equal(isTemporaryAccountingFailure({status}),false);
  for (const code of ['ACCOUNTING_TRANSPORT_TIMEOUT','FORM_ACCOUNTING_DEADLINE_EXPIRED','ETIMEDOUT','ECONNRESET','EAI_AGAIN'])
    assert.equal(isTemporaryAccountingFailure({code}),true);
  assert.equal(isTemporaryAccountingFailure(new TypeError('fetch failed')),true);
  assert.equal(isTemporaryAccountingFailure(new Error('Invoice identity conflict')),false);
});

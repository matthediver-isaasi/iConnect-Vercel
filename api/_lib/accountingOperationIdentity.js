import { createHash } from 'node:crypto';

/**
 * Provider-safe, collision-resistant identity derived from the complete
 * application operation key. Hashing (rather than truncating) ensures UUID
 * and PaymentIntent tails remain part of the identity.
 */
export function accountingOperationIdentity(operationKey, suffix, maxLength) {
  const source = String(operationKey || '');
  if (!source) throw new Error('operationKey is required');
  const label = String(suffix || 'op').replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = createHash('sha256').update(`${label}\0${source}`, 'utf8').digest('base64url');
  const result = `${label}-${digest}`;
  if (!Number.isSafeInteger(maxLength) || maxLength < result.length) {
    throw new Error(`Provider operation-key limit ${maxLength} is too short for a safe identity`);
  }
  return result;
}
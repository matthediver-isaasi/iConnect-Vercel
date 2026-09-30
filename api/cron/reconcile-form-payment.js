import { createFormPaymentReconciliationHandler } from './reconcile-form-payments.js';

// Separate path deliberately returns 404 on older preview deployments rather
// than allowing an unrecognised filter to execute the cross-tenant sweep.
export default createFormPaymentReconciliationHandler({ targetedOnly: true });
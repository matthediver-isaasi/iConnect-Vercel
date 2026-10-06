// Isolated mounted-test entry: the real shared renderer, hooks and payment
// boundary share one module/context instance. No app auth fixture or bypass.
export { default as FormPrefillBoundary } from '../components/forms/FormPrefillBoundary';
export { default as FormRenderer } from '../components/forms/FormRenderer';
export { default as FormPaymentSubmit } from '../components/forms/FormPaymentSubmit';
export { publicClient } from '../api/publicClient';
export { useFormFieldPrefill, useConditionalFormFieldPrefillState } from './useFormFieldPrefill';
export { useDepartmentCurrentSet } from './departmentCurrentSet';
export { initialPrefillState, combinePrefillStates } from './formPrefillBarrier';

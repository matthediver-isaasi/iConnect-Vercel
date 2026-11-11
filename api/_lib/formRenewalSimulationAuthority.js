// In-process only: never accepted from JSON/request options. The form renewal
// evidence resolver issues this after validating the selected successor.
export const FORM_RENEWAL_SIMULATION_AUTHORITY = Symbol('validated-form-renewal');

import { validateStripeAddressMappings } from '../../shared/formStripeAddressMappings.js';

export async function validateFormStripeAddressMappingConfig({
  supabase,
  tenantId,
  form,
}) {
  const fields = [];
  const visitFields = candidates => {
    for (const field of candidates || []) {
      if (!field || typeof field !== 'object') continue;
      fields.push(field);
      for (const key of ['fields', 'children', 'row_fields', 'sub_fields']) {
        if (Array.isArray(field[key])) visitFields(field[key]);
      }
    }
  };
  visitFields(Array.isArray(form?.fields) ? form.fields : []);
  const prohibitedField = fields.find(field => (
    field?.type === 'membership_payment'
    && Object.prototype.hasOwnProperty.call(field, 'stripe_billing_address_mappings')
  ));
  if (prohibitedField) {
    return {
      ok: false,
      code: 'INVALID_STRIPE_ADDRESS_MAPPINGS',
      error: 'Stripe billing address mappings are only supported on Payment fields.',
      details: ['Membership Payment fields cannot define Stripe billing address mappings.'],
    };
  }
  const paymentFields = fields.filter(field => field?.type === 'payment');
  if (!paymentFields.some(field => Object.prototype.hasOwnProperty.call(field, 'stripe_billing_address_mappings'))) {
    return { ok: true, form };
  }

  const { data: customFields, error } = await supabase
    .from('preference_field')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);
  if (error) {
    throw new Error(`Failed to validate Stripe address destinations: ${error.message}`);
  }

  for (const field of paymentFields) {
    const result = validateStripeAddressMappings({
      form,
      mappings: field.stripe_billing_address_mappings,
      customFields: customFields || [],
    });
    if (!result.valid) {
      return {
        ok: false,
        code: 'INVALID_STRIPE_ADDRESS_MAPPINGS',
        error: result.errors[0],
        details: result.errors,
      };
    }
  }
  return { ok: true, form };
}

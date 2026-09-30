import {
  addressLookupVisibleComponents,
  addressLookupRequiredComponents,
  normalizeAddressLookupAddress,
  normalizeUkPostcode,
} from '../../shared/formAddressLookup.js';

export { normalizeUkPostcode };

export function normalizeIdealPostcodesAddress(result) {
  const address = normalizeAddressLookupAddress({
    line_1: result?.line_1,
    line_2: result?.line_2,
    line_3: result?.line_3,
    post_town: result?.post_town,
    county: result?.county,
    postcode: result?.postcode,
    country: result?.country || 'United Kingdom',
  });
  return address?.line_1 && address?.postcode ? address : null;
}

export async function lookupIdealPostcodes(postcode, apiKey, fetchImpl = fetch) {
  const url = new URL(`https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(postcode)}`);
  url.searchParams.set('api_key', apiKey);
  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const error = new Error(`Ideal Postcodes request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const results = Array.isArray(payload?.result) ? payload.result : [];
  return results.slice(0, 100).map(normalizeIdealPostcodesAddress).filter(Boolean);
}

export function invalidRequiredAddressLookupFields(fields = [], submissionData = {}, hiddenFieldIds = new Set()) {
  const invalid = [];
  for (const field of fields) {
    if (field?.type !== 'address_lookup' || hiddenFieldIds.has(String(field.id))) continue;
    const answer = normalizeAddressLookupAddress(submissionData?.[field.id]);
    const required = addressLookupRequiredComponents(field);
    const hasAnyAnswer = answer && addressLookupVisibleComponents(field)
      .some(component => Boolean(answer[component]));
    if (!field.required && !hasAnyAnswer) continue;
    if (
      (field.required && !hasAnyAnswer)
      || (required.length > 0 && required.some(component => !answer?.[component]))
    ) {
      invalid.push(field.id);
    }
  }
  return invalid;
}
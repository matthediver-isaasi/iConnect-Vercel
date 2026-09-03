import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ADDRESS_LOOKUP_COMPONENTS,
  addressLookupRequiredComponents,
  addressLookupVisibleComponents,
  normalizeAddressLookupAnswer,
  normalizeAddressLookupResult,
} from "../../../../shared/formAddressLookup.js";

const componentLabels = {
  line_1: 'Address line 1',
  line_2: 'Address line 2',
  line_3: 'Address line 3',
  post_town: 'City / town',
  county: 'County / region',
  postcode: 'Postcode',
  country: 'Country',
};

const responseAddresses = response => {
  const candidate = response?.addresses || response?.results || response?.data?.addresses || response?.data?.results || [];
  return Array.isArray(candidate) ? candidate.map(normalizeAddressLookupResult) : [];
};

export default function AddressLookupField({ field, value, onChange, disabled, formId, formSlug }) {
  const answer = normalizeAddressLookupAnswer(value);
  const visible = addressLookupVisibleComponents(field);
  const required = addressLookupRequiredComponents(field);
  const [postcode, setPostcode] = useState(answer.postcode);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [lookupUnavailable, setLookupUnavailable] = useState(false);
  const manualAllowed = field.manual_entry !== false && field.allow_manual_entry !== false;
  const labelFor = component => field.component_labels?.[component] || componentLabels[component];

  const update = (component, next) => onChange({
    ...answer,
    [component]: next,
  });
  const search = async () => {
    const normalizedPostcode = postcode.trim();
    if (!normalizedPostcode || disabled) return;
    setLoading(true);
    setError('');
    setLookupUnavailable(false);
    setResults([]);
    try {
      const response = await fetch('/api/public/address-lookup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postcode: normalizedPostcode,
          form_id: formId,
          form_slug: formSlug,
          field_id: field.id,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Address lookup is currently unavailable.');
      const addresses = responseAddresses(body);
      setResults(addresses);
      if (addresses.length === 0) setError('No addresses were found for that postcode.');
    } catch (lookupError) {
      setError(lookupError.message || 'Address lookup is currently unavailable.');
      setLookupUnavailable(true);
    } finally {
      setLoading(false);
    }
  };
  const selectAddress = selected => {
    const next = { ...normalizeAddressLookupResult(selected), postcode: selected.postcode || postcode.trim() };
    onChange(next);
    setPostcode(next.postcode);
    setResults([]);
    setManual(true);
  };

  return (
    <div className="space-y-3" data-testid={`address-lookup-${field.id}`}>
      <div className="flex gap-2">
        <Input
          value={postcode}
          onChange={event => setPostcode(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); search(); } }}
          placeholder="Enter a UK postcode"
          disabled={disabled || loading}
          data-testid={`input-address-lookup-postcode-${field.id}`}
        />
        <Button type="button" variant="outline" onClick={search} disabled={disabled || loading || !postcode.trim()} data-testid={`button-address-lookup-search-${field.id}`}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-2">Search</span>
        </Button>
      </div>
      {error && <p className="text-sm text-slate-500" role="status">{error}</p>}
      {results.length > 0 && (
        <div className="space-y-1 rounded-md border p-2" data-testid={`address-lookup-results-${field.id}`}>
          {results.map((result, index) => (
            <Button key={`${result.line_1}-${index}`} type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => selectAddress(result)} disabled={disabled}>
              {ADDRESS_LOOKUP_COMPONENTS.map(key => result[key]).filter(Boolean).join(', ')}
            </Button>
          ))}
        </div>
      )}
      {manualAllowed && !manual && (
        <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => {
          if (postcode.trim() && !answer.postcode) update('postcode', postcode.trim());
          setManual(true);
        }} disabled={disabled}>
          Enter address manually
        </Button>
      )}
      {(manual || Object.values(answer).some(Boolean)) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map(component => (
            <div key={component} className={component === 'line_1' ? 'sm:col-span-2' : ''}>
              <Label htmlFor={`${field.id}-${component}`} className="text-sm">
                {labelFor(component)}{required.includes(component) && <span className="ml-1 text-red-500">*</span>}
              </Label>
              <Input
                id={`${field.id}-${component}`}
                value={answer[component]}
                onChange={event => update(component, event.target.value)}
                disabled={disabled}
                required={required.includes(component)}
                data-testid={`input-address-lookup-${field.id}-${component}`}
              />
            </div>
          ))}
        </div>
      )}
      {!manualAllowed && !disabled && (
        <p className="text-sm text-slate-500">
          {lookupUnavailable ? 'Address lookup is unavailable. Please try again later.' : 'Search for and select an address to continue.'}
        </p>
      )}
      {disabled && <p className="text-sm text-slate-500">Address lookup is unavailable for this form.</p>}
    </div>
  );
}
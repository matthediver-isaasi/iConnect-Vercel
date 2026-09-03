import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ADDRESS_LOOKUP_COMPONENTS,
  addressLookupRequiredComponents,
  addressLookupVisibleComponents,
  normalizeAddressLookupAnswer,
  normalizeAddressLookupResult,
  normalizeUkPostcode,
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();
  const abortRef = useRef(null);
  const requestGeneration = useRef(0);
  const resultsCache = useRef(new Map());
  const blurTimerRef = useRef(null);
  const manualAllowed = field.manual_entry !== false && field.allow_manual_entry !== false;
  const labelFor = component => field.component_labels?.[component] || componentLabels[component];

  const update = (component, next) => onChange({
    ...answer,
    [component]: next,
  });
  useEffect(() => {
    const generation = ++requestGeneration.current;
    const normalizedPostcode = normalizeUkPostcode(postcode);
    abortRef.current?.abort();
    abortRef.current = null;
    if (disabled || !normalizedPostcode) {
      setLoading(false);
      return undefined;
    }
    const cached = resultsCache.current.get(normalizedPostcode);
    if (cached) {
      setResults(cached);
      setActiveIndex(cached.length ? 0 : -1);
      setError(cached.length ? '' : 'No addresses were found for that postcode.');
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    setLookupUnavailable(false);
    setResults([]);
    setActiveIndex(-1);
    const timer = window.setTimeout(async () => {
      if (requestGeneration.current !== generation || controller.signal.aborted) return;
      try {
        const response = await fetch('/api/public/address-lookup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            postcode: normalizedPostcode,
            form_id: formId,
            form_slug: formSlug,
            field_id: field.id,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (requestGeneration.current !== generation || controller.signal.aborted) return;
        if (!response.ok) {
          const responseError = new Error(body.error || 'Address lookup is currently unavailable.');
          responseError.code = body.code;
          throw responseError;
        }
        const addresses = responseAddresses(body);
        resultsCache.current.set(normalizedPostcode, addresses);
        setResults(addresses);
        setActiveIndex(addresses.length ? 0 : -1);
        if (addresses.length === 0) setError('No addresses were found for that postcode.');
      } catch (lookupError) {
        if (
          lookupError?.name === 'AbortError'
          || requestGeneration.current !== generation
          || controller.signal.aborted
        ) return;
        setError(lookupError.message || 'Address lookup is currently unavailable.');
        setLookupUnavailable(lookupError.code === 'ADDRESS_LOOKUP_UNAVAILABLE');
      } finally {
        if (
          abortRef.current === controller
          && requestGeneration.current === generation
          && !controller.signal.aborted
        ) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [postcode, disabled, formId, formSlug, field.id]);

  useEffect(() => () => {
    requestGeneration.current += 1;
    abortRef.current?.abort();
    if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
  }, []);

  const selectAddress = selected => {
    const next = { ...normalizeAddressLookupResult(selected), postcode: selected.postcode || postcode.trim() };
    if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
    onChange(next);
    setResults([]);
    setActiveIndex(-1);
    setManual(true);
  };
  const handlePostcodeChange = event => {
    setPostcode(event.target.value);
    setResults([]);
    setActiveIndex(-1);
    setError('');
    setLookupUnavailable(false);
  };
  const reopenCachedResults = () => {
    const normalizedPostcode = normalizeUkPostcode(postcode);
    const cached = normalizedPostcode && resultsCache.current.get(normalizedPostcode);
    if (cached?.length) {
      setResults(cached);
      setActiveIndex(0);
    }
  };
  const enterManualAddress = () => {
    requestGeneration.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setResults([]);
    setActiveIndex(-1);
    if (postcode.trim() && !answer.postcode) update('postcode', postcode.trim());
    setManual(true);
  };
  const handleKeyDown = event => {
    if (event.key === 'Enter' && normalizeUkPostcode(postcode)) {
      event.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) selectAddress(results[activeIndex]);
    } else if (event.key === 'Escape' && results.length) {
      event.preventDefault();
      setResults([]);
      setActiveIndex(-1);
    } else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setActiveIndex(index => (index <= 0 ? results.length - 1 : index - 1));
    }
  };

  return (
    <div className="space-y-3" data-testid={`address-lookup-${field.id}`}>
      <div
        className="relative"
        onBlur={event => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            setResults([]);
            setActiveIndex(-1);
          }, 150);
        }}
      >
        <Input
          id={field.id}
          value={postcode}
          onChange={handlePostcodeChange}
          onKeyDown={handleKeyDown}
          onFocus={reopenCachedResults}
          placeholder="Enter a UK postcode"
          disabled={disabled}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          aria-busy={loading}
          aria-controls={results.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          data-testid={`input-address-lookup-postcode-${field.id}`}
        />
        {loading && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />}
        {results.length > 0 && (
          <div
            id={listboxId}
            role="listbox"
            className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-white p-1 shadow-lg"
            data-testid={`address-lookup-results-${field.id}`}
          >
            {results.map((result, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                key={`${result.line_1}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={activeIndex === index}
                className={`block w-full rounded-sm px-3 py-2 text-left text-sm ${activeIndex === index ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                onPointerDown={event => {
                  event.preventDefault();
                  if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
                  selectAddress(result);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectAddress(result)}
                disabled={disabled}
              >
                {ADDRESS_LOOKUP_COMPONENTS.map(key => result[key]).filter(Boolean).join(', ')}
              </button>
            ))}
          </div>
        )}
      </div>
      {loading && (
        <p className="flex items-center gap-2 text-sm text-slate-600" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Finding addresses…
        </p>
      )}
      {error && <p className="text-sm text-slate-500" role="status">{error}</p>}
      {manualAllowed && !manual && (
        <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={enterManualAddress} disabled={disabled}>
          {loading ? 'Enter address manually instead' : 'Enter address manually'}
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
          {lookupUnavailable ? 'Address lookup is unavailable. Please try again later.' : 'Enter a postcode and select an address to continue.'}
        </p>
      )}
      {disabled && <p className="text-sm text-slate-500">Address lookup is unavailable for this form.</p>}
    </div>
  );
}
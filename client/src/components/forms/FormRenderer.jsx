import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, X, Check, ChevronsUpDown } from "lucide-react";
import CustomFieldFileUpload from "@/components/CustomFieldFileUpload";
import SignatureField from "@/components/forms/SignatureField";
import ScoreField from "@/components/forms/ScoreField";
import MembershipPaymentField from "@/components/forms/MembershipPaymentField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { publicClient } from "@/api/publicClient";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import DOMPurify from 'dompurify';

function CountryCombobox({ countries, value, onChange, disabled, placeholder, fieldId }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Support both country codes (legacy) and country names for backwards compatibility
  const selectedCountry = countries.find(c => c.name === value || c.code === value);
  
  // Filter countries based on search query while maintaining alphabetical order
  const filteredCountries = searchQuery
    ? countries.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : countries;
  
  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) setSearchQuery(""); // Reset search when closing
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
          data-testid={`select-country-${fieldId}`}
        >
          {selectedCountry ? selectedCountry.name : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search countries..." 
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => {
                    onChange(country.name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      (value === country.name || value === country.code) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {country.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MultiCountryCombobox({ countries, value = [], onChange, disabled, placeholder, fieldId }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Support both country codes (legacy) and country names for backwards compatibility
  const selectedCountries = countries.filter(c => value.includes(c.name) || value.includes(c.code));
  
  // Filter countries based on search query while maintaining alphabetical order
  const filteredCountries = searchQuery
    ? countries.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : countries;
  
  const toggleCountry = (name) => {
    const country = countries.find(c => c.name === name);
    const code = country?.code;
    const isSelected = value.includes(name) || (code && value.includes(code));
    
    if (isSelected) {
      const newValue = value.filter(c => c !== name && c !== code);
      onChange(newValue);
    } else {
      onChange([...value, name]);
    }
  };

  const allFilteredSelected = filteredCountries.length > 0 && filteredCountries.every(
    c => value.includes(c.name) || value.includes(c.code)
  );

  const toggleAll = () => {
    if (allFilteredSelected) {
      const filteredNames = new Set(filteredCountries.map(c => c.name));
      const filteredCodes = new Set(filteredCountries.map(c => c.code));
      const newValue = value.filter(v => !filteredNames.has(v) && !filteredCodes.has(v));
      onChange(newValue);
    } else {
      const currentSet = new Set(value);
      const newValue = [...value];
      for (const c of filteredCountries) {
        if (!currentSet.has(c.name) && !currentSet.has(c.code)) {
          newValue.push(c.name);
        }
      }
      onChange(newValue);
    }
  };
  
  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) setSearchQuery("");
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal min-h-9 h-auto"
          data-testid={`select-countries-${fieldId}`}
        >
          <span className="flex flex-wrap gap-1 flex-1 text-left">
            {selectedCountries.length > 0 ? (
              selectedCountries.length <= 3 ? (
                selectedCountries.map(c => c.name).join(', ')
              ) : (
                `${selectedCountries.length} countries selected`
              )
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search countries..." 
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={toggleAll}
                className="font-medium text-primary"
                data-testid={`toggle-all-countries-${fieldId}`}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    allFilteredSelected ? "opacity-100" : "opacity-0"
                  )}
                />
                {allFilteredSelected ? 'Deselect All' : 'Select All'}
              </CommandItem>
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => toggleCountry(country.name)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      (value.includes(country.name) || value.includes(country.code)) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {country.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CommunicationPreferencesField({ field, value, onChange, disabled, memberInfo, formMemberRoleId }) {
  const { data: allCategories = [], isLoading } = useQuery({
    queryKey: ['public-communication-categories'],
    queryFn: async () => await publicClient.listCommunicationCategories() || [],
    staleTime: 5 * 60 * 1000
  });

  const allowedIds = Array.isArray(field.allowed_category_ids) ? field.allowed_category_ids : [];
  const allowedIdsKey = allowedIds.join(',');

  const categories = useMemo(() => {
    const effectiveRoleId = formMemberRoleId || memberInfo?.role_id;
    const roleFiltered = allCategories.filter(cat => {
      const hasRoleScope = cat.role_ids && cat.role_ids.length > 0;
      if (!hasRoleScope) return true;
      if (cat.is_public === true) return true;
      if (!effectiveRoleId) return false;
      return cat.role_ids.includes(effectiveRoleId);
    });
    if (allowedIds.length === 0) return roleFiltered;
    const allowed = new Set(allowedIds);
    return roleFiltered.filter(cat => allowed.has(cat.id));
  }, [allCategories, formMemberRoleId, memberInfo?.role_id, allowedIdsKey]);

  useEffect(() => {
    if (categories.length > 0 && (!value || Object.keys(value).length === 0)) {
      const initialPrefs = {};
      categories.forEach(cat => {
        initialPrefs[cat.id] = false;
      });
      onChange(initialPrefs);
    }
  }, [categories]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading communication preferences...
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No communication preferences available.
      </p>
    );
  }

  const currentPrefs = value || {};

  const handleToggle = (categoryId, isSubscribed) => {
    onChange({
      ...currentPrefs,
      [categoryId]: isSubscribed
    });
  };

  return (
    <div className="space-y-3">
      {categories.map((category) => {
        const isSubscribed = currentPrefs[category.id] === true;
        return (
          <div 
            key={category.id} 
            className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200"
            data-testid={`comm-pref-category-${category.id}`}
          >
            <Checkbox
              id={`comm-pref-${category.id}`}
              checked={isSubscribed}
              disabled={disabled}
              onCheckedChange={(checked) => handleToggle(category.id, checked)}
              className="mt-0.5"
              data-testid={`checkbox-comm-pref-${category.id}`}
            />
            <div className="flex-1">
              <Label 
                htmlFor={`comm-pref-${category.id}`} 
                className="font-medium cursor-pointer"
              >
                {category.name}
              </Label>
              {category.description && (
                <p className="text-xs text-slate-500 mt-0.5">{category.description}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function FormRenderer({ field, value, onChange, memberInfo, organizationInfo, selectedOrgGuestAccess = null, disabled = false, onValidityChange, autoFocus = false, hideLabel = false, formId = null, formMemberRoleId = null, allFormValues = {}, prefillData = null, allFields = [] }) {
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [domainError, setDomainError] = useState('');
  const [domainInfoMessage, setDomainInfoMessage] = useState('');
  const [emailFormatError, setEmailFormatError] = useState('');
  const [urlFormatError, setUrlFormatError] = useState('');
  
  // Combine field.locked with disabled prop - either makes the field non-editable
  const isFieldDisabled = field.locked || disabled;

  const domainErrorRef = useRef('');
  const emailFormatErrorRef = useRef('');

  // Basic email format validation
  const validateEmailFormat = (email) => {
    if (!email) {
      setEmailFormatError('');
      emailFormatErrorRef.current = '';
      onValidityChange?.(field.id, !domainErrorRef.current);
      return true;
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      setEmailFormatError('Please enter a valid email address');
      emailFormatErrorRef.current = 'Please enter a valid email address';
      onValidityChange?.(field.id, false);
      return false;
    }
    setEmailFormatError('');
    emailFormatErrorRef.current = '';
    onValidityChange?.(field.id, !domainErrorRef.current);
    return true;
  };

  // Basic URL format validation
  const validateUrlFormat = (url) => {
    if (!url) {
      setUrlFormatError('');
      onValidityChange?.(field.id, true);
      return true;
    }
    const urlPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/;
    if (!urlPattern.test(url)) {
      setUrlFormatError('Please enter a valid web address (e.g., https://example.com)');
      onValidityChange?.(field.id, false);
      return false;
    }
    setUrlFormatError('');
    onValidityChange?.(field.id, true);
    return true;
  };

  // Domain validation helper for email fields
  const validateEmailDomain = (email) => {
    if (!field.validate_org_domain) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      return;
    }
    
    if (!organizationInfo) {
      const err = 'Domain validation requires an organisation. Please ensure you are associated with an organisation.';
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
      return;
    }
    
    if (!email) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
      return;
    }
    
    const emailParts = email.split('@');
    if (emailParts.length !== 2 || !emailParts[1]) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      return;
    }
    const emailDomain = emailParts[1].toLowerCase();
    
    const allowedDomains = [];
    if (organizationInfo.verified_domains && Array.isArray(organizationInfo.verified_domains)) {
      organizationInfo.verified_domains.forEach(d => {
        if (d) allowedDomains.push(d.toLowerCase());
      });
    }

    // Helper: when an org is selected and that org accepts guests, the domain
    // restriction is bypassed with a friendly info message instead of an error.
    // Mirrors the backend (resolveGuestStampForNewMember) which falls back to
    // the tenant default period when the org has no override — so we must not
    // block here just because period_days is missing.
    const tryGuestBypass = () => {
      if (!selectedOrgGuestAccess?.accepts_guests) return false;
      let msg;
      if (selectedOrgGuestAccess.unlimited) {
        msg = "Your email isn't on this organisation's verified domain list — a guest account will be created with permanent access.";
      } else {
        const days = Number(selectedOrgGuestAccess.default_period_days);
        if (Number.isFinite(days) && days > 0) {
          msg = `Your email isn't on this organisation's verified domain list — a guest account will be created with ${days} day${days === 1 ? '' : 's'} of access.`;
        } else {
          msg = "Your email isn't on this organisation's verified domain list — a guest account will be created for this organisation.";
        }
      }
      setDomainError('');
      setDomainInfoMessage(msg);
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
      return true;
    };

    const orgLabel = organizationInfo?.name ? `${organizationInfo.name}` : 'the selected organisation';

    if (allowedDomains.length === 0) {
      if (tryGuestBypass()) return;
      const err = `${orgLabel} isn't currently accepting registrations through this form.`;
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
      return;
    }
    
    if (!allowedDomains.includes(emailDomain)) {
      if (tryGuestBypass()) return;
      const domainList = allowedDomains.join(', ');
      const err = `Email domain must be one of the verified domains for ${orgLabel}: ${domainList}`;
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
    } else {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
    }
  };

  const orgFilterKey = JSON.stringify(field.org_filter || field.allowed_org_statuses || []);
  const { data: organisations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['public-organisations-for-form', orgFilterKey],
    queryFn: async () => {
      const opts = {};
      if (field.org_filter && field.org_filter.type && field.org_filter.field && field.org_filter.values?.length > 0) {
        opts.orgFilter = field.org_filter;
      } else if (field.allowed_org_statuses && field.allowed_org_statuses.length > 0) {
        opts.allowedStatuses = field.allowed_org_statuses;
      }
      return await publicClient.listOrganizations(opts) || [];
    },
    enabled: field.type === 'organisation_dropdown',
    staleTime: 5 * 60 * 1000
  });

  // Fetch resource categories for category_multiselect and category_dropdown field types (uses public endpoint)
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['public-resource-categories-for-form'],
    queryFn: async () => await publicClient.listResourceCategories() || [],
    enabled: field.type === 'category_multiselect' || field.type === 'category_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch custom field definition for custom_field type (uses public endpoint)
  // Pass formId to ensure correct tenant resolution for embedded forms
  const { data: customFieldDef, isLoading: customFieldLoading } = useQuery({
    queryKey: ['public-custom-field', field.custom_field_id, formId],
    queryFn: async () => await publicClient.getCustomField(field.custom_field_id, formId) || null,
    enabled: field.type === 'custom_field' && !!field.custom_field_id,
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Auto-populate user fields
  useEffect(() => {
    if (!memberInfo) return;
    
    let autoValue = null;
    switch (field.type) {
      case 'user_name':
        autoValue = `${memberInfo.first_name || ''} ${memberInfo.last_name || ''}`.trim();
        break;
      case 'user_email':
        autoValue = memberInfo.email || '';
        break;
      case 'user_organization':
        autoValue = organizationInfo?.name || '';
        break;
      case 'user_job_title':
        autoValue = memberInfo.job_title || '';
        break;
    }
    
    if (autoValue && !value) {
      onChange(autoValue);
    }
  }, [field.type, field.id, memberInfo?.first_name, memberInfo?.last_name, memberInfo?.email, memberInfo?.job_title, organizationInfo?.name, value]);

  // Check if current value is "Other" or a custom value when component mounts
  useEffect(() => {
    if (field.type === 'select' && field.allow_other && value) {
      const isExistingOption = (field.options || []).includes(value);
      if (!isExistingOption && value !== '') {
        setShowOtherInput(true);
        setOtherValue(value);
      }
    }
  }, []);

  useEffect(() => {
    if (field.type === 'custom_field' && customFieldDef?.field_type === 'boolean' && value === undefined) {
      onChange(false);
    }
  }, [field.type, customFieldDef?.field_type]);


  // Revalidate email domain when dependencies change
  useEffect(() => {
    if (field.type === 'email') {
      validateEmailDomain(value);
    }
  }, [field.validate_org_domain, organizationInfo?.verified_domains, organizationInfo?.name, value, field.type, selectedOrgGuestAccess?.accepts_guests, selectedOrgGuestAccess?.unlimited, selectedOrgGuestAccess?.default_period_days]);

  const renderField = () => {
    // Handle auto-populated user fields
    if (['user_name', 'user_email', 'user_organization', 'user_job_title'].includes(field.type)) {
      // If user is logged in, show as read-only auto-populated field
      if (memberInfo) {
        return (
          <Input
            type="text"
            value={value || ''}
            readOnly
            className="bg-slate-50 cursor-not-allowed"
            placeholder={field.placeholder || 'Auto-populated from your profile'}
          />
        );
      }
      // If no user is logged in, allow manual input based on field type
      const inputType = field.type === 'user_email' ? 'email' : 'text';
      const placeholder = field.placeholder || (
        field.type === 'user_name' ? 'Enter your name' :
        field.type === 'user_email' ? 'Enter your email' :
        field.type === 'user_organization' ? 'Enter your organisation' :
        field.type === 'user_job_title' ? 'Enter your job title' : ''
      );
      return (
        <Input
          type={inputType}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={field.required}
          disabled={isFieldDisabled}
          className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
        />
      );
    }

    switch (field.type) {
      case 'text':
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
            autoFocus={autoFocus}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'url':
        return (
          <div className="space-y-1">
            <Input
              type="url"
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              onBlur={(e) => validateUrlFormat(e.target.value)}
              placeholder={field.placeholder || 'https://example.com'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${urlFormatError ? 'border-warning/50' : ''}`}
              data-testid={`input-url-${field.id}`}
            />
            {urlFormatError && (
              <p className="text-xs text-warning" data-testid={`error-url-format-${field.id}`}>
                {urlFormatError}
              </p>
            )}
          </div>
        );

      case 'email':
        return (
          <div className="space-y-1">
            <Input
              type="email"
              value={value || ''}
              onChange={(e) => {
                onChange(e.target.value);
                validateEmailDomain(e.target.value);
              }}
              onBlur={(e) => {
                validateEmailFormat(e.target.value);
                validateEmailDomain(e.target.value);
              }}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${domainError || emailFormatError ? 'border-warning/50' : ''}`}
              data-testid={`input-email-${field.id}`}
            />
            {emailFormatError && (
              <p className="text-xs text-warning" data-testid={`error-email-format-${field.id}`}>
                {emailFormatError}
              </p>
            )}
            {domainError && (
              <p className="text-xs text-warning" data-testid={`error-domain-${field.id}`}>
                {domainError}
              </p>
            )}
            {!domainError && domainInfoMessage && (
              <p className="text-xs text-slate-600" data-testid={`info-domain-guest-${field.id}`}>
                {domainInfoMessage}
              </p>
            )}
          </div>
        );

      case 'score': {
        // Survey Score / Rating field (Task #3330). Question number is its
        // position among the survey's question fields (display-only).
        let questionNumber = null;
        if (Array.isArray(allFields) && allFields.length > 0) {
          const questionFields = allFields.filter(f => !['instructions', 'image'].includes(f.type));
          const idx = questionFields.findIndex(f => f.id === field.id);
          if (idx >= 0) questionNumber = idx + 1;
        }
        return (
          <ScoreField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            questionNumber={field.show_question_number ? questionNumber : null}
          />
        );
      }

      case 'tel':
      case 'number':
        return (
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={value || ''}
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^0-9]/g, '');
              onChange(numericValue);
            }}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
            autoFocus={autoFocus}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'percentage':
        return (
          <div className="relative">
            <Input
              type="text"
              inputMode="decimal"
              value={value || ''}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                const parts = val.split('.');
                const sanitized = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : val;
                onChange(sanitized);
              }}
              placeholder={field.placeholder || '0'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`pr-8 ${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}`}
              data-testid={`input-percentage-${field.id}`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
          </div>
        );

      case 'currency': {
        // Currency field (Task #3480): decimal input with configurable symbol
        // adornment; values sanitize to at most 2 decimal places.
        const currencySymbol = field.currency_symbol || '£';
        return (
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" data-testid={`symbol-currency-${field.id}`}>
              {currencySymbol}
            </span>
            <Input
              type="text"
              inputMode="decimal"
              value={value || ''}
              onChange={(e) => {
                let val = e.target.value.replace(/[^0-9.]/g, '');
                const parts = val.split('.');
                if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
                const [intPart, decPart] = val.split('.');
                if (decPart !== undefined) val = intPart + '.' + decPart.slice(0, 2);
                onChange(val);
              }}
              placeholder={field.placeholder || '0.00'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              style={{ paddingLeft: `${Math.max(2, 1.25 + currencySymbol.length * 0.6)}rem` }}
              className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
              data-testid={`input-currency-${field.id}`}
            />
          </div>
        );
      }

      case 'textarea': {
        const isWordLimit = field.limit_type === 'words';
        const maxLimit = field.max_characters;
        const textVal = value || '';
        const currentCount = isWordLimit
          ? (textVal.trim() === '' ? 0 : textVal.trim().split(/\s+/).length)
          : textVal.length;
        const isOverLimit = maxLimit && currentCount > maxLimit;
        return (
          <div className="space-y-1">
            <Textarea
              value={textVal}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              maxLength={(!isWordLimit && maxLimit) ? maxLimit : undefined}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${isOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
              rows={5}
            />
            {maxLimit && (
              <p className={`text-xs text-right ${isOverLimit ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                {currentCount} / {maxLimit}{isWordLimit ? ' words' : ''}
              </p>
            )}
          </div>
        );
      }

      case 'date':
      case 'time':
        return (
          <Input
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            required={field.required}
            disabled={isFieldDisabled}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'boolean':
        const booleanValue = value !== undefined && value !== null 
          ? (value === true || value === 'true')
          : (field.default_value === true);
        return (
          <div className="flex items-center space-x-3">
            <Switch
              id={field.id}
              checked={booleanValue}
              onCheckedChange={(checked) => onChange(checked)}
              disabled={isFieldDisabled}
              data-testid={`switch-boolean-${field.id}`}
            />
            <Label 
              htmlFor={field.id} 
              className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
            >
              {booleanValue ? 'Yes' : 'No'}
            </Label>
          </div>
        );

      case 'terms_conditions':
        const tcValue = value !== undefined && value !== null 
          ? (value === true || value === 'true')
          : false;
        return (
          <div className="space-y-2">
            <div className="flex items-center space-x-3">
              <Switch
                id={field.id}
                checked={tcValue}
                onCheckedChange={(checked) => onChange(checked)}
                disabled={isFieldDisabled}
                data-testid={`switch-terms-${field.id}`}
              />
              <Label 
                htmlFor={field.id} 
                className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
              >
                I accept the Terms & Conditions
              </Label>
            </div>
            {field.terms_url && (
              <a 
                href={field.terms_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline inline-block"
                data-testid={`link-terms-${field.id}`}
              >
                {field.terms_link_text || 'View Terms & Conditions'}
              </a>
            )}
          </div>
        );

      case 'select':
        return (
          <div className="space-y-2">
            <Select 
              value={showOtherInput ? 'other' : (value || '')} 
              onValueChange={(val) => {
                if (isFieldDisabled) return;
                if (val === 'other') {
                  setShowOtherInput(true);
                  onChange('');
                } else {
                  setShowOtherInput(false);
                  setOtherValue('');
                  onChange(val);
                }
              }}
              disabled={isFieldDisabled}
            >
              <SelectTrigger className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
                <SelectValue placeholder={field.placeholder || 'Select an option'} />
              </SelectTrigger>
              <SelectContent side="bottom">
                {(field.options || []).filter(option => typeof option !== 'string' || option.trim() !== '').map((option, index) => (
                  <SelectItem key={index} value={option}>
                    {option}
                  </SelectItem>
                ))}
                {field.allow_other && (
                  <SelectItem value="other">Other</SelectItem>
                )}
              </SelectContent>
            </Select>
            {showOtherInput && (
              <Input
                type="text"
                value={otherValue}
                onChange={(e) => {
                  setOtherValue(e.target.value);
                  onChange(e.target.value);
                }}
                placeholder="Please specify..."
                className="mt-2"
              />
            )}
          </div>
        );

      case 'radio':
        return (
          <RadioGroup value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            {(field.options || []).filter(option => typeof option !== 'string' || option.trim() !== '').map((option, index) => (
              <div key={index} className="flex items-center space-x-2">
                <RadioGroupItem value={option} id={`${field.id}-${index}`} />
                <Label htmlFor={`${field.id}-${index}`} className="font-normal">
                  {option}
                </Label>
              </div>
            ))}
          </RadioGroup>
        );

      case 'checkbox':
        const checkboxSelectedValues = Array.isArray(value) ? value : [];
        const checkboxMinSelections = field.min_selections;
        const checkboxMaxSelections = field.max_selections;
        const checkboxHasMin = checkboxMinSelections != null && checkboxMinSelections > 0;
        const checkboxHasMax = checkboxMaxSelections != null && checkboxMaxSelections > 0;
        const checkboxIsMaxReached = checkboxHasMax && checkboxSelectedValues.length >= checkboxMaxSelections;
        
        // Build help text
        let checkboxHelpText = '';
        if (checkboxHasMin && checkboxHasMax) {
          if (checkboxMinSelections === checkboxMaxSelections) {
            checkboxHelpText = `Please select exactly ${checkboxMinSelections} option${checkboxMinSelections > 1 ? 's' : ''}`;
          } else {
            checkboxHelpText = `Please select between ${checkboxMinSelections} and ${checkboxMaxSelections} options`;
          }
        } else if (checkboxHasMin) {
          checkboxHelpText = `Please select at least ${checkboxMinSelections} option${checkboxMinSelections > 1 ? 's' : ''}`;
        } else if (checkboxHasMax) {
          checkboxHelpText = `Please select up to ${checkboxMaxSelections} option${checkboxMaxSelections > 1 ? 's' : ''}`;
        }
        
        return (
          <div className="space-y-2">
            {(checkboxHasMin || checkboxHasMax) && (
              <p className="text-xs text-slate-500">
                {checkboxHelpText} ({checkboxSelectedValues.length} selected)
              </p>
            )}
            <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
              {(field.options || []).filter(option => typeof option !== 'string' || option.trim() !== '').map((option, index) => {
                const isChecked = checkboxSelectedValues.includes(option);
                const isOptionDisabled = isFieldDisabled || (checkboxIsMaxReached && !isChecked);
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={isChecked}
                      disabled={isOptionDisabled}
                      onCheckedChange={(checked) => {
                        if (isOptionDisabled) return;
                        if (checked) {
                          onChange([...checkboxSelectedValues, option]);
                        } else {
                          onChange(checkboxSelectedValues.filter(v => v !== option));
                        }
                      }}
                    />
                    <Label 
                      htmlFor={`${field.id}-${index}`} 
                      className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                    >
                      {option}
                    </Label>
                  </div>
                );
              })}
            </div>
          </div>
        );

      case 'file':
        return (
          <CustomFieldFileUpload
            fieldId={field.id}
            formId={formId}
            value={value}
            onChange={onChange}
            allowedTypes={field.allowed_file_types || []}
            publicAccess={field.public_access === true}
            disabled={isFieldDisabled}
            label={field.label || "Upload File"}
          />
        );

      case 'organisation_dropdown':
        if (orgsLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading organisations...
            </div>
          );
        }
        // Find current org name for display (value stores ID)
        const selectedOrg = organisations.find(org => org.id === value);
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-organisation-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an organisation'}>
                {selectedOrg?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="bottom">
              {organisations.map((org) => (
                <SelectItem key={org.id} value={org.id} data-testid={`option-organisation-${org.id}`}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'category_multiselect':
        if (categoriesLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading categories...
            </div>
          );
        }
        
        // Filter categories based on field configuration
        // If allowed_category_ids is empty/undefined, show all categories
        const filteredCategories = field.allowed_category_ids?.length > 0
          ? categories.filter(cat => field.allowed_category_ids.includes(cat.id))
          : categories;
        
        // Extract all subcategory options from the filtered categories
        // Each category has a subcategories array of strings
        const allSubcategoryOptions = [];
        filteredCategories.forEach(category => {
          if (category.subcategories && Array.isArray(category.subcategories)) {
            category.subcategories.forEach(subcat => {
              allSubcategoryOptions.push({
                categoryId: category.id,
                categoryName: category.name,
                subcategory: subcat
              });
            });
          }
        });
        
        if (allSubcategoryOptions.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              No options available. Please add subcategories in Category Management.
            </p>
          );
        }
        
        // Min/max selection logic for category_multiselect
        const selectedValues = Array.isArray(value) ? value : [];
        const minSelections = field.min_selections;
        const maxSelections = field.max_selections;
        const hasMin = minSelections != null && minSelections > 0;
        const hasMax = maxSelections != null && maxSelections > 0;
        const isMaxReached = hasMax && selectedValues.length >= maxSelections;
        
        // Build help text
        let helpText = '';
        if (hasMin && hasMax) {
          if (minSelections === maxSelections) {
            helpText = `Please select exactly ${minSelections} option${minSelections > 1 ? 's' : ''}`;
          } else {
            helpText = `Please select between ${minSelections} and ${maxSelections} options`;
          }
        } else if (hasMin) {
          helpText = `Please select at least ${minSelections} option${minSelections > 1 ? 's' : ''}`;
        } else if (hasMax) {
          helpText = `Please select up to ${maxSelections} option${maxSelections > 1 ? 's' : ''}`;
        }
        
        // Group subcategories by category for display
        const groupedByCategory = filteredCategories.map(category => ({
          ...category,
          options: allSubcategoryOptions.filter(opt => opt.categoryId === category.id)
        })).filter(cat => cat.options.length > 0);
        
        return (
          <div className="space-y-4">
            {groupedByCategory.map((category) => (
              <div key={category.id} className="space-y-2">
                {/* Category header - only show if multiple categories */}
                {groupedByCategory.length > 1 && (
                  <p className="text-sm font-medium text-slate-700">{category.name}</p>
                )}
                {/* Subcategory options */}
                <div className="space-y-2 pl-0">
                  {category.options.map((opt, optIndex) => {
                    const isChecked = selectedValues.includes(opt.subcategory);
                    const isOptionDisabled = isFieldDisabled || (isMaxReached && !isChecked);
                    return (
                      <div key={`${category.id}-${optIndex}`} className="flex items-start space-x-2">
                        <Checkbox
                          id={`${field.id}-${category.id}-${optIndex}`}
                          checked={isChecked}
                          disabled={isOptionDisabled}
                          onCheckedChange={(checked) => {
                            if (isOptionDisabled) return;
                            if (checked) {
                              onChange([...selectedValues, opt.subcategory]);
                            } else {
                              onChange(selectedValues.filter(v => v !== opt.subcategory));
                            }
                          }}
                          data-testid={`checkbox-subcategory-${category.id}-${optIndex}`}
                        />
                        <Label 
                          htmlFor={`${field.id}-${category.id}-${optIndex}`} 
                          className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                        >
                          {opt.subcategory}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {helpText && (
              <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 mt-2">
                {helpText} ({selectedValues.length} selected)
              </p>
            )}
          </div>
        );

      case 'category_dropdown':
        if (categoriesLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading options...
            </div>
          );
        }
        
        // Find the selected category and get its subcategories as options
        const selectedCategory = categories.find(cat => cat.id === field.category_id);
        const subcategoryOptions = selectedCategory?.subcategories || [];
        
        if (!selectedCategory) {
          return (
            <p className="text-sm text-slate-500">
              No category configured for this field.
            </p>
          );
        }
        
        if (subcategoryOptions.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              No options available for "{selectedCategory.name}".
            </p>
          );
        }
        
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-category-dropdown-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an option'} />
            </SelectTrigger>
            <SelectContent side="bottom">
              {subcategoryOptions.filter(option => option !== '').map((option, index) => (
                <SelectItem key={index} value={option} data-testid={`option-subcategory-${index}`}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'custom_field':
        if (customFieldLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading options...
            </div>
          );
        }
        
        if (!customFieldDef) {
          return (
            <p className="text-sm text-slate-500">
              Custom field not found.
            </p>
          );
        }
        
        const customFieldOptions = customFieldDef.options || [];
        
        // Handle file upload custom field type
        if (customFieldDef.field_type === 'file') {
          return (
            <CustomFieldFileUpload
              fieldId={field.id}
              formId={formId}
              value={value}
              onChange={(fileData) => !isFieldDisabled && onChange(fileData)}
              allowedTypes={customFieldDef.allowed_file_types || []}
              publicAccess={customFieldDef.public_access === true}
              disabled={isFieldDisabled}
              label={field.label || customFieldDef.label || 'Upload File'}
            />
          );
        }
        
        // Handle text-based custom field types that don't need options
        const textBasedTypes = ['text', 'email', 'url', 'number', 'textarea', 'long_text', 'phone', 'date'];
        if (textBasedTypes.includes(customFieldDef.field_type)) {
          // Render appropriate input based on field_type
          if (customFieldDef.field_type === 'textarea' || customFieldDef.field_type === 'long_text') {
            const cfCharCount = (value || '').length;
            const cfMaxLen = customFieldDef.max_length;
            const cfMinLen = customFieldDef.min_length;
            const cfOverLimit = cfMaxLen && cfCharCount > cfMaxLen;
            const cfUnderLimit = cfMinLen && cfCharCount > 0 && cfCharCount < cfMinLen;
            return (
              <div className="space-y-1">
                <Textarea
                  value={value || ''}
                  onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                  placeholder={field.placeholder}
                  disabled={isFieldDisabled}
                  maxLength={cfMaxLen || undefined}
                  className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${cfOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
                  data-testid={`textarea-custom-${field.id}`}
                />
                {(cfMaxLen || cfMinLen) && (
                  <div className="flex justify-between text-xs">
                    {cfMinLen ? (
                      <span className={cfUnderLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                        Min: {cfMinLen} characters
                      </span>
                    ) : <span />}
                    {cfMaxLen ? (
                      <span className={cfOverLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                        {cfCharCount} / {cfMaxLen}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          }
          
          if (customFieldDef.field_type === 'number') {
            return (
              <Input
                type="number"
                value={value || ''}
                onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                placeholder={field.placeholder}
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                data-testid={`input-custom-number-${field.id}`}
              />
            );
          }
          
          if (customFieldDef.field_type === 'date') {
            return (
              <Input
                type="date"
                value={value || ''}
                onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                data-testid={`input-custom-date-${field.id}`}
              />
            );
          }
          
          // Default to text input for text, email, url, phone
          return (
            <Input
              type={customFieldDef.field_type === 'email' ? 'email' : customFieldDef.field_type === 'url' ? 'url' : 'text'}
              value={value || ''}
              onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
              placeholder={field.placeholder}
              disabled={isFieldDisabled}
              className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
              data-testid={`input-custom-${customFieldDef.field_type}-${field.id}`}
            />
          );
        }
        
        if (customFieldDef.field_type === 'boolean') {
          const boolVal = value !== undefined && value !== null
            ? (value === true || value === 'true')
            : false;
          return (
            <div className="flex items-center space-x-3">
              <Switch
                id={field.id}
                checked={boolVal}
                onCheckedChange={(checked) => !isFieldDisabled && onChange(checked)}
                disabled={isFieldDisabled}
                data-testid={`switch-custom-boolean-${field.id}`}
              />
              <Label
                htmlFor={field.id}
                className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
              >
                {boolVal ? 'Yes' : 'No'}
              </Label>
            </div>
          );
        }

        if (customFieldDef.field_type === 'countries') {
          const allowedCountries = customFieldDef.all_countries !== false
            ? COUNTRIES
            : COUNTRIES.filter(c => (customFieldDef.selected_countries || []).includes(c.code));
          let countriesValue;
          if (Array.isArray(value)) {
            countriesValue = value;
          } else if (value === null || value === undefined || value === '') {
            countriesValue = [];
          } else if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
              try {
                const parsed = JSON.parse(trimmed);
                countriesValue = Array.isArray(parsed) ? parsed : [value];
              } catch {
                countriesValue = [value];
              }
            } else {
              countriesValue = [value];
            }
          } else {
            countriesValue = [value];
          }
          return (
            <MultiCountryCombobox
              countries={allowedCountries}
              value={countriesValue}
              onChange={(v) => !isFieldDisabled && onChange(v)}
              disabled={isFieldDisabled}
              placeholder={field.placeholder || 'Select countries...'}
              fieldId={field.id}
            />
          );
        }

        if (customFieldDef.field_type === 'country') {
          const allowedCountriesSingle = customFieldDef.all_countries !== false
            ? COUNTRIES
            : COUNTRIES.filter(c => (customFieldDef.selected_countries || []).includes(c.code));
          const singleValue = Array.isArray(value) ? (value[0] || '') : (value || '');
          return (
            <CountryCombobox
              countries={allowedCountriesSingle}
              value={singleValue}
              onChange={(v) => !isFieldDisabled && onChange(v)}
              disabled={isFieldDisabled}
              placeholder={field.placeholder || 'Select a country...'}
              fieldId={field.id}
            />
          );
        }

        // For option-based types (checkbox, radio, picklist, dropdown), require options
        if (customFieldOptions.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              No options configured for this field.
            </p>
          );
        }
        
        // Render based on custom field type
        // Options are objects with {label, value} properties
        if (customFieldDef.field_type === 'checkbox') {
          return (
            <div className="space-y-2">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={(value || []).includes(optValue)}
                      disabled={isFieldDisabled}
                      onCheckedChange={(checked) => {
                        if (isFieldDisabled) return;
                        const currentValues = value || [];
                        if (checked) {
                          onChange([...currentValues, optValue]);
                        } else {
                          onChange(currentValues.filter(v => v !== optValue));
                        }
                      }}
                      data-testid={`checkbox-custom-${field.id}-${index}`}
                    />
                    <Label htmlFor={`${field.id}-${index}`} className="font-normal cursor-pointer">
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
            </div>
          );
        }
        
        if (customFieldDef.field_type === 'radio') {
          return (
            <RadioGroup value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value={optValue} 
                      id={`${field.id}-${index}`}
                      disabled={isFieldDisabled}
                      data-testid={`radio-custom-${field.id}-${index}`}
                    />
                    <Label htmlFor={`${field.id}-${index}`} className="font-normal cursor-pointer">
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          );
        }
        
        // Picklist: multi-select checkbox group
        if (customFieldDef.field_type === 'picklist') {
          const selectedValues = Array.isArray(value) ? value : [];
          const minSelections = customFieldDef.min_selections;
          const maxSelections = customFieldDef.max_selections;
          const hasMin = minSelections != null && minSelections > 0;
          const hasMax = maxSelections != null && maxSelections > 0;
          const isMaxReached = hasMax && selectedValues.length >= maxSelections;
          
          // Build help text
          let helpText = '';
          if (hasMin && hasMax) {
            if (minSelections === maxSelections) {
              helpText = `Please select exactly ${minSelections} option${minSelections > 1 ? 's' : ''}`;
            } else {
              helpText = `Please select between ${minSelections} and ${maxSelections} options`;
            }
          } else if (hasMin) {
            helpText = `Please select at least ${minSelections} option${minSelections > 1 ? 's' : ''}`;
          } else if (hasMax) {
            helpText = `Please select up to ${maxSelections} option${maxSelections > 1 ? 's' : ''}`;
          }
          
          return (
            <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                const isChecked = selectedValues.includes(optValue);
                // Disable unselected options when max is reached
                const isOptionDisabled = isFieldDisabled || (isMaxReached && !isChecked);
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={isChecked}
                      disabled={isOptionDisabled}
                      onCheckedChange={(checked) => {
                        if (isOptionDisabled) return;
                        if (checked) {
                          onChange([...selectedValues, optValue]);
                        } else {
                          onChange(selectedValues.filter(v => v !== optValue));
                        }
                      }}
                      data-testid={`checkbox-picklist-${field.id}-${index}`}
                    />
                    <Label 
                      htmlFor={`${field.id}-${index}`} 
                      className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                    >
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
              {helpText && (
                <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 mt-2">
                  {helpText} ({selectedValues.length} selected)
                </p>
              )}
            </div>
          );
        }
        
        // Default: dropdown/select
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-custom-field-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an option'} />
            </SelectTrigger>
            <SelectContent side="bottom">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                if (!optValue) return null;
                return (
                  <SelectItem key={index} value={optValue} data-testid={`option-custom-${field.id}-${index}`}>
                    {optLabel}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        );

      case 'communication_preferences':
        return (
          <CommunicationPreferencesField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            memberInfo={memberInfo}
            formMemberRoleId={formMemberRoleId}
          />
        );

      case 'list':
        const listValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {listValues.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={item}
                  onChange={(e) => {
                    if (isFieldDisabled) return;
                    const newValues = [...listValues];
                    newValues[index] = e.target.value;
                    onChange(newValues);
                  }}
                  placeholder={field.placeholder || 'Enter value...'}
                  disabled={isFieldDisabled}
                  className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                  data-testid={`input-list-item-${field.id}-${index}`}
                />
                {!isFieldDisabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const newValues = listValues.filter((_, i) => i !== index);
                      onChange(newValues);
                    }}
                    className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
                    data-testid={`button-remove-list-item-${field.id}-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {!isFieldDisabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange([...listValues, ''])}
                className="gap-1"
                data-testid={`button-add-list-item-${field.id}`}
              >
                <Plus className="h-4 w-4" />
                Add Item
              </Button>
            )}
            {listValues.length === 0 && isFieldDisabled && (
              <p className="text-sm text-slate-500">No items added</p>
            )}
          </div>
        );

      case 'country':
        const availableCountries = field.all_countries !== false 
          ? COUNTRIES 
          : COUNTRIES.filter(c => (field.selected_countries || []).includes(c.code));
        const defaultCountryName = field.default_country 
          ? (COUNTRIES.find(c => c.code === field.default_country)?.name || '') 
          : '';
        
        return (
          <CountryCombobox
            countries={availableCountries}
            value={value || defaultCountryName}
            onChange={onChange}
            disabled={isFieldDisabled}
            placeholder="Select a country..."
            fieldId={field.id}
          />
        );

      case 'countries':
        const availableCountriesMulti = field.all_countries !== false 
          ? COUNTRIES 
          : COUNTRIES.filter(c => (field.selected_countries || []).includes(c.code));
        const defaultCountriesNames = (field.default_countries || [])
          .map(code => COUNTRIES.find(c => c.code === code)?.name)
          .filter(Boolean);
        const countriesValue = Array.isArray(value) && value.length > 0 ? value : defaultCountriesNames;
        
        return (
          <MultiCountryCombobox
            countries={availableCountriesMulti}
            value={countriesValue}
            onChange={onChange}
            disabled={isFieldDisabled}
            placeholder="Select countries..."
            fieldId={field.id}
          />
        );

      case 'contact':
        const contactValue = typeof value === 'object' && value !== null ? value : {};
        
        const contactSubFieldDefaults = {
          firstName: { visible: true, required: true },
          lastName: { visible: true, required: true },
          jobTitle: { visible: true, required: false },
          organisation: { visible: true, required: false },
          email: { visible: true, required: true },
        };
        const contactSubFields = field.contact_sub_fields || contactSubFieldDefaults;
        const getSubFieldConfig = (key) => contactSubFields[key] || contactSubFieldDefaults[key];
        const isSubVisible = (key) => getSubFieldConfig(key).visible !== false;
        const isSubRequired = (key) => field.required && getSubFieldConfig(key).required === true;
        
        const validateContactField = (contactData) => {
          if (!field.required) {
            onValidityChange?.(field.id, true);
            return true;
          }
          const requiredSubs = ['firstName', 'lastName', 'jobTitle', 'organisation', 'email'].filter(k => isSubVisible(k) && isSubRequired(k));
          const isValid = requiredSubs.every(k => !!contactData[k]?.trim());
          onValidityChange?.(field.id, isValid);
          return isValid;
        };
        
        const handleContactChange = (subField, subValue) => {
          const newContactValue = {
            ...contactValue,
            [subField]: subValue
          };
          onChange(newContactValue);
          validateContactField(newContactValue);
        };

        const contactSubFieldDefs = [
          { key: 'firstName', label: 'First name', type: 'text', placeholder: 'First name' },
          { key: 'lastName', label: 'Last name', type: 'text', placeholder: 'Last name' },
          { key: 'jobTitle', label: 'Job title', type: 'text', placeholder: 'Job title' },
          { key: 'organisation', label: 'Organisation', type: 'text', placeholder: 'Organisation' },
          { key: 'email', label: 'Email', type: 'email', placeholder: 'Email address' },
        ];
        const visibleSubFields = contactSubFieldDefs.filter(sf => isSubVisible(sf.key));
        if (visibleSubFields.length === 0) return null;
        const topRowFields = visibleSubFields.filter(sf => sf.key === 'firstName' || sf.key === 'lastName');
        const restFields = visibleSubFields.filter(sf => sf.key !== 'firstName' && sf.key !== 'lastName');
        
        return (
          <div 
            className="space-y-4 p-4 bg-slate-50 border border-slate-200 rounded-lg"
            data-testid={`contact-field-${field.id}`}
          >
            {topRowFields.length > 0 && (
              <div className={`grid grid-cols-1 ${topRowFields.length > 1 ? 'sm:grid-cols-2' : ''} gap-4`}>
                {topRowFields.map(sf => (
                  <div key={sf.key} className="space-y-1.5">
                    <Label htmlFor={`${field.id}-${sf.key}`} className="text-sm">
                      {sf.label}
                      {isSubRequired(sf.key) && <span className="text-red-500 ml-1">*</span>}
                    </Label>
                    <Input
                      id={`${field.id}-${sf.key}`}
                      type={sf.type}
                      value={contactValue[sf.key] || ''}
                      onChange={(e) => handleContactChange(sf.key, e.target.value)}
                      placeholder={sf.placeholder}
                      disabled={isFieldDisabled}
                      className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}`}
                      data-testid={`input-contact-${sf.key.toLowerCase()}-${field.id}`}
                    />
                  </div>
                ))}
              </div>
            )}
            {restFields.map(sf => (
              <div key={sf.key} className="space-y-1.5">
                <Label htmlFor={`${field.id}-${sf.key}`} className="text-sm">
                  {sf.label}
                  {isSubRequired(sf.key) && <span className="text-red-500 ml-1">*</span>}
                </Label>
                <Input
                  id={`${field.id}-${sf.key}`}
                  type={sf.type}
                  value={contactValue[sf.key] || ''}
                  onChange={(e) => handleContactChange(sf.key, e.target.value)}
                  placeholder={sf.placeholder}
                  disabled={isFieldDisabled}
                  className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                  data-testid={`input-contact-${sf.key.toLowerCase()}-${field.id}`}
                />
              </div>
            ))}
          </div>
        );

      case 'grouped_question': {
        const groupedValue = (value && typeof value === 'object') ? value : {};
        const subQuestions = Array.isArray(field.sub_questions) ? field.sub_questions : [];
        const rawMin = Number(field.min_completed);
        const minRequired = Number.isFinite(rawMin)
          ? Math.max(0, Math.min(rawMin, subQuestions.length))
          : subQuestions.length;
        const rawMax = Number(field.max_completed);
        const maxAllowed = Number.isFinite(rawMax)
          ? Math.max(minRequired, Math.min(rawMax, subQuestions.length))
          : subQuestions.length;
        const answeredCount = subQuestions.reduce((count, sq) => {
          const answer = groupedValue[sq.id];
          return count + (typeof answer === 'string' && answer.trim() ? 1 : 0);
        }, 0);

        const groupedHelperText = minRequired === maxAllowed
          ? `Answer exactly ${minRequired} of ${subQuestions.length}`
          : maxAllowed >= subQuestions.length
            ? `Answer at least ${minRequired} of ${subQuestions.length}`
            : `Answer between ${minRequired} and ${maxAllowed} of ${subQuestions.length}`;

        const handleSubQuestionChange = (subId, subValue) => {
          onChange({ ...groupedValue, [subId]: subValue });
        };

        if (subQuestions.length === 0) {
          return (
            <div
              className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500"
              data-testid={`grouped-question-${field.id}`}
            >
              No sub-questions configured.
            </div>
          );
        }

        return (
          <div
            className="space-y-4 p-4 bg-slate-50 border border-slate-200 rounded-lg"
            data-testid={`grouped-question-${field.id}`}
          >
            {(minRequired > 0 || maxAllowed < subQuestions.length) && (
              <p className="text-sm text-slate-500" data-testid={`grouped-question-helper-${field.id}`}>
                {groupedHelperText}
              </p>
            )}
            {subQuestions.map((sq) => {
              const isEmpty = !(typeof groupedValue[sq.id] === 'string' && groupedValue[sq.id].trim());
              const subDisabled = isFieldDisabled || (isEmpty && answeredCount >= maxAllowed);
              return (
                <div key={sq.id} className="space-y-1.5">
                  <Label htmlFor={`${field.id}-${sq.id}`} className="text-sm">
                    {sq.label || 'Untitled question'}
                  </Label>
                  <Textarea
                    id={`${field.id}-${sq.id}`}
                    value={groupedValue[sq.id] || ''}
                    onChange={(e) => handleSubQuestionChange(sq.id, e.target.value)}
                    placeholder={sq.placeholder || ''}
                    disabled={subDisabled}
                    rows={3}
                    className={subDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                    data-testid={`textarea-grouped-${field.id}-${sq.id}`}
                  />
                </div>
              );
            })}
          </div>
        );
      }

      case 'instructions':
        return null;

      case 'image':
        return null;

      case 'signature':
        return (
          <SignatureField
            fieldId={field.id}
            value={value?.data || value}
            onChange={onChange}
            disabled={isFieldDisabled}
            required={field.required}
            label={field.label}
          />
        );

      case 'membership_payment':
        return (
          <MembershipPaymentField
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            field={field}
            allFormValues={allFormValues}
          />
        );

      default:
        return <p className="text-sm text-slate-500">Unsupported field type: {field.type}</p>;
    }
  };

  if (field.type === 'image_buttons') {
    const imageOptions = field.image_options || [];
    return (
      <div className="space-y-2">
        {field.label && (
          <div>
            <Label>{field.label}</Label>
            {field.description && (
              <p className="text-sm text-slate-500 mt-1">{field.description}</p>
            )}
          </div>
        )}
        <div 
          className="flex flex-wrap gap-3 justify-center"
          data-testid={`image-buttons-${field.id}`}
        >
          {imageOptions.map((option, idx) => {
            const isSelected = value === option.value;
            return (
              <button
                key={idx}
                type="button"
                disabled={isFieldDisabled}
                onClick={() => {
                  if (!isFieldDisabled) {
                    onChange(option.value);
                  }
                }}
                className={cn(
                  "relative flex flex-col items-center gap-2 p-2 rounded-md border-2 transition-all cursor-pointer",
                  "hover-elevate active-elevate-2",
                  "flex-1 min-w-[100px] max-w-[200px]",
                  isSelected 
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200" 
                    : "border-slate-200 bg-white",
                  isFieldDisabled && "opacity-50 cursor-not-allowed"
                )}
                data-testid={`image-button-${field.id}-${idx}`}
              >
                {isSelected && (
                  <div className="absolute top-1 right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center z-10">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
                {option.image_url ? (
                  <img 
                    src={option.image_url} 
                    alt={option.label || `Option ${idx + 1}`}
                    className="w-full h-24 object-cover rounded"
                  />
                ) : (
                  <div className="w-full h-24 bg-slate-100 rounded flex items-center justify-center text-slate-400 text-xs">
                    No image
                  </div>
                )}
                {option.label && (
                  <span className={cn(
                    "text-xs font-medium text-center",
                    isSelected ? "text-blue-700" : "text-slate-600"
                  )}>
                    {option.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === 'image') {
    return (
      <div 
        className="w-full rounded-lg overflow-hidden"
        data-testid={`image-display-${field.id}`}
      >
        {field.image_url ? (
          <img 
            src={field.image_url} 
            alt={field.image_alt || ''} 
            className="w-full rounded-lg"
            style={{ 
              maxHeight: `${field.image_max_height || 300}px`,
              objectFit: field.image_fit || 'cover'
            }}
          />
        ) : (
          <div className="flex items-center justify-center p-8 bg-slate-100 border border-slate-200 rounded-lg text-slate-400 text-sm">
            No image configured
          </div>
        )}
      </div>
    );
  }

  if (field.type === 'instructions') {
    // Conditional logic "set value" rules can override the displayed content by
    // writing rich-text HTML into this field's live value. When an active rule
    // targets this instructions field, render its content; otherwise fall back
    // to the originally authored field.content.
    const overrideContent = typeof value === 'string' && value.trim() !== '' ? value : null;
    const rawContent = overrideContent ?? field.content ?? '<p>No instructions provided.</p>';
    const sanitizedContent = DOMPurify.sanitize(rawContent);
    return (
      <div 
        className="prose prose-sm max-w-none p-4 bg-blue-50 border border-blue-200 rounded-lg"
        data-testid={`instructions-${field.id}`}
      >
        {field.label && (
          <h4 className="text-sm font-semibold text-blue-900 mb-2">{field.label}</h4>
        )}
        <div 
          className="text-blue-800 [&>p]:mb-2 [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4"
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
        />
      </div>
    );
  }

  if (hideLabel) {
    return renderField();
  }

  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor={field.id}>
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </Label>
        {field.description && (
          <p className="text-sm text-slate-500 mt-1">{field.description}</p>
        )}
      </div>
      {renderField()}
    </div>
  );
}
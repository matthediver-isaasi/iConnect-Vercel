import { useEffect, useState } from "react";
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

function CountryCombobox({ countries, value, onChange, disabled, placeholder, fieldId }) {
  const [open, setOpen] = useState(false);
  const selectedCountry = countries.find(c => c.code === value);
  
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <Command>
          <CommandInput placeholder="Search countries..." />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {countries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => {
                    onChange(country.code);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === country.code ? "opacity-100" : "opacity-0"
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
  const selectedCountries = countries.filter(c => value.includes(c.code));
  
  const toggleCountry = (code) => {
    const newValue = value.includes(code)
      ? value.filter(c => c !== code)
      : [...value, code];
    onChange(newValue);
  };
  
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <Command>
          <CommandInput placeholder="Search countries..." />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {countries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => toggleCountry(country.code)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value.includes(country.code) ? "opacity-100" : "opacity-0"
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

function CommunicationPreferencesField({ field, value, onChange, disabled }) {
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['public-communication-categories'],
    queryFn: () => publicClient.listCommunicationCategories(),
    staleTime: 5 * 60 * 1000
  });

  // Initialize all categories to subscribed (true) when categories load
  useEffect(() => {
    if (categories.length > 0 && (!value || Object.keys(value).length === 0)) {
      const initialPrefs = {};
      categories.forEach(cat => {
        initialPrefs[cat.id] = true;
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
        const isSubscribed = currentPrefs[category.id] !== false;
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

export default function FormRenderer({ field, value, onChange, memberInfo, organizationInfo, disabled = false, onValidityChange, autoFocus = false, hideLabel = false, formId = null }) {
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [domainError, setDomainError] = useState('');
  const [emailFormatError, setEmailFormatError] = useState('');
  const [urlFormatError, setUrlFormatError] = useState('');
  
  // Combine field.locked with disabled prop - either makes the field non-editable
  const isFieldDisabled = field.locked || disabled;

  // Basic email format validation
  const validateEmailFormat = (email) => {
    if (!email) {
      setEmailFormatError('');
      onValidityChange?.(field.id, true);
      return true;
    }
    // Basic email pattern: something@something.something
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      setEmailFormatError('Please enter a valid email address');
      onValidityChange?.(field.id, false);
      return false;
    }
    setEmailFormatError('');
    onValidityChange?.(field.id, true);
    return true;
  };

  // Basic URL format validation
  const validateUrlFormat = (url) => {
    if (!url) {
      setUrlFormatError('');
      onValidityChange?.(field.id, true);
      return true;
    }
    // Basic URL pattern: protocol://domain or just domain.tld
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
    // Early exit if validation not enabled
    if (!field.validate_org_domain) {
      setDomainError('');
      return;
    }
    
    // Check if user has an organization
    if (!organizationInfo) {
      setDomainError('Domain validation requires an organisation. Please ensure you are logged in and associated with an organisation.');
      return;
    }
    
    // Skip if no email entered yet
    if (!email) {
      setDomainError('');
      return;
    }
    
    // Extract domain from email
    const emailParts = email.split('@');
    if (emailParts.length !== 2 || !emailParts[1]) {
      setDomainError('');
      return;
    }
    const emailDomain = emailParts[1].toLowerCase();
    
    // Get allowed domains from organization's verified_domains custom field
    const allowedDomains = [];
    if (organizationInfo.verified_domains && Array.isArray(organizationInfo.verified_domains)) {
      organizationInfo.verified_domains.forEach(d => {
        if (d) allowedDomains.push(d.toLowerCase());
      });
    }
    
    // If no domains configured on org, show warning
    if (allowedDomains.length === 0) {
      setDomainError('No allowed domains configured for your organisation.');
      return;
    }
    
    // Check if email domain matches any allowed domain
    if (!allowedDomains.includes(emailDomain)) {
      const domainList = allowedDomains.join(', ');
      setDomainError(`Email domain must be one of: ${domainList}`);
    } else {
      setDomainError('');
    }
  };

  // Fetch organisations for organisation_dropdown field type (uses public endpoint)
  const { data: organisations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['public-organisations-for-form'],
    queryFn: () => publicClient.listOrganizations(),
    enabled: field.type === 'organisation_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch resource categories for category_multiselect and category_dropdown field types (uses public endpoint)
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['public-resource-categories-for-form'],
    queryFn: () => publicClient.listResourceCategories(),
    enabled: field.type === 'category_multiselect' || field.type === 'category_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch custom field definition for custom_field type (uses public endpoint)
  const { data: customFieldDef, isLoading: customFieldLoading } = useQuery({
    queryKey: ['public-custom-field', field.custom_field_id],
    queryFn: () => publicClient.getCustomField(field.custom_field_id),
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

  // Revalidate email domain when dependencies change
  useEffect(() => {
    if (field.type === 'email') {
      validateEmailDomain(value);
    }
  }, [field.validate_org_domain, organizationInfo?.verified_domains, value, field.type]);

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
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${urlFormatError ? 'border-amber-500' : ''}`}
              data-testid={`input-url-${field.id}`}
            />
            {urlFormatError && (
              <p className="text-xs text-amber-600" data-testid={`error-url-format-${field.id}`}>
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
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${domainError || emailFormatError ? 'border-amber-500' : ''}`}
              data-testid={`input-email-${field.id}`}
            />
            {emailFormatError && (
              <p className="text-xs text-amber-600" data-testid={`error-email-format-${field.id}`}>
                {emailFormatError}
              </p>
            )}
            {domainError && (
              <p className="text-xs text-amber-600" data-testid={`error-domain-${field.id}`}>
                {domainError}
              </p>
            )}
          </div>
        );

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

      case 'textarea':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
            autoFocus={autoFocus}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
            rows={5}
          />
        );

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
              <SelectContent>
                {(field.options || []).filter(option => option !== '').map((option, index) => (
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
            {(field.options || []).map((option, index) => (
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
              {(field.options || []).map((option, index) => {
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
            <SelectContent>
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
            <SelectContent>
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
              disabled={isFieldDisabled}
              label={field.label || customFieldDef.label || 'Upload File'}
            />
          );
        }
        
        // Handle text-based custom field types that don't need options
        const textBasedTypes = ['text', 'email', 'url', 'number', 'textarea', 'phone', 'date'];
        if (textBasedTypes.includes(customFieldDef.field_type)) {
          // Render appropriate input based on field_type
          if (customFieldDef.field_type === 'textarea') {
            return (
              <Textarea
                value={value || ''}
                onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                placeholder={field.placeholder}
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                data-testid={`textarea-custom-${field.id}`}
              />
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
            <SelectContent>
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
        const selectedCountry = availableCountries.find(c => c.code === (value || field.default_country));
        
        return (
          <CountryCombobox
            countries={availableCountries}
            value={value || field.default_country || ''}
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
        
        return (
          <MultiCountryCombobox
            countries={availableCountriesMulti}
            value={Array.isArray(value) ? value : []}
            onChange={onChange}
            disabled={isFieldDisabled}
            placeholder="Select countries..."
            fieldId={field.id}
          />
        );

      case 'contact':
        const contactValue = typeof value === 'object' && value !== null ? value : {};
        
        // Validate contact field - required sub-fields must be filled
        const validateContactField = (contactData) => {
          if (!field.required) {
            onValidityChange?.(field.id, true);
            return true;
          }
          // When required, first name, last name, and email must be filled
          const isValid = !!(contactData.firstName?.trim() && contactData.lastName?.trim() && contactData.email?.trim());
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
        
        // Check if required sub-fields are missing (for visual feedback)
        const contactMissingFirstName = field.required && !contactValue.firstName?.trim();
        const contactMissingLastName = field.required && !contactValue.lastName?.trim();
        const contactMissingEmail = field.required && !contactValue.email?.trim();
        
        return (
          <div 
            className="space-y-4 p-4 bg-slate-50 border border-slate-200 rounded-lg"
            data-testid={`contact-field-${field.id}`}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-firstName`} className="text-sm">
                  First name
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </Label>
                <Input
                  id={`${field.id}-firstName`}
                  type="text"
                  value={contactValue.firstName || ''}
                  onChange={(e) => handleContactChange('firstName', e.target.value)}
                  placeholder="First name"
                  disabled={isFieldDisabled}
                  className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}`}
                  data-testid={`input-contact-firstname-${field.id}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-lastName`} className="text-sm">
                  Last name
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </Label>
                <Input
                  id={`${field.id}-lastName`}
                  type="text"
                  value={contactValue.lastName || ''}
                  onChange={(e) => handleContactChange('lastName', e.target.value)}
                  placeholder="Last name"
                  disabled={isFieldDisabled}
                  className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}`}
                  data-testid={`input-contact-lastname-${field.id}`}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${field.id}-jobTitle`} className="text-sm">
                Job title
              </Label>
              <Input
                id={`${field.id}-jobTitle`}
                type="text"
                value={contactValue.jobTitle || ''}
                onChange={(e) => handleContactChange('jobTitle', e.target.value)}
                placeholder="Job title"
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                data-testid={`input-contact-jobtitle-${field.id}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${field.id}-organisation`} className="text-sm">
                Organisation
              </Label>
              <Input
                id={`${field.id}-organisation`}
                type="text"
                value={contactValue.organisation || ''}
                onChange={(e) => handleContactChange('organisation', e.target.value)}
                placeholder="Organisation"
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                data-testid={`input-contact-organisation-${field.id}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${field.id}-email`} className="text-sm">
                Email
                {field.required && <span className="text-red-500 ml-1">*</span>}
              </Label>
              <Input
                id={`${field.id}-email`}
                type="email"
                value={contactValue.email || ''}
                onChange={(e) => handleContactChange('email', e.target.value)}
                placeholder="Email address"
                disabled={isFieldDisabled}
                className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}`}
                data-testid={`input-contact-email-${field.id}`}
              />
            </div>
          </div>
        );

      case 'instructions':
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

      default:
        return <p className="text-sm text-slate-500">Unsupported field type: {field.type}</p>;
    }
  };

  if (field.type === 'instructions') {
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
          dangerouslySetInnerHTML={{ __html: field.content || '<p>No instructions provided.</p>' }}
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
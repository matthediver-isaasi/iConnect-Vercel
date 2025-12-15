import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function CommunicationPreferencesField({ field, value, onChange, disabled }) {
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['public-communication-categories'],
    queryFn: async () => {
      const response = await fetch('/api/public/communication-categories');
      if (!response.ok) {
        throw new Error('Failed to fetch communication categories');
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000
  });

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

export default function FormRenderer({ field, value, onChange, memberInfo, organizationInfo, disabled = false }) {
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [domainError, setDomainError] = useState('');
  
  // Combine field.locked with disabled prop - either makes the field non-editable
  const isFieldDisabled = field.locked || disabled;

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
    queryFn: async () => {
      const response = await fetch('/api/public/organisations');
      if (!response.ok) {
        throw new Error('Failed to fetch organisations');
      }
      return response.json();
    },
    enabled: field.type === 'organisation_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch resource categories for category_multiselect and category_dropdown field types (uses public endpoint)
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['public-resource-categories-for-form'],
    queryFn: async () => {
      const response = await fetch('/api/public/resource-categories');
      if (!response.ok) {
        throw new Error('Failed to fetch resource categories');
      }
      return response.json();
    },
    enabled: field.type === 'category_multiselect' || field.type === 'category_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  // Fetch custom field definition for custom_field type (uses public endpoint)
  const { data: customFieldDef, isLoading: customFieldLoading } = useQuery({
    queryKey: ['public-custom-field', field.custom_field_id],
    queryFn: async () => {
      const response = await fetch(`/api/public/custom-field/${field.custom_field_id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch custom field');
      }
      return response.json();
    },
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

    switch (field.type) {
      case 'text':
      case 'url':
        return (
          <Input
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || (field.type === 'url' ? 'https://example.com' : undefined)}
            required={field.required}
            disabled={isFieldDisabled}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
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
              onBlur={(e) => validateEmailDomain(e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isFieldDisabled}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${domainError ? 'border-amber-500' : ''}`}
              data-testid={`input-email-${field.id}`}
            />
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
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
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
                {(field.options || []).map((option, index) => (
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
        return (
          <div className="space-y-2">
            {(field.options || []).map((option, index) => (
              <div key={index} className="flex items-center space-x-2">
                <Checkbox
                  id={`${field.id}-${index}`}
                  checked={(value || []).includes(option)}
                  disabled={isFieldDisabled}
                  onCheckedChange={(checked) => {
                    if (isFieldDisabled) return;
                    const currentValues = value || [];
                    if (checked) {
                      onChange([...currentValues, option]);
                    } else {
                      onChange(currentValues.filter(v => v !== option));
                    }
                  }}
                />
                <Label htmlFor={`${field.id}-${index}`} className="font-normal">
                  {option}
                </Label>
              </div>
            ))}
          </div>
        );

      case 'file':
        return (
          <Input
            type="file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                onChange(file.name);
              }
            }}
            required={field.required}
            disabled={isFieldDisabled}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
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
              {subcategoryOptions.map((option, index) => (
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

      default:
        return <p className="text-sm text-slate-500">Unsupported field type: {field.type}</p>;
    }
  };

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
import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function FormRenderer({ field, value, onChange, memberInfo, organizationInfo }) {
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');

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
      case 'email':
      case 'url':
      case 'tel':
      case 'number':
        return (
          <Input
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || (field.type === 'url' ? 'https://example.com' : undefined)}
            required={field.required}
            disabled={field.locked}
            className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={field.locked}
            className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}
            rows={4}
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
            disabled={field.locked}
            className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}
          />
        );

      case 'select':
        return (
          <div className="space-y-2">
            <Select 
              value={showOtherInput ? 'other' : (value || '')} 
              onValueChange={(val) => {
                if (field.locked) return;
                if (val === 'other') {
                  setShowOtherInput(true);
                  onChange('');
                } else {
                  setShowOtherInput(false);
                  setOtherValue('');
                  onChange(val);
                }
              }}
              disabled={field.locked}
            >
              <SelectTrigger className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}>
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
          <RadioGroup value={value || ''} onValueChange={field.locked ? undefined : onChange} disabled={field.locked}>
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
                  disabled={field.locked}
                  onCheckedChange={(checked) => {
                    if (field.locked) return;
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
            disabled={field.locked}
            className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}
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
          <Select value={value || ''} onValueChange={field.locked ? undefined : onChange} disabled={field.locked}>
            <SelectTrigger data-testid={`select-organisation-${field.id}`} className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}>
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
        
        if (filteredCategories.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              No categories available. Please add categories in Category Management.
            </p>
          );
        }
        return (
          <div className="space-y-2">
            {filteredCategories.map((category) => (
              <div key={category.id} className="flex items-start space-x-2">
                <Checkbox
                  id={`${field.id}-${category.id}`}
                  checked={(value || []).includes(category.name)}
                  disabled={field.locked}
                  onCheckedChange={(checked) => {
                    if (field.locked) return;
                    const currentValues = value || [];
                    if (checked) {
                      onChange([...currentValues, category.name]);
                    } else {
                      onChange(currentValues.filter(v => v !== category.name));
                    }
                  }}
                  data-testid={`checkbox-category-${category.id}`}
                />
                <div className="grid gap-0.5 leading-none">
                  <Label 
                    htmlFor={`${field.id}-${category.id}`} 
                    className="font-normal cursor-pointer"
                  >
                    {category.name}
                  </Label>
                  {category.description && (
                    <p className="text-xs text-slate-500">{category.description}</p>
                  )}
                </div>
              </div>
            ))}
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
          <Select value={value || ''} onValueChange={field.locked ? undefined : onChange} disabled={field.locked}>
            <SelectTrigger data-testid={`select-category-dropdown-${field.id}`} className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}>
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
                      disabled={field.locked}
                      onCheckedChange={(checked) => {
                        if (field.locked) return;
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
            <RadioGroup value={value || ''} onValueChange={field.locked ? undefined : onChange} disabled={field.locked}>
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value={optValue} 
                      id={`${field.id}-${index}`}
                      disabled={field.locked}
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
          return (
            <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                const isChecked = selectedValues.includes(optValue);
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={isChecked}
                      disabled={field.locked}
                      onCheckedChange={(checked) => {
                        if (field.locked) return;
                        if (checked) {
                          onChange([...selectedValues, optValue]);
                        } else {
                          onChange(selectedValues.filter(v => v !== optValue));
                        }
                      }}
                      data-testid={`checkbox-picklist-${field.id}-${index}`}
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
        
        // Default: dropdown/select
        return (
          <Select value={value || ''} onValueChange={field.locked ? undefined : onChange} disabled={field.locked}>
            <SelectTrigger data-testid={`select-custom-field-${field.id}`} className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}>
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

      case 'list':
        const listValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {listValues.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={item}
                  onChange={(e) => {
                    if (field.locked) return;
                    const newValues = [...listValues];
                    newValues[index] = e.target.value;
                    onChange(newValues);
                  }}
                  placeholder={field.placeholder || 'Enter value...'}
                  disabled={field.locked}
                  className={field.locked ? 'bg-slate-100 cursor-not-allowed' : ''}
                  data-testid={`input-list-item-${field.id}-${index}`}
                />
                {!field.locked && (
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
            {!field.locked && (
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
            {listValues.length === 0 && field.locked && (
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
      <Label htmlFor={field.id}>
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      {renderField()}
    </div>
  );
}
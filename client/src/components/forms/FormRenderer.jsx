import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2 } from "lucide-react";
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

  // Fetch resource categories for category_multiselect field type (uses public endpoint)
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['public-resource-categories-for-form'],
    queryFn: async () => {
      const response = await fetch('/api/public/resource-categories');
      if (!response.ok) {
        throw new Error('Failed to fetch resource categories');
      }
      return response.json();
    },
    enabled: field.type === 'category_multiselect',
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
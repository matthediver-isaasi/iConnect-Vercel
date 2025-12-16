import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Building2, Globe, Users, Phone, Mail, MapPin, ClipboardList, ExternalLink, Save, X, Camera, Plus, Trash2 } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { useToast } from "@/components/ui/use-toast";

function ListFieldInput({ items, onChange, placeholder, fieldId }) {
  const [newItem, setNewItem] = useState('');

  const handleAdd = () => {
    const trimmed = newItem.trim();
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed]);
      setNewItem('');
    }
  };

  const handleRemove = (index) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1"
          data-testid={`input-list-${fieldId}`}
        />
        <Button
          type="button"
          size="sm"
          onClick={handleAdd}
          disabled={!newItem.trim()}
          data-testid={`button-add-list-item-${fieldId}`}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <Badge
              key={index}
              variant="secondary"
              className="flex items-center gap-1 pr-1"
            >
              <span>{item}</span>
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="ml-1 p-0.5 rounded-full hover:bg-slate-300 transition-colors"
                data-testid={`button-remove-list-item-${fieldId}-${index}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function ListFieldDisplay({ items }) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return <span className="text-slate-400 italic font-normal">Not set</span>;
  }
  
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, index) => (
        <Badge key={index} variant="secondary" className="text-xs">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export default function MyOrganisationPage() {
  const { memberInfo, organizationInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [accessChecked, setAccessChecked] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const logoInputRef = useRef(null);
  const defaultFormData = {
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: '',
    description: ''
  };
  const [formData, setFormData] = useState(defaultFormData);
  const [customFieldValues, setCustomFieldValues] = useState({});
  const [originalFormData, setOriginalFormData] = useState(defaultFormData);
  const [originalCustomFieldValues, setOriginalCustomFieldValues] = useState({});
  const [dataReady, setDataReady] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_user_MyOrganisation')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: organization, isLoading: orgLoading } = useQuery({
    queryKey: ['myOrganization', memberInfo?.organization_id],
    enabled: !!memberInfo?.organization_id && accessChecked,
    queryFn: async () => {
      if (!memberInfo?.organization_id) return null;
      const org = await base44.entities.Organization.get(memberInfo.organization_id);
      return org;
    }
  });

  const { data: fieldOrderSettings } = useQuery({
    queryKey: ['org-field-order-settings'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { key: 'organization_field_order' }
      });
      if (settings && settings.length > 0) {
        try {
          return JSON.parse(settings[0].value);
        } catch {
          return null;
        }
      }
      return null;
    },
    enabled: accessChecked,
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ['organizationMembers', memberInfo?.organization_id],
    enabled: !!memberInfo?.organization_id && accessChecked,
    queryFn: async () => {
      if (!memberInfo?.organization_id) return [];
      const allMembers = await base44.entities.Member.list({
        filter: { organization_id: memberInfo.organization_id }
      });
      return allMembers || [];
    }
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'organization');
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    }
  });

  const { data: orgValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['organizationPreferenceValues', memberInfo?.organization_id],
    enabled: !!memberInfo?.organization_id && accessChecked,
    queryFn: async () => {
      if (!memberInfo?.organization_id) return [];
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: memberInfo.organization_id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { data: fieldPermissions = {} } = useQuery({
    queryKey: ['my-organization-field-permissions'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const response = await fetch('/api/my-organization-field-permissions', {
          credentials: 'include'
        });
        if (!response.ok) return {};
        return response.json();
      } catch {
        return {};
      }
    }
  });

  const orderedCustomFields = useMemo(() => {
    if (!orgCustomFields.length) return [];
    
    if (fieldOrderSettings?.customFieldOrder) {
      const orderedIds = fieldOrderSettings.customFieldOrder;
      const reordered = orderedIds
        .map(id => orgCustomFields.find(f => f.id === id))
        .filter(Boolean);
      const remaining = orgCustomFields.filter(f => !orderedIds.includes(f.id));
      return [...reordered, ...remaining];
    }
    
    return [...orgCustomFields].sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  }, [orgCustomFields, fieldOrderSettings]);

  const orderedContactFieldKeys = useMemo(() => {
    const defaultOrder = ['phone', 'website_url', 'invoicing_email', 'invoicing_address'];
    
    if (fieldOrderSettings?.contactFieldOrder) {
      const orderedKeys = fieldOrderSettings.contactFieldOrder;
      const result = [...orderedKeys];
      defaultOrder.forEach(key => {
        if (!result.includes(key)) result.push(key);
      });
      return result;
    }
    
    return defaultOrder;
  }, [fieldOrderSettings]);

  const getFieldPermission = (fieldKey) => {
    return fieldPermissions[fieldKey] || 'read_write';
  };

  const canEditField = (fieldKey) => {
    return getFieldPermission(fieldKey) === 'read_write';
  };

  const isFieldVisible = (fieldKey) => {
    return getFieldPermission(fieldKey) !== 'hidden';
  };

  const renderCoreField = (fieldKey) => {
    if (!isFieldVisible(fieldKey)) return null;

    switch (fieldKey) {
      case 'phone':
        return canEditField('phone') ? (
          <div key="phone" className="space-y-2">
            <Label htmlFor="phone" className="flex items-center gap-2">
              <Phone className="w-4 h-4 text-slate-500" />
              Phone Number
            </Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
              placeholder="Enter phone number"
              data-testid="input-phone"
            />
          </div>
        ) : (
          <div key="phone" className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Phone className="w-5 h-5 text-slate-500 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Phone Number</p>
              <p className="text-sm font-medium text-slate-900" data-testid="text-phone">
                {organization?.phone || <span className="text-slate-400 italic font-normal">Not set</span>}
              </p>
            </div>
          </div>
        );

      case 'website_url':
        return canEditField('website_url') ? (
          <div key="website_url" className="space-y-2">
            <Label htmlFor="website_url" className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-slate-500" />
              Website
            </Label>
            <Input
              id="website_url"
              value={formData.website_url}
              onChange={(e) => setFormData(prev => ({ ...prev, website_url: e.target.value }))}
              placeholder="https://example.com"
              data-testid="input-website"
            />
          </div>
        ) : (
          <div key="website_url" className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Globe className="w-5 h-5 text-slate-500 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Website</p>
              {organization?.website_url ? (
                <a 
                  href={organization.website_url.startsWith('http') ? organization.website_url : `https://${organization.website_url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  data-testid="link-website"
                >
                  {organization.website_url}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <p className="text-sm text-slate-400 italic" data-testid="text-website-empty">Not set</p>
              )}
            </div>
          </div>
        );

      case 'invoicing_email':
        return canEditField('invoicing_email') ? (
          <div key="invoicing_email" className="space-y-2">
            <Label htmlFor="invoicing_email" className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-slate-500" />
              Invoicing Email
            </Label>
            <Input
              id="invoicing_email"
              type="email"
              value={formData.invoicing_email}
              onChange={(e) => setFormData(prev => ({ ...prev, invoicing_email: e.target.value }))}
              placeholder="invoicing@example.com"
              data-testid="input-invoicing-email"
            />
          </div>
        ) : (
          <div key="invoicing_email" className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Mail className="w-5 h-5 text-slate-500 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Invoicing Email</p>
              {organization?.invoicing_email ? (
                <a 
                  href={`mailto:${organization.invoicing_email}`}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                  data-testid="link-invoicing-email"
                >
                  {organization.invoicing_email}
                </a>
              ) : (
                <p className="text-sm text-slate-400 italic" data-testid="text-invoicing-email-empty">Not set</p>
              )}
            </div>
          </div>
        );

      case 'invoicing_address':
        return canEditField('invoicing_address') ? (
          <div key="invoicing_address" className="space-y-2">
            <Label htmlFor="invoicing_address" className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-slate-500" />
              Invoicing Address
            </Label>
            <Textarea
              id="invoicing_address"
              value={formData.invoicing_address}
              onChange={(e) => setFormData(prev => ({ ...prev, invoicing_address: e.target.value }))}
              placeholder="Enter invoicing address"
              rows={3}
              data-testid="textarea-invoicing-address"
            />
          </div>
        ) : (
          <div key="invoicing_address" className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <MapPin className="w-5 h-5 text-slate-500 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Invoicing Address</p>
              <p className="text-sm font-medium text-slate-900 whitespace-pre-line" data-testid="text-invoicing-address">
                {organization?.invoicing_address || <span className="text-slate-400 italic font-normal">Not set</span>}
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  
  useEffect(() => {
    if (organization) {
      const data = {
        phone: organization.phone || '',
        website_url: organization.website_url || '',
        invoicing_email: organization.invoicing_email || '',
        invoicing_address: organization.invoicing_address || '',
        description: organization.description || ''
      };
      setFormData(data);
      setOriginalFormData(data);
      setDataReady(true);
    }
  }, [organization]);

  useEffect(() => {
    if (orgCustomFields.length > 0) {
      const valuesMap = {};
      orgValues.forEach(pv => {
        const field = orgCustomFields.find(f => f.id === pv.field_id);
        if ((field?.field_type === 'picklist' || field?.field_type === 'list') && pv.value) {
          try {
            valuesMap[pv.field_id] = JSON.parse(pv.value);
          } catch {
            valuesMap[pv.field_id] = pv.value;
          }
        } else {
          valuesMap[pv.field_id] = pv.value;
        }
      });
      setCustomFieldValues(valuesMap);
      setOriginalCustomFieldValues(valuesMap);
    } else if (!valuesLoading) {
      setCustomFieldValues({});
      setOriginalCustomFieldValues({});
    }
  }, [orgValues, orgCustomFields, valuesLoading]);

  const hasChanges = useMemo(() => {
    if (!dataReady) return false;
    
    const coreFieldsChanged = Object.keys(formData).some(key => {
      if (!canEditField(key)) return false;
      return formData[key] !== originalFormData[key];
    });
    
    if (coreFieldsChanged) return true;
    
    const customFieldsChanged = Object.keys(customFieldValues).some(fieldId => {
      if (!canEditField(fieldId)) return false;
      const current = customFieldValues[fieldId];
      const original = originalCustomFieldValues[fieldId];
      if (Array.isArray(current) || Array.isArray(original)) {
        return JSON.stringify(current || []) !== JSON.stringify(original || []);
      }
      return current !== original;
    });
    
    return customFieldsChanged;
  }, [formData, originalFormData, customFieldValues, originalCustomFieldValues, fieldPermissions, dataReady]);

  const updateOrgMutation = useMutation({
    mutationFn: async (updates) => {
      const response = await fetch('/api/my-organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updates)
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || 'Failed to update organisation');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myOrganization', memberInfo?.organization_id] });
      toast({
        title: "Changes saved",
        description: "Organisation details have been updated successfully."
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update organisation details.",
        variant: "destructive"
      });
    }
  });

  const updateCustomFieldMutation = useMutation({
    mutationFn: async ({ fieldId, value }) => {
      const existingValue = orgValues.find(v => v.field_id === fieldId);
      const field = orgCustomFields.find(f => f.id === fieldId);
      
      let storedValue = value;
      if ((field?.field_type === 'picklist' || field?.field_type === 'list') && Array.isArray(value)) {
        storedValue = JSON.stringify(value);
      }
      
      if (existingValue) {
        await base44.entities.OrganizationPreferenceValue.update(existingValue.id, { value: storedValue });
      } else {
        await base44.entities.OrganizationPreferenceValue.create({
          organization_id: memberInfo.organization_id,
          field_id: fieldId,
          value: storedValue
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizationPreferenceValues', memberInfo?.organization_id] });
    }
  });

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!canEditField('logo_url')) {
      toast({
        title: "Permission denied",
        description: "You don't have permission to change the logo",
        variant: "destructive"
      });
      return;
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Please upload a valid image file (JPEG, PNG, GIF, or WebP)",
        variant: "destructive"
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Image must be smaller than 5MB",
        variant: "destructive"
      });
      return;
    }

    setIsUploadingLogo(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      
      const response = await fetch('/api/my-organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ logo_url: result.file_url })
      });
      
      if (!response.ok) {
        throw new Error('Failed to update logo');
      }
      
      queryClient.invalidateQueries({ queryKey: ['myOrganization', memberInfo?.organization_id] });
      toast({
        title: "Logo updated",
        description: "Organisation logo has been updated successfully."
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error.message || "Failed to upload logo",
        variant: "destructive"
      });
    } finally {
      setIsUploadingLogo(false);
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
    }
  };

  const handleSave = async () => {
    const changedCoreFields = {};
    Object.keys(formData).forEach(key => {
      if (canEditField(key) && formData[key] !== originalFormData[key]) {
        changedCoreFields[key] = formData[key];
      }
    });
    
    if (Object.keys(changedCoreFields).length > 0) {
      await updateOrgMutation.mutateAsync(changedCoreFields);
    }
    
    for (const [fieldId, value] of Object.entries(customFieldValues)) {
      if (!canEditField(fieldId)) continue;
      
      const originalValue = originalCustomFieldValues[fieldId];
      const field = orgCustomFields.find(f => f.id === fieldId);
      
      let currentVal = value;
      let origVal = originalValue;
      
      if (field?.field_type === 'picklist' || field?.field_type === 'list') {
        currentVal = Array.isArray(value) ? JSON.stringify(value) : value;
        origVal = Array.isArray(originalValue) ? JSON.stringify(originalValue) : originalValue;
      }
      
      if (currentVal !== origVal) {
        await updateCustomFieldMutation.mutateAsync({ fieldId, value });
      }
    }
    
    setOriginalFormData({ ...formData });
    setOriginalCustomFieldValues({ ...customFieldValues });
  };

  const handleCancel = () => {
    setFormData({ ...originalFormData });
    setCustomFieldValues({ ...originalCustomFieldValues });
  };

  const handleCustomFieldChange = (fieldId, value) => {
    setCustomFieldValues(prev => ({
      ...prev,
      [fieldId]: value
    }));
  };

  const isLoading = !accessChecked || orgLoading || membersLoading;
  const isSaving = updateOrgMutation.isPending || updateCustomFieldMutation.isPending;

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!memberInfo?.organization_id) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Organisation Found</h3>
              <p className="text-slate-600">You are not currently associated with an organisation.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const getCustomFieldDisplayValue = (field, valueRecord) => {
    let displayValue = valueRecord?.value;
    
    if (displayValue === null || displayValue === undefined || displayValue === '') {
      return '';
    }

    switch (field.field_type) {
      case 'picklist':
        try {
          const parsed = JSON.parse(displayValue);
          if (Array.isArray(parsed) && field.options) {
            return parsed
              .map(v => field.options.find(o => o.value === v)?.label || v)
              .join(', ');
          }
        } catch {
          return displayValue;
        }
        break;
      
      case 'list':
        try {
          const parsed = typeof displayValue === 'string' ? JSON.parse(displayValue) : displayValue;
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          return displayValue;
        }
        break;
        
      case 'dropdown':
        if (field.options) {
          const option = field.options.find(o => o.value === displayValue);
          return option?.label || displayValue;
        }
        break;
        
      case 'boolean':
        if (displayValue === 'true' || displayValue === true) return 'Yes';
        if (displayValue === 'false' || displayValue === false) return 'No';
        return displayValue;
        
      case 'date':
        try {
          const date = new Date(displayValue);
          if (!isNaN(date.getTime())) {
            return date.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric'
            });
          }
        } catch {
          return displayValue;
        }
        break;
        
      case 'number':
      case 'decimal':
        const num = parseFloat(displayValue);
        if (!isNaN(num)) {
          return field.field_type === 'decimal' 
            ? num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : num.toLocaleString('en-GB');
        }
        break;
        
      case 'textarea':
      case 'rich_text':
        return displayValue;
        
      case 'text':
      default:
        return displayValue;
    }
    
    return displayValue;
  };

  const renderCustomFieldInput = (field) => {
    const fieldValue = customFieldValues[field.id] ?? '';
    
    switch (field.field_type) {
      case 'text':
        return (
          <Input
            id={`field-${field.id}`}
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            data-testid={`input-custom-field-${field.id}`}
          />
        );
        
      case 'textarea':
        return (
          <Textarea
            id={`field-${field.id}`}
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            rows={3}
            data-testid={`textarea-custom-field-${field.id}`}
          />
        );
        
      case 'number':
        return (
          <Input
            id={`field-${field.id}`}
            type="number"
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder || '0'}
            data-testid={`input-custom-field-${field.id}`}
          />
        );
        
      case 'decimal':
        return (
          <Input
            id={`field-${field.id}`}
            type="number"
            step="0.01"
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder || '0.00'}
            data-testid={`input-custom-field-${field.id}`}
          />
        );
        
      case 'dropdown':
        return (
          <Select
            value={fieldValue || ''}
            onValueChange={(value) => handleCustomFieldChange(field.id, value)}
          >
            <SelectTrigger data-testid={`select-custom-field-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        
      case 'picklist':
        const selectedValues = Array.isArray(fieldValue) ? fieldValue : [];
        return (
          <div className="space-y-2 p-3 bg-white rounded-lg border">
            {field.options?.map((option) => {
              const isChecked = selectedValues.includes(option.value);
              return (
                <div key={option.value} className="flex items-center space-x-2">
                  <Checkbox
                    id={`field-${field.id}-${option.value}`}
                    checked={isChecked}
                    onCheckedChange={(checked) => {
                      const newValues = checked
                        ? [...selectedValues, option.value]
                        : selectedValues.filter(v => v !== option.value);
                      handleCustomFieldChange(field.id, newValues);
                    }}
                    data-testid={`checkbox-custom-field-${field.id}-${option.value}`}
                  />
                  <Label htmlFor={`field-${field.id}-${option.value}`} className="text-sm font-normal cursor-pointer">
                    {option.label}
                  </Label>
                </div>
              );
            })}
          </div>
        );
        
      case 'list':
        const listItems = Array.isArray(fieldValue) ? fieldValue : [];
        return (
          <ListFieldInput
            items={listItems}
            onChange={(newItems) => handleCustomFieldChange(field.id, newItems)}
            placeholder={field.placeholder || `Add ${field.label.toLowerCase()}`}
            fieldId={field.id}
          />
        );
        
      case 'boolean':
        return (
          <div className="flex items-center space-x-2">
            <Checkbox
              id={`field-${field.id}`}
              checked={fieldValue === 'true' || fieldValue === true}
              onCheckedChange={(checked) => handleCustomFieldChange(field.id, checked ? 'true' : 'false')}
              data-testid={`checkbox-custom-field-${field.id}`}
            />
            <Label htmlFor={`field-${field.id}`} className="text-sm font-normal cursor-pointer">
              {field.label}
            </Label>
          </div>
        );
        
      case 'date':
        return (
          <Input
            id={`field-${field.id}`}
            type="date"
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            data-testid={`input-custom-field-${field.id}`}
          />
        );
        
      default:
        return (
          <Input
            id={`field-${field.id}`}
            value={fieldValue}
            onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            data-testid={`input-custom-field-${field.id}`}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Building2 className="w-8 h-8 text-blue-600" />
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                My Organisation
              </h1>
            </div>
            <p className="text-slate-600">
              View and manage your organisation details
            </p>
          </div>
          
          {!isLoading && organization && hasChanges && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isSaving}
                data-testid="button-cancel-edit"
              >
                <X className="w-4 h-4 mr-2" />
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving}
                data-testid="button-save-organisation"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                Save Changes
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : organization ? (
          <div className="space-y-6">
            {/* Header Card - Name is read-only */}
            <Card className="border-slate-200">
              <CardContent className="p-6">
                <div className="flex items-start gap-6">
                  {isFieldVisible('logo_url') && (
                    <div className="relative flex-shrink-0">
                      <div className="w-24 h-24 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center">
                        {isUploadingLogo ? (
                          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                        ) : organization.logo_url ? (
                          <img
                            src={organization.logo_url}
                            alt={organization.name}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <Building2 className="w-12 h-12 text-slate-400" />
                        )}
                      </div>
                      {canEditField('logo_url') && (
                        <>
                          <input
                            ref={logoInputRef}
                            type="file"
                            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                            className="hidden"
                            onChange={handleLogoUpload}
                            data-testid="input-logo-upload"
                          />
                          <button
                            type="button"
                            onClick={() => logoInputRef.current?.click()}
                            disabled={isUploadingLogo}
                            className="absolute -bottom-1 -right-1 w-8 h-8 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center shadow-md transition-colors"
                            data-testid="button-change-logo"
                          >
                            <Camera className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {canEditField('logo_url') && (
                        <p className="text-xs text-slate-500 mt-2 text-center">
                          200 x 200px
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex-1">
                    <h2 className="text-2xl font-bold text-slate-900 mb-2" data-testid="text-organisation-name">
                      {organization.name}
                    </h2>
                    {organization.domain && (
                      <p className="text-sm text-slate-500 flex items-center gap-1 mb-3">
                        <Globe className="w-4 h-4" />
                        @{organization.domain}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Badge 
                        variant="secondary" 
                        className="bg-blue-100 text-blue-700 cursor-pointer hover:bg-blue-200 transition-colors"
                        onClick={() => setLocation('/Team')}
                        data-testid="badge-member-count"
                      >
                        <Users className="w-3 h-3 mr-1" />
                        {members.length} {members.length === 1 ? 'member' : 'members'}
                      </Badge>
                    </div>
                  </div>
                </div>

                {isFieldVisible('description') && (
                  <div className="mt-4 pt-4 border-t border-slate-200">
                    {canEditField('description') ? (
                      <div className="space-y-2">
                        <Label htmlFor="description" className="text-sm font-medium text-slate-700">Description</Label>
                        <Textarea
                          id="description"
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          placeholder="Enter organisation description"
                          rows={3}
                          data-testid="textarea-description"
                        />
                      </div>
                    ) : organization.description ? (
                      <p className="text-slate-600">{organization.description}</p>
                    ) : (
                      <p className="text-slate-400 italic">No description set</p>
                    )}
                  </div>
                )}

                {organization.additional_verified_domains?.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-200">
                    <p className="text-sm font-medium text-slate-700 mb-2">Additional Domains</p>
                    <div className="flex flex-wrap gap-1">
                      {organization.additional_verified_domains.map((domain, idx) => (
                        <Badge key={idx} variant="secondary" className="text-xs">
                          @{domain}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Contact & Invoicing Details */}
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-blue-600" />
                  Contact & Invoicing Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {orderedContactFieldKeys.map(fieldKey => renderCoreField(fieldKey))}
                </div>
              </CardContent>
            </Card>

            {/* Custom Fields Section */}
            {orderedCustomFields.filter(f => isFieldVisible(f.id)).length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <ClipboardList className="w-5 h-5 text-blue-600" />
                    Additional Information
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {valuesLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {orderedCustomFields.filter(f => isFieldVisible(f.id)).map((field) => {
                        const valueRecord = orgValues.find(v => v.field_id === field.id);
                        const displayValue = getCustomFieldDisplayValue(field, valueRecord);
                        
                        if (canEditField(field.id)) {
                          return (
                            <div key={field.id} className="space-y-2">
                              <Label htmlFor={`field-${field.id}`} className="text-sm font-medium text-slate-700">
                                {field.label}
                                {field.required && <span className="text-red-500 ml-1">*</span>}
                              </Label>
                              {field.description && (
                                <p className="text-xs text-slate-500">{field.description}</p>
                              )}
                              {renderCustomFieldInput(field)}
                            </div>
                          );
                        }
                        
                        return (
                          <div key={field.id} className="flex justify-between items-start gap-4 p-3 bg-slate-50 rounded-lg">
                            <span className="text-sm text-slate-600">{field.label}</span>
                            <div className="text-sm font-medium text-slate-900 text-right" data-testid={`text-custom-field-${field.id}`}>
                              {field.field_type === 'list' ? (
                                <ListFieldDisplay items={displayValue} />
                              ) : (
                                displayValue || <span className="text-slate-400 italic font-normal">Not set</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Organisation Not Found</h3>
              <p className="text-slate-600">Unable to load your organisation details.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

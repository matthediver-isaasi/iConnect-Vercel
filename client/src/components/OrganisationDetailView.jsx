import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  Building2, 
  ArrowLeft, 
  Globe, 
  Users, 
  Phone, 
  Mail, 
  MapPin, 
  Pencil, 
  Save, 
  X, 
  Camera,
  Loader2,
  ExternalLink,
  User,
  Calendar,
  ClipboardList,
  Wallet,
  FileText,
  LayoutGrid,
  Plus,
  StickyNote,
  Trash2,
  MessageSquare
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useOrgDetailLayout, mergeLayoutWithCustomFields, CORE_FIELDS } from "@/hooks/useOrgDetailLayout";
import { useDateFormat } from "@/hooks/useDateFormat";
import OrgDetailLayoutEditor from "@/components/OrgDetailLayoutEditor";
import MemberDetailView from "@/components/MemberDetailView";

const getMemberName = (m) => {
  return [m?.first_name, m?.last_name].filter(Boolean).join(' ') || m?.full_name || '';
};

// --- List Field Editor Component for Organisations ---
function ListFieldEditorOrg({ fieldId, values = [], onChange, placeholder, disabled = false }) {
  const [inputValue, setInputValue] = useState('');
  
  // Ensure values is always a clean array with trimmed entries
  const safeValues = Array.isArray(values) ? values.map(v => String(v).trim()).filter(Boolean) : [];

  const handleAddItem = () => {
    const trimmed = inputValue.trim();
    // Check for duplicates case-insensitively
    if (!trimmed || safeValues.some(v => v.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...safeValues, trimmed]);
    setInputValue('');
  };

  const handleRemoveItem = (itemToRemove) => {
    onChange(safeValues.filter(item => item !== itemToRemove));
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddItem();
    }
  };

  return (
    <div className="space-y-2">
      {safeValues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {safeValues.map((item, index) => (
            <Badge 
              key={index} 
              variant="secondary" 
              className="flex items-center gap-1 px-2 py-1"
              data-testid={`list-item-org-${fieldId}-${index}`}
            >
              <span>{item}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemoveItem(item)}
                  className="ml-1 hover:text-red-600 transition-colors"
                  data-testid={`button-remove-list-item-org-${fieldId}-${index}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={placeholder || 'Add item...'}
            className="flex-1"
            data-testid={`input-list-org-${fieldId}`}
          />
          <Button 
            type="button" 
            variant="outline" 
            onClick={handleAddItem}
            disabled={!inputValue.trim()}
            data-testid={`button-add-list-item-org-${fieldId}`}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export default function OrganisationDetailView({ 
  organization, 
  onBack, 
  orgCustomFields = [],
  memberCount = 0,
  isNew = false,
  onCreated 
}) {
  const { isAdmin, memberInfo } = useMemberAccess();
  const { formatDate } = useDateFormat();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(isNew);
  const [activeTab, setActiveTab] = useState('overview');
  const [showLayoutEditor, setShowLayoutEditor] = useState(false);
  const [isCreatingMember, setIsCreatingMember] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [noteToDelete, setNoteToDelete] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: '',
    description: '',
    training_fund_balance: 0
  });
  const [customFieldValues, setCustomFieldValues] = useState({});
  
  const { layoutConfig, saveLayout, isSaving: isLayoutSaving } = useOrgDetailLayout();
  const effectiveLayout = mergeLayoutWithCustomFields(layoutConfig, orgCustomFields);

  const { data: orgMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['org-detail-members', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      const members = await base44.entities.Member.list({
        filter: { organization_id: organization.id }
      });
      return members || [];
    }
  });

  const { data: orgValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['org-detail-preference-values', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: organization.id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { data: orgBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['org-detail-bookings', organization?.id, orgMembers.length],
    enabled: !!organization?.id && activeTab === 'activity' && orgMembers.length > 0,
    queryFn: async () => {
      try {
        // Only fetch bookings for members of this organisation
        const memberIds = orgMembers.map(m => m.id);
        if (memberIds.length === 0) return [];
        
        // Fetch bookings for each member (limited approach to avoid loading all bookings)
        const bookingPromises = memberIds.slice(0, 10).map(memberId => 
          base44.entities.Booking.list({ filter: { member_id: memberId } })
        );
        const results = await Promise.all(bookingPromises);
        const allBookings = results.flat().sort((a, b) => 
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
        return allBookings.slice(0, 20); // Limit to 20 most recent
      } catch {
        return [];
      }
    }
  });

  // Queries for MemberDetailView when creating new member
  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-for-org'],
    enabled: isCreatingMember,
    queryFn: async () => {
      try {
        const fields = await base44.entities.MemberPreferenceField.list();
        return fields || [];
      } catch {
        return [];
      }
    }
  });

  const { data: allOrganizations = [] } = useQuery({
    queryKey: ['organizations-for-member-create'],
    enabled: isCreatingMember,
    queryFn: async () => {
      try {
        const orgs = await base44.entities.Organization.list();
        return orgs || [];
      } catch {
        return [];
      }
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-member-create'],
    enabled: isCreatingMember,
    queryFn: async () => {
      try {
        const rolesList = await base44.entities.Role.list();
        return rolesList || [];
      } catch {
        return [];
      }
    }
  });

  // Organization Notes query
  const { data: orgNotes = [], isLoading: notesLoading } = useQuery({
    queryKey: ['org-notes', organization?.id],
    enabled: !!organization?.id && activeTab === 'notes',
    queryFn: async () => {
      const res = await fetch(`/api/admin/organizations/${organization.id}/notes`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch notes');
      return res.json();
    }
  });

  // Create note mutation
  const createNoteMutation = useMutation({
    mutationFn: async (content) => {
      const res = await fetch(`/api/admin/organizations/${organization.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to create note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      setNewNoteContent('');
      toast.success('Note added');
    },
    onError: (error) => {
      toast.error('Failed to add note: ' + error.message);
    }
  });

  // Update note mutation
  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, content }) => {
      const res = await fetch(`/api/admin/organization-notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to update note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      setEditingNoteId(null);
      setEditingNoteContent('');
      toast.success('Note updated');
    },
    onError: (error) => {
      toast.error('Failed to update note: ' + error.message);
    }
  });

  // Delete note mutation
  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId) => {
      const res = await fetch(`/api/admin/organization-notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to delete note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      toast.success('Note deleted');
    },
    onError: (error) => {
      toast.error('Failed to delete note: ' + error.message);
    }
  });

  useEffect(() => {
    if (organization) {
      setFormData({
        name: organization.name || '',
        phone: organization.phone || '',
        website_url: organization.website_url || '',
        invoicing_email: organization.invoicing_email || '',
        invoicing_address: organization.invoicing_address || '',
        description: organization.description || '',
        training_fund_balance: organization.training_fund_balance || 0
      });
    }
  }, [organization]);

  useEffect(() => {
    if (orgValues.length > 0 && orgCustomFields.length > 0) {
      const valuesMap = {};
      orgValues.forEach(pv => {
        const field = orgCustomFields.find(f => f.id === pv.field_id);
        if ((field?.field_type === 'picklist' || field?.field_type === 'list') && pv.value) {
          try {
            const parsed = JSON.parse(pv.value);
            // Ensure it's an array, normalize values
            valuesMap[pv.field_id] = Array.isArray(parsed) 
              ? parsed.map(v => String(v).trim()).filter(Boolean)
              : [];
          } catch {
            console.warn(`Failed to parse ${field?.field_type} value for field ${pv.field_id}, defaulting to empty array`);
            valuesMap[pv.field_id] = [];
          }
        } else {
          valuesMap[pv.field_id] = pv.value;
        }
      });
      setCustomFieldValues(valuesMap);
    }
  }, [orgValues, orgCustomFields]);

  const createOrgMutation = useMutation({
    mutationFn: async (newOrg) => {
      return await base44.entities.Organization.create(newOrg);
    },
    onSuccess: (createdOrg) => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      toast.success('Organisation created successfully');
      if (onCreated) {
        onCreated(createdOrg);
      }
    },
    onError: (error) => {
      toast.error('Failed to create organisation: ' + error.message);
    }
  });

  const updateOrgMutation = useMutation({
    mutationFn: async (updates) => {
      return await base44.entities.Organization.update(organization.id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      toast.success('Organisation updated successfully');
      setIsEditing(false);
    },
    onError: (error) => {
      toast.error('Failed to update organisation: ' + error.message);
    }
  });

  const updateCustomFieldMutation = useMutation({
    mutationFn: async ({ fieldId, value, existingRecordId }) => {
      const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
      console.log('[CustomField Mutation] fieldId:', fieldId, 'value:', value, 'storedValue:', storedValue, 'existingRecordId:', existingRecordId);
      
      if (existingRecordId) {
        return await base44.entities.OrganizationPreferenceValue.update(existingRecordId, { value: storedValue });
      } else {
        return await base44.entities.OrganizationPreferenceValue.create({
          organization_id: organization.id,
          field_id: fieldId,
          value: storedValue
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-detail-preference-values', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['all-org-preference-values-crm'] });
    }
  });

  const handleSave = async () => {
    if (isNew) {
      // Prevent duplicate submissions
      if (createOrgMutation.isPending) return;
      
      // Create mode: create org first, then save custom fields
      if (!formData.name?.trim()) {
        toast.error('Organisation name is required');
        return;
      }
      
      createOrgMutation.mutate(formData, {
        onSuccess: async (createdOrg) => {
          // Save custom field values for the newly created org
          const currentCustomFieldValues = { ...customFieldValues };
          for (const [fieldId, value] of Object.entries(currentCustomFieldValues)) {
            // Use ?? to preserve falsy values like 0 or false
            const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
            // Only skip truly empty strings or empty arrays
            if (storedValue && storedValue !== '[]') {
              try {
                await base44.entities.OrganizationPreferenceValue.create({
                  organization_id: createdOrg.id,
                  field_id: fieldId,
                  value: storedValue
                });
              } catch (err) {
                console.error('Failed to save custom field:', fieldId, err);
              }
            }
          }
          queryClient.invalidateQueries({ queryKey: ['all-org-preference-values-crm'] });
        }
      });
    } else {
      // Update mode: existing behaviour
      updateOrgMutation.mutate(formData);
      
      // Capture current values at save time to avoid stale closure issues
      const currentCustomFieldValues = { ...customFieldValues };
      const currentOrgValues = [...orgValues];
      
      console.log('[handleSave] customFieldValues:', currentCustomFieldValues);
      console.log('[handleSave] orgValues:', currentOrgValues.map(v => ({ field_id: v.field_id, value: v.value })));
      
      Object.entries(currentCustomFieldValues).forEach(([fieldId, value]) => {
        const existingVal = currentOrgValues.find(v => v.field_id === fieldId);
        // Use ?? to preserve falsy values like 0 or false
        const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
        const existingStored = existingVal?.value || '';
        
        console.log('[handleSave] Field:', fieldId, 'newValue:', storedValue, 'existingValue:', existingStored, 'changed:', storedValue !== existingStored);
        
        if (storedValue !== existingStored) {
          updateCustomFieldMutation.mutate({ 
            fieldId, 
            value,
            existingRecordId: existingVal?.id 
          });
        }
      });
    }
  };

  const handleCancel = () => {
    if (isNew) {
      // Cancel creating a new org - go back
      onBack?.();
      return;
    }
    
    setFormData({
      name: organization.name || '',
      phone: organization.phone || '',
      website_url: organization.website_url || '',
      invoicing_email: organization.invoicing_email || '',
      invoicing_address: organization.invoicing_address || '',
      description: organization.description || '',
      training_fund_balance: organization.training_fund_balance || 0
    });
    
    const valuesMap = {};
    orgValues.forEach(pv => {
      const field = orgCustomFields.find(f => f.id === pv.field_id);
      if ((field?.field_type === 'picklist' || field?.field_type === 'list') && pv.value) {
        try {
          const parsed = JSON.parse(pv.value);
          valuesMap[pv.field_id] = Array.isArray(parsed) 
            ? parsed.map(v => String(v).trim()).filter(Boolean)
            : [];
        } catch {
          valuesMap[pv.field_id] = [];
        }
      } else {
        valuesMap[pv.field_id] = pv.value;
      }
    });
    setCustomFieldValues(valuesMap);
    setIsEditing(false);
  };

  const renderFieldEditor = (field) => {
    const value = customFieldValues[field.id];
    
    switch (field.field_type) {
      case 'text':
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'number':
      case 'decimal':
        return (
          <Input
            type="number"
            step={field.field_type === 'decimal' ? '0.01' : '1'}
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'dropdown':
        return (
          <Select
            value={value || ''}
            onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v }))}
            disabled={!isEditing}
          >
            <SelectTrigger data-testid={`select-custom-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              {(field.options || []).map((opt, idx) => (
                <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'picklist':
        const selectedValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedValues.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (!isEditing) return;
                    const newValues = checked 
                      ? [...selectedValues, opt.value]
                      : selectedValues.filter(v => v !== opt.value);
                    setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
                  }}
                  disabled={!isEditing}
                  data-testid={`checkbox-custom-${field.id}-${opt.value}`}
                />
                <span className="text-sm">{opt.label || opt.value}</span>
              </div>
            ))}
          </div>
        );
      case 'list':
        return (
          <ListFieldEditorOrg
            fieldId={field.id}
            values={Array.isArray(value) ? value : []}
            onChange={(newValues) => {
              setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
            }}
            disabled={!isEditing}
            placeholder={`Add ${field.label.toLowerCase()}...`}
          />
        );
      case 'date':
        return isEditing ? (
          <Input
            type="date"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            data-testid={`input-custom-date-${field.id}`}
          />
        ) : (
          <p className="text-sm">{formatDate(value)}</p>
        );
      case 'email':
        return isEditing ? (
          <Input
            type="email"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            data-testid={`input-custom-email-${field.id}`}
          />
        ) : (
          <p className="text-sm">
            {value ? (
              <a href={`mailto:${value}`} className="text-blue-600 hover:underline">{value}</a>
            ) : '-'}
          </p>
        );
      case 'url':
        return isEditing ? (
          <Input
            type="url"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            placeholder="https://"
            data-testid={`input-custom-url-${field.id}`}
          />
        ) : (
          <p className="text-sm">
            {value ? (
              <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                {value} <ExternalLink className="w-3 h-3" />
              </a>
            ) : '-'}
          </p>
        );
      default:
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
          />
        );
    }
  };

  const renderCoreField = (fieldKey) => {
    const coreFieldDef = CORE_FIELDS.find(f => f.fieldKey === fieldKey);
    if (!coreFieldDef) return null;
    
    const value = formData[fieldKey];
    const label = coreFieldDef.label;
    
    if (fieldKey === 'description') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500">{label}</Label>
          {isEditing ? (
            <Textarea
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              rows={3}
              data-testid={`textarea-${fieldKey}`}
            />
          ) : (
            <p className="text-slate-700">{value || 'No description provided'}</p>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'invoicing_address') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> {label}
          </Label>
          {isEditing ? (
            <Textarea
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              rows={2}
              data-testid={`textarea-${fieldKey}`}
            />
          ) : (
            <p className="whitespace-pre-line">{value || '-'}</p>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'website_url') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Globe className="w-3 h-3" /> {label}
          </Label>
          {isEditing ? (
            <Input
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              data-testid={`input-${fieldKey}`}
            />
          ) : value ? (
            <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
              {value}
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            <p>-</p>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'created_at') {
      const dateValue = organization?.created_at;
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {label}
          </Label>
          <p>{formatDate(dateValue)}</p>
        </div>
      );
    }
    
    const iconMap = {
      invoicing_email: <Mail className="w-3 h-3" />,
      phone: <Phone className="w-3 h-3" />,
      name: null
    };
    
    return (
      <div className="space-y-2">
        <Label className="text-slate-500 flex items-center gap-1">
          {iconMap[fieldKey]} {label}
        </Label>
        {isEditing ? (
          <Input
            type={fieldKey === 'invoicing_email' ? 'email' : 'text'}
            value={value || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
            data-testid={`input-${fieldKey}`}
          />
        ) : (
          <p className={fieldKey === 'name' ? 'font-medium' : ''}>{value || '-'}</p>
        )}
      </div>
    );
  };

  const renderLayoutCard = (card) => {
    if (card.fields.length === 0) return null;
    
    const gridCols = card.columns === 1 ? 'grid-cols-1' : card.columns === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3';
    
    const renderField = (field) => {
      if (field.type === 'core') {
        return (
          <div key={field.id}>
            {renderCoreField(field.fieldKey)}
          </div>
        );
      } else {
        const customField = orgCustomFields.find(cf => cf.id === field.fieldId);
        if (!customField) return null;
        return (
          <div key={field.id} className="space-y-2">
            <Label className="text-slate-500">{customField.label}</Label>
            {renderFieldEditor(customField)}
          </div>
        );
      }
    };
    
    return (
      <Card key={card.id}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-600" />
            {card.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={`grid ${gridCols} gap-4`}>
            {Array.from({ length: card.columns }).map((_, colIndex) => {
              const colFields = card.fields.filter(f => 
                f.columnIndex !== undefined ? f.columnIndex === colIndex : (card.fields.indexOf(f) % card.columns === colIndex)
              );
              return (
                <div key={colIndex} className="space-y-4">
                  {colFields.map(field => renderField(field))}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    );
  };

  // Render MemberDetailView when creating a new member for this organisation
  if (isCreatingMember) {
    return (
      <MemberDetailView
        member={{}}
        onBack={() => setIsCreatingMember(false)}
        memberCustomFields={memberCustomFields}
        organizations={allOrganizations}
        roles={roles}
        isNew={true}
        defaultOrganizationId={organization?.id || ''}
        onCreated={(createdMember) => {
          setIsCreatingMember(false);
          // Refresh the org members list
          queryClient.invalidateQueries({ queryKey: ['org-detail-members', organization?.id] });
          toast.success(`Member "${getMemberName(createdMember) || createdMember.email}" added to organisation`);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-4">
                {isNew ? (
                  <div className="w-14 h-14 rounded-lg bg-green-100 flex items-center justify-center">
                    <Building2 className="w-7 h-7 text-green-600" />
                  </div>
                ) : organization?.logo_url ? (
                  <img src={organization.logo_url} alt={organization.name} className="w-14 h-14 rounded-lg object-contain bg-slate-100" />
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Building2 className="w-7 h-7 text-blue-600" />
                  </div>
                )}
                <div>
                  <h1 className="text-xl font-semibold text-slate-900">
                    {isNew ? 'Add New Organisation' : (organization?.name || 'Organisation')}
                  </h1>
                  {!isNew && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm text-slate-500 flex items-center gap-1">
                        <Users className="w-4 h-4" />
                        {memberCount} members
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {isAdmin && (
              <div className="flex items-center gap-2">
                {isEditing || isNew ? (
                  <>
                    <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-edit">
                      <X className="w-4 h-4 mr-2" />
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleSave} 
                      disabled={isNew ? createOrgMutation.isPending : updateOrgMutation.isPending}
                      data-testid="button-save-org"
                    >
                      {(isNew ? createOrgMutation.isPending : updateOrgMutation.isPending) ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      {isNew ? 'Create Organisation' : 'Save Changes'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setShowLayoutEditor(true)} data-testid="button-customize-layout">
                      <LayoutGrid className="w-4 h-4 mr-2" />
                      Customize Layout
                    </Button>
                    <Button onClick={() => setIsEditing(true)} data-testid="button-edit-org">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        
        {!isNew && (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="px-6">
            <TabsList className="bg-transparent border-b-0">
              <TabsTrigger value="overview" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-overview">
                Overview
              </TabsTrigger>
              <TabsTrigger value="members" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-members">
                Members
              </TabsTrigger>
              <TabsTrigger value="activity" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-activity">
                Activity
              </TabsTrigger>
              <TabsTrigger value="notes" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-notes">
                Notes
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </header>

      {showLayoutEditor && (
        <OrgDetailLayoutEditor
          layout={effectiveLayout}
          customFields={orgCustomFields}
          onSave={async (newLayout) => {
            await saveLayout(newLayout);
            setShowLayoutEditor(false);
          }}
          onCancel={() => setShowLayoutEditor(false)}
          isSaving={isLayoutSaving}
        />
      )}

      <main className="p-6">
        {(activeTab === 'overview' || isNew) && (
          <div className={isNew ? "max-w-4xl mx-auto space-y-6" : "grid grid-cols-1 lg:grid-cols-3 gap-6"}>
            <div className={isNew ? "space-y-6" : "lg:col-span-2 space-y-6"}>
              {effectiveLayout.cards.map(card => renderLayoutCard(card))}
            </div>

            {!isNew && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Wallet className="w-4 h-4 text-green-600" />
                      Training Fund
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-center py-4">
                      <p className="text-3xl font-bold text-green-600">
                        £{(formData.training_fund_balance || 0).toFixed(2)}
                      </p>
                      <p className="text-sm text-slate-500 mt-1">Available Balance</p>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600" />
                      Team Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Total Members</span>
                        <span className="font-medium">{orgMembers.length}</span>
                      </div>
                      <Separator />
                      <div className="space-y-2">
                        {orgMembers.slice(0, 5).map(member => (
                          <div key={member.id} className="flex items-center gap-2 text-sm">
                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                              <User className="w-4 h-4 text-slate-400" />
                            </div>
                            <div>
                              <p className="font-medium text-slate-700">{getMemberName(member) || member.email}</p>
                              <p className="text-xs text-slate-400">{member.job_title || 'Member'}</p>
                            </div>
                          </div>
                        ))}
                        {orgMembers.length > 5 && (
                          <p className="text-xs text-slate-400 text-center pt-2">
                            +{orgMembers.length - 5} more members
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}

        {activeTab === 'members' && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  Organisation Members ({orgMembers.length})
                </CardTitle>
                {isAdmin && (
                  <Button 
                    onClick={() => setIsCreatingMember(true)}
                    data-testid="button-add-org-member"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Member
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {membersLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgMembers.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No members in this organisation</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Email</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Job Title</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orgMembers.map(member => (
                        <tr key={member.id} className="hover:bg-slate-50" data-testid={`row-member-${member.id}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                                <User className="w-4 h-4 text-blue-600" />
                              </div>
                              <a 
                                href={`/members?id=${member.id}`}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                data-testid={`link-member-${member.id}`}
                              >
                                {getMemberName(member) || '-'}
                              </a>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{member.email}</td>
                          <td className="px-4 py-3 text-slate-600">{member.job_title || '-'}</td>
                          <td className="px-4 py-3">
                            <Badge variant={!member.disabled ? 'default' : 'secondary'} className="capitalize">
                              {member.disabled ? 'disabled' : 'active'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'activity' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-blue-600" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bookingsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgBookings.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Calendar className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No recent activity</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {orgBookings.slice(0, 10).map(booking => (
                    <div key={booking.id} className="flex items-start gap-4 p-4 bg-slate-50 rounded-lg" data-testid={`activity-${booking.id}`}>
                      <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <Calendar className="w-5 h-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">{booking.event_title || 'Event Booking'}</p>
                        <p className="text-sm text-slate-500">
                          {booking.created_date ? new Date(booking.created_date).toLocaleDateString('en-GB') : 'Unknown date'}
                        </p>
                        <Badge variant="outline" className="mt-2 capitalize">{booking.status || 'confirmed'}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'notes' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <StickyNote className="w-5 h-5 text-blue-600" />
                Organisation Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Textarea
                  placeholder="Add a note..."
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="min-h-[100px]"
                  data-testid="input-new-note"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => createNoteMutation.mutate(newNoteContent)}
                    disabled={!newNoteContent.trim() || createNoteMutation.isPending}
                    data-testid="button-add-note"
                  >
                    {createNoteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 mr-2" />
                    )}
                    Add Note
                  </Button>
                </div>
              </div>

              <Separator />

              {notesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgNotes.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No notes yet</p>
                  <p className="text-sm text-slate-400 mt-1">Add a note above to get started</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {orgNotes.map(note => (
                    <div key={note.id} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-3" data-testid={`note-${note.id}`}>
                      {editingNoteId === note.id ? (
                        <div className="space-y-3">
                          <Textarea
                            value={editingNoteContent}
                            onChange={(e) => setEditingNoteContent(e.target.value)}
                            className="min-h-[80px]"
                            data-testid={`input-edit-note-${note.id}`}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditingNoteId(null);
                                setEditingNoteContent('');
                              }}
                              data-testid={`button-cancel-edit-${note.id}`}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => updateNoteMutation.mutate({ noteId: note.id, content: editingNoteContent })}
                              disabled={!editingNoteContent.trim() || updateNoteMutation.isPending}
                              data-testid={`button-save-note-${note.id}`}
                            >
                              {updateNoteMutation.isPending ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                'Save'
                              )}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{note.content}</p>
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2 text-slate-500">
                              <User className="w-3 h-3" />
                              <span>{note.member_name}</span>
                              <span className="text-slate-300">|</span>
                              <span>{note.created_at ? format(new Date(note.created_at), 'dd MMM yyyy, HH:mm') : ''}</span>
                              {note.updated_at && note.updated_at !== note.created_at && (
                                <span className="italic text-slate-400">(edited)</span>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setEditingNoteId(note.id);
                                  setEditingNoteContent(note.content);
                                }}
                                data-testid={`button-edit-note-${note.id}`}
                              >
                                <Pencil className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setNoteToDelete(note.id)}
                                disabled={deleteNoteMutation.isPending}
                                data-testid={`button-delete-note-${note.id}`}
                              >
                                <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-600" />
                              </Button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <AlertDialog open={!!noteToDelete} onOpenChange={(open) => !open && setNoteToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Note</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this note? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete-note">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (noteToDelete) {
                    deleteNoteMutation.mutate(noteToDelete);
                    setNoteToDelete(null);
                  }
                }}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete-note"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </div>
  );
}

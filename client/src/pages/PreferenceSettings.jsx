import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { supabase } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { GripVertical, Settings, Loader2, Building2, User, BarChart3, FolderHeart, Save, RotateCcw, Eye, EyeOff, Shield, Mail, ClipboardList, ExternalLink, ChevronDown, ChevronUp, FolderTree } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

const DEFAULT_SECTION_ORDER = [
  { id: 'organization_logo', label: 'Organisation Logo', icon: Building2, description: 'Organisation branding and logo upload (shown to org members only)', visible: true },
  { id: 'profile_information', label: 'Profile Information', icon: User, description: 'Personal details, photo, biography and contact information', visible: true },
  { id: 'password_security', label: 'Password', icon: Shield, description: 'Change password and account security settings', visible: true },
  { id: 'communications', label: 'Communication Preferences', icon: Mail, description: 'Marketing communication opt-in/opt-out settings based on role', visible: true },
  { id: 'additional_info', label: 'Additional Info', icon: ClipboardList, description: 'Custom preference fields defined by administrators', visible: true },
  { id: 'engagement', label: 'Engagement', icon: BarChart3, description: 'Activity statistics, awards, and group memberships', visible: true },
  { id: 'resource_interests', label: 'Resource Interests', icon: FolderHeart, description: 'Content category preferences and subscriptions', visible: true }
];

export default function PreferenceSettingsPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [sections, setSections] = useState(DEFAULT_SECTION_ORDER);
  const [hasChanges, setHasChanges] = useState(false);
  const [showFieldVisibility, setShowFieldVisibility] = useState(false);
  const [hiddenFieldIds, setHiddenFieldIds] = useState([]);
  const [fieldVisibilityChanged, setFieldVisibilityChanged] = useState(false);
  const [showResourceVisibility, setShowResourceVisibility] = useState(false);
  const [hiddenResourceCategoryIds, setHiddenResourceCategoryIds] = useState([]);
  const [resourceVisibilityChanged, setResourceVisibilityChanged] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_PreferenceSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  const { data: savedOrder, isLoading } = useQuery({
    queryKey: ['preferences-section-order'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'preferences_section_order');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return null;
        }
      }
      return null;
    },
    staleTime: 0
  });

  const { data: existingSetting } = useQuery({
    queryKey: ['preferences-section-order-record'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const found = allSettings.find(s => s.setting_key === 'preferences_section_order');
      return found || null;
    },
    staleTime: 0
  });

  // Fetch member custom fields for visibility configuration
  const { data: memberCustomFields = [], isLoading: fieldsLoading } = useQuery({
    queryKey: ['member-custom-fields-for-visibility'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { entity_scope: 'member', is_active: true },
          sort: { display_order: 'asc' }
        });
        return fields || [];
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
        } catch {
          return [];
        }
      }
    }
  });

  // Fetch hidden field IDs setting
  const { data: hiddenFieldsSetting } = useQuery({
    queryKey: ['preferences-hidden-custom-fields-record'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const found = allSettings.find(s => s.setting_key === 'preferences_hidden_custom_fields');
      return found || null;
    },
    staleTime: 0
  });

  // Initialize hidden field IDs from saved setting
  useEffect(() => {
    if (hiddenFieldsSetting?.setting_value) {
      try {
        const parsed = JSON.parse(hiddenFieldsSetting.setting_value);
        if (Array.isArray(parsed)) {
          setHiddenFieldIds(parsed);
        }
      } catch {
        setHiddenFieldIds([]);
      }
    }
  }, [hiddenFieldsSetting]);

  // Fetch resource categories for visibility configuration
  const { data: resourceCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resource-categories-for-visibility'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('resource_category')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (error) throw error;
      return data || [];
    }
  });

  // Fetch hidden resource category IDs setting
  const { data: hiddenResourceCategoriesSetting } = useQuery({
    queryKey: ['preferences-hidden-resource-categories-record'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const found = allSettings.find(s => s.setting_key === 'preferences_hidden_resource_categories');
      return found || null;
    },
    staleTime: 0
  });

  // Initialize hidden resource category IDs from saved setting
  useEffect(() => {
    if (hiddenResourceCategoriesSetting?.setting_value) {
      try {
        const parsed = JSON.parse(hiddenResourceCategoriesSetting.setting_value);
        if (Array.isArray(parsed)) {
          setHiddenResourceCategoryIds(parsed);
        }
      } catch {
        setHiddenResourceCategoryIds([]);
      }
    }
  }, [hiddenResourceCategoriesSetting]);

  useEffect(() => {
    if (savedOrder && Array.isArray(savedOrder)) {
      // Handle both old format (array of strings) and new format (array of objects)
      const isNewFormat = savedOrder.length > 0 && typeof savedOrder[0] === 'object';
      
      if (isNewFormat) {
        // New format: [{ id: 'section_id', visible: true }, ...]
        const orderedSections = savedOrder
          .map(item => {
            const defaultSection = DEFAULT_SECTION_ORDER.find(s => s.id === item.id);
            if (defaultSection) {
              return { ...defaultSection, visible: item.visible !== false };
            }
            return null;
          })
          .filter(Boolean);
        
        const missingSections = DEFAULT_SECTION_ORDER.filter(
          s => !savedOrder.some(item => item.id === s.id)
        );
        
        setSections([...orderedSections, ...missingSections]);
      } else {
        // Old format: ['section_id', ...]
        const orderedSections = savedOrder
          .map(id => DEFAULT_SECTION_ORDER.find(s => s.id === id))
          .filter(Boolean);
        
        const missingSections = DEFAULT_SECTION_ORDER.filter(
          s => !savedOrder.includes(s.id)
        );
        
        setSections([...orderedSections, ...missingSections]);
      }
    }
  }, [savedOrder]);

  const updateOrderMutation = useMutation({
    mutationFn: async (newOrder) => {
      const orderValue = JSON.stringify(newOrder);
      if (existingSetting) {
        return await base44.entities.SystemSettings.update(existingSetting.id, {
          setting_value: orderValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'preferences_section_order',
          setting_value: orderValue,
          description: 'Order of main card sections on the Preferences page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences-section-order'] });
      queryClient.invalidateQueries({ queryKey: ['preferences-section-order-record'] });
      setHasChanges(false);
      toast.success('Section order saved successfully');
    },
    onError: (error) => {
      console.error('Failed to save section order:', error);
      toast.error('Failed to save section order: ' + error.message);
    }
  });

  // Mutation to save hidden field IDs
  const updateHiddenFieldsMutation = useMutation({
    mutationFn: async (fieldIds) => {
      const value = JSON.stringify(fieldIds);
      if (hiddenFieldsSetting) {
        return await base44.entities.SystemSettings.update(hiddenFieldsSetting.id, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'preferences_hidden_custom_fields',
          setting_value: value,
          description: 'List of custom field IDs hidden from the Preferences page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences-hidden-custom-fields-record'] });
      setFieldVisibilityChanged(false);
      toast.success('Custom field visibility saved');
    },
    onError: (error) => {
      console.error('Failed to save field visibility:', error);
      toast.error('Failed to save field visibility: ' + error.message);
    }
  });

  const handleToggleFieldVisibility = (fieldId) => {
    setHiddenFieldIds(prev => {
      if (prev.includes(fieldId)) {
        return prev.filter(id => id !== fieldId);
      } else {
        return [...prev, fieldId];
      }
    });
    setFieldVisibilityChanged(true);
  };

  const handleSaveFieldVisibility = () => {
    updateHiddenFieldsMutation.mutate(hiddenFieldIds);
  };

  // Mutation to save hidden resource category IDs
  const updateHiddenResourceCategoriesMutation = useMutation({
    mutationFn: async (categoryIds) => {
      const value = JSON.stringify(categoryIds);
      if (hiddenResourceCategoriesSetting) {
        return await base44.entities.SystemSettings.update(hiddenResourceCategoriesSetting.id, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'preferences_hidden_resource_categories',
          setting_value: value,
          description: 'List of resource category IDs hidden from the Preferences page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences-hidden-resource-categories-record'] });
      setResourceVisibilityChanged(false);
      toast.success('Resource category visibility saved');
    },
    onError: (error) => {
      console.error('Failed to save resource category visibility:', error);
      toast.error('Failed to save resource category visibility: ' + error.message);
    }
  });

  const handleToggleResourceCategoryVisibility = (categoryId) => {
    setHiddenResourceCategoryIds(prev => {
      if (prev.includes(categoryId)) {
        return prev.filter(id => id !== categoryId);
      } else {
        return [...prev, categoryId];
      }
    });
    setResourceVisibilityChanged(true);
  };

  const handleSaveResourceCategoryVisibility = () => {
    updateHiddenResourceCategoriesMutation.mutate(hiddenResourceCategoryIds);
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const items = Array.from(sections);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    setSections(items);
    setHasChanges(true);
  };

  const handleSave = () => {
    // Save in new format with visibility
    const orderData = sections.map(s => ({ id: s.id, visible: s.visible !== false }));
    updateOrderMutation.mutate(orderData);
  };

  const handleReset = () => {
    setSections(DEFAULT_SECTION_ORDER);
    setHasChanges(true);
  };

  const handleToggleVisibility = (sectionId) => {
    setSections(prev => prev.map(s => 
      s.id === sectionId ? { ...s, visible: !s.visible } : s
    ));
    setHasChanges(true);
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2 flex items-center gap-3">
              <Settings className="w-8 h-8 text-blue-600" />
              Preferences Page Layout
            </h1>
            <p className="text-slate-600">
              Drag and drop to reorder the main card sections on the member Preferences page
            </p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Main Card Sections</CardTitle>
            <CardDescription>
              Drag sections to change their display order. Changes will apply to all members viewing the Preferences page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="sections">
                {(provided) => (
                  <div
                    {...provided.droppableProps}
                    ref={provided.innerRef}
                    className="space-y-3"
                  >
                    {sections.map((section, index) => {
                      const IconComponent = section.icon;
                      const isVisible = section.visible !== false;
                      return (
                        <Draggable key={section.id} draggableId={section.id} index={index}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={`flex items-center gap-4 p-5 bg-white border rounded-lg transition-all ${
                                snapshot.isDragging ? 'shadow-lg border-blue-300' : 'border-slate-200 hover:border-slate-300'
                              } ${!isVisible ? 'opacity-60' : ''}`}
                            >
                              <div
                                {...provided.dragHandleProps}
                                className="cursor-grab active:cursor-grabbing p-2 hover:bg-slate-100 rounded"
                                data-testid={`drag-handle-${section.id}`}
                              >
                                <GripVertical className="w-5 h-5 text-slate-400" />
                              </div>
                              
                              <div className={`flex items-center justify-center w-12 h-12 rounded-lg flex-shrink-0 ${isVisible ? 'bg-blue-50' : 'bg-slate-100'}`}>
                                <IconComponent className={`w-6 h-6 ${isVisible ? 'text-blue-600' : 'text-slate-400'}`} />
                              </div>
                              
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-3">
                                  <span className={`font-semibold text-lg ${isVisible ? 'text-slate-900' : 'text-slate-500'}`}>{section.label}</span>
                                  <span className="text-sm text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                                    Position {index + 1}
                                  </span>
                                  {!isVisible && (
                                    <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded flex items-center gap-1">
                                      <EyeOff className="w-3 h-3" />
                                      Hidden
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-slate-500 mt-1">{section.description}</p>
                              </div>

                              <div className="flex items-center gap-2 flex-shrink-0">
                                <Label htmlFor={`visibility-${section.id}`} className="text-sm text-slate-600 cursor-pointer">
                                  {isVisible ? <Eye className="w-4 h-4 text-green-600" /> : <EyeOff className="w-4 h-4 text-slate-400" />}
                                </Label>
                                <Switch
                                  id={`visibility-${section.id}`}
                                  checked={isVisible}
                                  onCheckedChange={() => handleToggleVisibility(section.id)}
                                  data-testid={`switch-visibility-${section.id}`}
                                />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      );
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={handleReset}
            className="gap-2"
            data-testid="button-reset-order"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Default
          </Button>
          
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updateOrderMutation.isPending}
            className="gap-2 bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-order"
          >
            {updateOrderMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save Order
          </Button>
        </div>

        <Card className="mt-6 border-blue-200 bg-blue-50">
          <CardContent className="p-4">
            <p className="text-sm text-blue-800">
              <strong>Note:</strong> The Organization Logo section is only visible to organization members (not team members). 
              All other sections are visible to everyone. The content within each card remains fixed.
            </p>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-blue-600" />
                  Custom Fields
                </CardTitle>
                <CardDescription>
                  Manage custom fields that appear in member preferences and organisation profiles
                </CardDescription>
              </div>
              <Link to="/CustomFieldsAdmin">
                <Button className="gap-2" data-testid="link-custom-fields-admin">
                  <ExternalLink className="w-4 h-4" />
                  Manage Custom Fields
                </Button>
              </Link>
            </div>
          </CardHeader>
        </Card>

        {/* Custom Field Visibility on Preferences Page */}
        <Card className="mt-6">
          <CardHeader 
            className="cursor-pointer" 
            onClick={() => setShowFieldVisibility(!showFieldVisibility)}
          >
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <User className="w-5 h-5 text-blue-600" />
                  Custom Field Visibility (Preferences Page)
                </CardTitle>
                <CardDescription>
                  Control which member custom fields appear on the Preferences page
                </CardDescription>
              </div>
              <Button variant="ghost" size="icon">
                {showFieldVisibility ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </Button>
            </div>
          </CardHeader>
          {showFieldVisibility && (
            <CardContent>
              {fieldsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : memberCustomFields.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">
                  No member custom fields have been created yet. 
                  <Link to="/CustomFieldsAdmin" className="text-blue-600 hover:underline ml-1">
                    Create some first
                  </Link>.
                </p>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Toggle which custom fields members can see and edit on their Preferences page:
                  </p>
                  <div className="space-y-2">
                    {memberCustomFields.map(field => {
                      const isVisible = !hiddenFieldIds.includes(field.id);
                      return (
                        <div 
                          key={field.id}
                          className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                            isVisible ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-60'
                          }`}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`font-medium ${isVisible ? 'text-slate-900' : 'text-slate-500'}`}>
                                {field.label || field.field_name}
                              </span>
                              <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                                {field.field_type}
                              </span>
                              {!isVisible && (
                                <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded flex items-center gap-1">
                                  <EyeOff className="w-3 h-3" />
                                  Hidden
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`field-vis-${field.id}`} className="text-sm text-slate-600 cursor-pointer">
                              {isVisible ? <Eye className="w-4 h-4 text-green-600" /> : <EyeOff className="w-4 h-4 text-slate-400" />}
                            </Label>
                            <Switch
                              id={`field-vis-${field.id}`}
                              checked={isVisible}
                              onCheckedChange={() => handleToggleFieldVisibility(field.id)}
                              data-testid={`switch-field-visibility-${field.id}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {fieldVisibilityChanged && (
                    <div className="flex justify-end pt-4 border-t">
                      <Button
                        onClick={handleSaveFieldVisibility}
                        disabled={updateHiddenFieldsMutation.isPending}
                        className="gap-2 bg-blue-600 hover:bg-blue-700"
                        data-testid="button-save-field-visibility"
                      >
                        {updateHiddenFieldsMutation.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        Save Field Visibility
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Resource Category Visibility on Preferences Page */}
        <Card className="mt-6">
          <CardHeader 
            className="cursor-pointer" 
            onClick={() => setShowResourceVisibility(!showResourceVisibility)}
          >
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FolderTree className="w-5 h-5 text-blue-600" />
                  Resource Category Visibility (Preferences Page)
                </CardTitle>
                <CardDescription>
                  Control which resource categories appear in the Resource Interests section on the Preferences page
                </CardDescription>
              </div>
              <Button variant="ghost" size="icon">
                {showResourceVisibility ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </Button>
            </div>
          </CardHeader>
          {showResourceVisibility && (
            <CardContent>
              {categoriesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : resourceCategories.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">
                  No resource categories have been created yet.
                </p>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Toggle which resource categories members can see and select on their Preferences page:
                  </p>
                  <div className="space-y-2">
                    {resourceCategories.map(category => {
                      const isVisible = !hiddenResourceCategoryIds.includes(category.id);
                      return (
                        <div 
                          key={category.id}
                          className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                            isVisible ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-60'
                          }`}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`font-medium ${isVisible ? 'text-slate-900' : 'text-slate-500'}`}>
                                {category.name}
                              </span>
                              {category.subcategories?.length > 0 && (
                                <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                                  {category.subcategories.length} subcategories
                                </span>
                              )}
                              {!isVisible && (
                                <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded flex items-center gap-1">
                                  <EyeOff className="w-3 h-3" />
                                  Hidden
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`category-vis-${category.id}`} className="text-sm text-slate-600 cursor-pointer">
                              {isVisible ? <Eye className="w-4 h-4 text-green-600" /> : <EyeOff className="w-4 h-4 text-slate-400" />}
                            </Label>
                            <Switch
                              id={`category-vis-${category.id}`}
                              checked={isVisible}
                              onCheckedChange={() => handleToggleResourceCategoryVisibility(category.id)}
                              data-testid={`switch-category-visibility-${category.id}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {resourceVisibilityChanged && (
                    <div className="flex justify-end pt-4 border-t">
                      <Button
                        onClick={handleSaveResourceCategoryVisibility}
                        disabled={updateHiddenResourceCategoriesMutation.isPending}
                        className="gap-2 bg-blue-600 hover:bg-blue-700"
                        data-testid="button-save-resource-visibility"
                      >
                        {updateHiddenResourceCategoriesMutation.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                        Save Category Visibility
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Users, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberDirectorySettingsPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [settings, setSettings] = useState({
    show_profile_photo: true,
    show_events: true,
    show_articles: true,
    show_organization: true,
    show_job_title: true,
    show_linkedin: true,
    show_awards: true,
    show_bio_in_popup: true,
    custom_fields: {}
  });

  const queryClient = useQueryClient();

  const { data: displaySettings, isLoading } = useQuery({
    queryKey: ['memberDirectoryDisplay'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'member_directory_display');
      
      if (setting?.setting_value) {
        try {
          const parsed = JSON.parse(setting.setting_value);
          return { id: setting.id, custom_fields: {}, ...parsed };
        } catch (e) {
          console.error('Failed to parse member directory settings:', e);
          return {
            id: setting.id,
            show_profile_photo: true,
            show_events: true,
            show_articles: true,
            show_organization: true,
            show_job_title: true,
            show_linkedin: true,
            show_awards: true,
            show_bio_in_popup: true,
            custom_fields: {}
          };
        }
      }
      
      return {
        show_profile_photo: true,
        show_events: true,
        show_articles: true,
        show_organization: true,
        show_job_title: true,
        show_linkedin: true,
        show_awards: true,
        show_bio_in_popup: true,
        custom_fields: {}
      };
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: directoryFields = [], isLoading: isLoadingFields } = useQuery({
    queryKey: ['member-directory-fields'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member' && f.show_in_member_directory !== false);
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f =>
            (!f.entity_scope || f.entity_scope === 'member') && f.show_in_member_directory !== false
          );
        } catch {
          return [];
        }
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MemberDirectorySettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    if (displaySettings) {
      setSettings(prev => ({
        ...prev,
        ...displaySettings,
        custom_fields: displaySettings.custom_fields || {}
      }));
    }
  }, [displaySettings]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (newSettings) => {
      const { id, ...settingsToSave } = newSettings;
      const settingValue = JSON.stringify(settingsToSave);
      
      if (id) {
        return await base44.entities.SystemSettings.update(id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'member_directory_display',
          setting_value: settingValue,
          description: 'Controls which fields are displayed on Member Directory cards'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memberDirectoryDisplay'] });
      toast.success('Settings saved successfully');
    },
    onError: (error) => {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    }
  });

  const handleToggle = (key) => {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCustomFieldToggle = (fieldId) => {
    setSettings(prev => ({
      ...prev,
      custom_fields: {
        ...prev.custom_fields,
        [fieldId]: !(prev.custom_fields[fieldId] !== false)
      }
    }));
  };

  const handleSave = () => {
    saveSettingsMutation.mutate(settings);
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const CORE_FIELDS = [
    { key: 'show_profile_photo', label: 'Profile Photos', description: 'Display member profile photos on cards' },
    { key: 'show_organization', label: 'Organization', description: "Display the member's organization name" },
    { key: 'show_job_title', label: 'Job Title', description: "Display the member's job title" },
    { key: 'show_linkedin', label: 'LinkedIn Profile', description: 'Display LinkedIn profile link if available' },
    { key: 'show_events', label: 'Events Attended', description: 'Display count of events attended' },
    { key: 'show_articles', label: 'Articles Published', description: 'Display count of published articles' },
    { key: 'show_awards', label: 'Awards', description: "Display member's earned awards" },
    { key: 'show_bio_in_popup', label: 'Biography in Detail View', description: 'Display member biography in the popup detail view' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Member Directory Settings
            </h1>
          </div>
          <p className="text-slate-600">Configure what information displays on member directory cards</p>
        </div>

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>Core Fields</CardTitle>
            <CardDescription>
              Toggle which standard fields appear on member cards in the directory
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {CORE_FIELDS.map(field => (
              <div key={field.key} className="flex items-center justify-between gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div>
                  <Label htmlFor={field.key} className="cursor-pointer font-medium">
                    {field.label}
                  </Label>
                  <p className="text-xs text-slate-500 mt-1">
                    {field.description}
                  </p>
                </div>
                <Switch
                  id={field.key}
                  checked={settings[field.key]}
                  onCheckedChange={() => handleToggle(field.key)}
                  data-testid={`switch-${field.key}`}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {directoryFields.length > 0 && (
          <Card className="border-slate-200 mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SlidersHorizontal className="w-5 h-5" />
                Custom Fields
              </CardTitle>
              <CardDescription>
                These fields have the "Directory" visibility enabled in Custom Fields settings. Toggle which ones appear in the member detail popup.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLoadingFields ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                </div>
              ) : (
                directoryFields.map(field => (
                  <div key={field.id} className="flex items-center justify-between gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                    <div>
                      <Label htmlFor={`custom-${field.id}`} className="cursor-pointer font-medium">
                        {field.label}
                      </Label>
                      <p className="text-xs text-slate-500 mt-1">
                        {field.field_type === 'dropdown' ? 'Dropdown' :
                         field.field_type === 'picklist' ? 'Picklist' :
                         field.field_type === 'number' ? 'Number' :
                         field.field_type === 'date' ? 'Date' :
                         field.field_type === 'boolean' ? 'Yes/No' :
                         'Text'} field
                      </p>
                    </div>
                    <Switch
                      id={`custom-${field.id}`}
                      checked={settings.custom_fields[field.id] !== false}
                      onCheckedChange={() => handleCustomFieldToggle(field.id)}
                      data-testid={`switch-custom-${field.id}`}
                    />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex justify-end pt-6">
          <Button
            onClick={handleSave}
            disabled={saveSettingsMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-settings"
          >
            {saveSettingsMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

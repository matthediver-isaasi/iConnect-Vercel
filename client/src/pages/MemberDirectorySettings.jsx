import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Users } from "lucide-react";
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
    show_bio_in_popup: true
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
          return { id: setting.id, ...parsed };
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
            show_bio_in_popup: true
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
        show_bio_in_popup: true
      };
    },
    staleTime: 0,
    refetchOnMount: true,
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
      setSettings(displaySettings);
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
            <CardTitle>Display Options</CardTitle>
            <CardDescription>
              Toggle which fields appear on member cards in the directory
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-profile-photo" className="cursor-pointer font-medium">
                  Profile Photos
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display member profile photos on cards
                </p>
              </div>
              <Switch
                id="show-profile-photo"
                checked={settings.show_profile_photo}
                onCheckedChange={() => handleToggle('show_profile_photo')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-organization" className="cursor-pointer font-medium">
                  Organization
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display the member's organization name
                </p>
              </div>
              <Switch
                id="show-organization"
                checked={settings.show_organization}
                onCheckedChange={() => handleToggle('show_organization')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-job-title" className="cursor-pointer font-medium">
                  Job Title
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display the member's job title
                </p>
              </div>
              <Switch
                id="show-job-title"
                checked={settings.show_job_title}
                onCheckedChange={() => handleToggle('show_job_title')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-linkedin" className="cursor-pointer font-medium">
                  LinkedIn Profile
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display LinkedIn profile link if available
                </p>
              </div>
              <Switch
                id="show-linkedin"
                checked={settings.show_linkedin}
                onCheckedChange={() => handleToggle('show_linkedin')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-events" className="cursor-pointer font-medium">
                  Events Attended
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display count of events attended
                </p>
              </div>
              <Switch
                id="show-events"
                checked={settings.show_events}
                onCheckedChange={() => handleToggle('show_events')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-articles" className="cursor-pointer font-medium">
                  Articles Published
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display count of published articles
                </p>
              </div>
              <Switch
                id="show-articles"
                checked={settings.show_articles}
                onCheckedChange={() => handleToggle('show_articles')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-awards" className="cursor-pointer font-medium">
                  Awards
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display member's earned awards
                </p>
              </div>
              <Switch
                id="show-awards"
                checked={settings.show_awards}
                onCheckedChange={() => handleToggle('show_awards')}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <Label htmlFor="show-bio-in-popup" className="cursor-pointer font-medium">
                  Biography in Detail View
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Display member biography in the popup detail view
                </p>
              </div>
              <Switch
                id="show-bio-in-popup"
                checked={settings.show_bio_in_popup}
                onCheckedChange={() => handleToggle('show_bio_in_popup')}
              />
            </div>

            <div className="flex justify-end pt-4 border-t border-slate-200">
              <Button
                onClick={handleSave}
                disabled={saveSettingsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
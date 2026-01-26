import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Share2 } from "lucide-react";
import { toast } from "sonner";

const availableSocialIcons = [
  { name: "LinkedIn", key: "linkedin", placeholder: "https://www.linkedin.com/company/..." },
  { name: "Twitter/X", key: "twitter", placeholder: "https://twitter.com/..." },
  { name: "Facebook", key: "facebook", placeholder: "https://www.facebook.com/..." },
  { name: "Instagram", key: "instagram", placeholder: "https://www.instagram.com/..." },
  { name: "YouTube", key: "youtube", placeholder: "https://www.youtube.com/..." }
];

export default function SocialIconsConfig() {
  const [socialConfig, setSocialConfig] = useState({
    linkedin: { enabled: false, url: "" },
    twitter: { enabled: false, url: "" },
    facebook: { enabled: false, url: "" },
    instagram: { enabled: false, url: "" },
    youtube: { enabled: false, url: "" }
  });

  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['social-icons-config'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list() || [];
      const setting = allSettings.find(s => s.setting_key === 'social_icons_config');
      
      if (setting?.setting_value) {
        try {
          return { id: setting.id, ...JSON.parse(setting.setting_value) };
        } catch (e) {
          console.error('Failed to parse social icons config:', e);
          return null;
        }
      }
      return null;
    },
    refetchOnMount: true
  });

  useEffect(() => {
    if (settings) {
      const { id, ...config } = settings;
      setSocialConfig(config);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (config) => {
      const settingValue = JSON.stringify(config);
      
      if (settings?.id) {
        return await base44.entities.SystemSettings.update(settings.id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'social_icons_config',
          setting_value: settingValue,
          description: 'Social media icon URLs and visibility for public header'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-icons-config'] });
      toast.success('Social icons configuration saved');
    },
    onError: (error) => {
      console.error('Failed to save social icons config:', error);
      toast.error('Failed to save configuration');
    }
  });

  const handleToggle = (key) => {
    setSocialConfig(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        enabled: !prev[key].enabled
      }
    }));
  };

  const handleUrlChange = (key, url) => {
    setSocialConfig(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        url
      }
    }));
  };

  const handleSave = () => {
    saveMutation.mutate(socialConfig);
  };

  if (isLoading) {
    return (
      <Card className="border-slate-200 mb-6">
        <CardContent className="p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-slate-200 mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="w-5 h-5 text-blue-600" />
          Social Media Icons
        </CardTitle>
        <p className="text-sm text-slate-600 mt-1">
          Configure which social media icons appear in the top navigation and their URLs
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableSocialIcons.map(({ name, key, placeholder }) => (
          <div key={key} className="flex items-start gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <div className="flex items-center pt-2">
              <Switch
                id={`social-${key}`}
                checked={socialConfig[key]?.enabled || false}
                onCheckedChange={() => handleToggle(key)}
              />
            </div>
            <div className="flex-1 space-y-2">
              <Label htmlFor={`url-${key}`} className="font-medium">
                {name}
              </Label>
              <Input
                id={`url-${key}`}
                value={socialConfig[key]?.url || ""}
                onChange={(e) => handleUrlChange(key, e.target.value)}
                placeholder={placeholder}
                disabled={!socialConfig[key]?.enabled}
              />
            </div>
          </div>
        ))}

        <div className="flex justify-end pt-4 border-t border-slate-200">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Configuration
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
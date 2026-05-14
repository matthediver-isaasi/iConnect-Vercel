import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, LayoutDashboard } from "lucide-react";
import { toast } from "sonner";

const DEFAULT_CONFIG = { login: true, search: true, social: true, logo: true };

const ICONS = [
  {
    key: "login",
    label: "Login",
    description: "Show the Login / Member Area link in the header.",
  },
  {
    key: "search",
    label: "Search",
    description: "Show the Search icon and popover in the header.",
  },
  {
    key: "social",
    label: "Social Icons",
    description:
      "Show the social media icons row in the header. The footer and Social Media tab are not affected.",
  },
  {
    key: "logo",
    label: "Logo",
    description:
      "Show the tenant logo in the public header. Turn off for a clean header without the logo image.",
  },
];

export default function HeaderIconsConfig() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["header-icons-config"],
    queryFn: async () => {
      const allSettings = (await base44.entities.SystemSettings.list()) || [];
      const setting = allSettings.find(
        (s) => s.setting_key === "header_icons_config"
      );

      if (setting?.setting_value) {
        try {
          return { id: setting.id, ...JSON.parse(setting.setting_value) };
        } catch (e) {
          console.error("Failed to parse header icons config:", e);
          return null;
        }
      }
      return null;
    },
    refetchOnMount: true,
  });

  useEffect(() => {
    if (settings) {
      const { id, ...rest } = settings;
      setConfig({ ...DEFAULT_CONFIG, ...rest });
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (next) => {
      const settingValue = JSON.stringify(next);

      if (settings?.id) {
        return await base44.entities.SystemSettings.update(settings.id, {
          setting_value: settingValue,
        });
      }
      return await base44.entities.SystemSettings.create({
        setting_key: "header_icons_config",
        setting_value: settingValue,
        description:
          "Visibility toggles for Login, Search, Social icons, and Logo in the public header",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["header-icons-config"] });
      toast.success("Header icons configuration saved");
    },
    onError: (error) => {
      console.error("Failed to save header icons config:", error);
      toast.error("Failed to save configuration");
    },
  });

  const handleToggle = (key) => {
    setConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = () => {
    saveMutation.mutate(config);
  };

  if (isLoading) {
    return (
      <Card className="border-slate-200">
        <CardContent className="p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-slate-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutDashboard className="w-5 h-5 text-blue-600" />
          Header Icons
        </CardTitle>
        <p className="text-sm text-slate-600 mt-1">
          Choose which utility icons appear in the public header. Turning a
          toggle off hides the icon in both desktop and mobile headers.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {ICONS.map(({ key, label, description }) => (
          <div
            key={key}
            className="flex items-start gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200"
          >
            <div className="flex items-center pt-1">
              <Switch
                id={`header-icon-${key}`}
                checked={!!config[key]}
                onCheckedChange={() => handleToggle(key)}
                data-testid={`switch-header-icon-${key}`}
              />
            </div>
            <div className="flex-1">
              <Label htmlFor={`header-icon-${key}`} className="font-medium">
                {label}
              </Label>
              <p className="text-sm text-slate-500 mt-1">{description}</p>
            </div>
          </div>
        ))}

        <div className="flex justify-end pt-4 border-t border-slate-200">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-header-icons"
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

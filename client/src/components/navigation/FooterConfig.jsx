import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, FileText } from "lucide-react";
import { toast } from "sonner";

export default function FooterConfig() {
  const [footerConfig, setFooterConfig] = useState({
    termsAndConditionsUrl: "",
    privacyPolicyUrl: ""
  });

  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['footer-config'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'footer_config');
      
      if (setting?.setting_value) {
        try {
          return { id: setting.id, ...JSON.parse(setting.setting_value) };
        } catch (e) {
          console.error('Failed to parse footer config:', e);
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
      setFooterConfig(prev => ({
        ...prev,
        ...config
      }));
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
          setting_key: 'footer_config',
          setting_value: settingValue,
          description: 'Footer configuration including Terms and Conditions URL'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['footer-config'] });
      toast.success('Footer configuration saved');
    },
    onError: (error) => {
      console.error('Failed to save footer config:', error);
      toast.error('Failed to save configuration');
    }
  });

  const handleSave = () => {
    saveMutation.mutate(footerConfig);
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
    <Card className="border-slate-200 mb-6" data-testid="card-footer-config">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-600" />
          Footer Configuration
        </CardTitle>
        <p className="text-sm text-slate-600 mt-1">
          Configure footer links and content for the public website
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="terms-url" className="font-medium">
              Terms and Conditions URL
            </Label>
            <Input
              id="terms-url"
              value={footerConfig.termsAndConditionsUrl || ""}
              onChange={(e) => setFooterConfig(prev => ({ ...prev, termsAndConditionsUrl: e.target.value }))}
              placeholder="https://example.com/terms-and-conditions"
              data-testid="input-terms-url"
            />
            <p className="text-xs text-slate-500">
              Enter the URL for your Terms and Conditions page. This will appear as a clickable link in the footer.
            </p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="privacy-url" className="font-medium">
              Privacy Policy URL
            </Label>
            <Input
              id="privacy-url"
              value={footerConfig.privacyPolicyUrl || ""}
              onChange={(e) => setFooterConfig(prev => ({ ...prev, privacyPolicyUrl: e.target.value }))}
              placeholder="https://example.com/privacy-policy"
              data-testid="input-privacy-url"
            />
            <p className="text-xs text-slate-500">
              Enter the URL for your Privacy Policy page. This will appear as a clickable link in the footer.
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-slate-200">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-footer-config"
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

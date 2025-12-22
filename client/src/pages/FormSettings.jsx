import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function FormSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [consentMessage, setConsentMessage] = useState("");
  const [settingId, setSettingId] = useState(null);

  const queryClient = useQueryClient();

  const { data: formSettings, isLoading } = useQuery({
    queryKey: ['formDefaultSettings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'form_default_consent_message');
      
      if (setting?.setting_value) {
        return { id: setting.id, consent_message: setting.setting_value };
      }
      
      return { consent_message: "" };
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    if (formSettings) {
      setConsentMessage(formSettings.consent_message || "");
      setSettingId(formSettings.id || null);
    }
  }, [formSettings]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (newConsentMessage) => {
      if (settingId) {
        return await base44.entities.SystemSettings.update(settingId, {
          setting_value: newConsentMessage
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'form_default_consent_message',
          setting_value: newConsentMessage,
          description: 'Default consent message displayed below form submit buttons'
        });
      }
    },
    onSuccess: (data) => {
      if (data?.id && !settingId) {
        setSettingId(data.id);
      }
      queryClient.invalidateQueries({ queryKey: ['formDefaultSettings'] });
      toast.success('Form settings saved successfully');
    },
    onError: (error) => {
      console.error('Failed to save form settings:', error);
      toast.error('Failed to save form settings');
    }
  });

  const handleSave = () => {
    saveSettingsMutation.mutate(consentMessage);
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center" data-testid="loading-container">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" data-testid="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8" data-testid="form-settings-page">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <ClipboardList className="w-8 h-8 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="page-title">Form Settings</h1>
            <p className="text-slate-500">Configure default settings for all forms</p>
          </div>
        </div>

        <Card data-testid="consent-message-card">
          <CardHeader>
            <CardTitle>Default Consent Message</CardTitle>
            <CardDescription>
              This message will appear below the submit button on all forms. 
              Leave blank if you don't want to display a default consent message.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="consent-message">Consent Message</Label>
              <Textarea
                id="consent-message"
                data-testid="input-consent-message"
                placeholder="e.g., By submitting this form, you agree to our terms and conditions and privacy policy."
                value={consentMessage}
                onChange={(e) => setConsentMessage(e.target.value)}
                rows={4}
                className="resize-none"
              />
            </div>
            <Button 
              onClick={handleSave} 
              disabled={saveSettingsMutation.isPending}
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Mail, Save, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function TeamInviteSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_TeamInviteSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['teamInviteSettings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'team_invite_webhook_url');
    }
  });

  React.useEffect(() => {
    if (settings && !hasLoaded) {
      setWebhookUrl(settings.setting_value || "");
      setHasLoaded(true);
    }
  }, [settings, hasLoaded]);

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      if (settings?.id) {
        await base44.entities.SystemSettings.update(settings.id, {
          setting_value: webhookUrl
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'team_invite_webhook_url',
          setting_value: webhookUrl,
          description: 'Webhook URL for sending team member invitations'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teamInviteSettings'] });
      toast.success('Webhook settings saved');
    },
    onError: (error) => {
      toast.error('Failed to save settings: ' + error.message);
    }
  });

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Team Invite Settings
          </h1>
          <p className="text-slate-600">
            Configure webhook for team member invitations
          </p>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-blue-600" />
              Invitation Webhook
            </CardTitle>
            <CardDescription>
              When a team member invitation is sent, this webhook will be called with the invite details
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="webhookUrl">Webhook URL *</Label>
              <Input
                id="webhookUrl"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://your-webhook-service.com/team-invite"
                className="font-mono text-sm"
              />
              <p className="text-xs text-slate-500">
                The webhook will receive a POST request with the following JSON payload
              </p>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
              <Label className="text-xs text-slate-600 mb-2 block">Example Webhook Payload</Label>
              <pre className="text-xs text-slate-700 overflow-x-auto">
{`{
  "email": "newmember@organisation.com",
  "inviterName": "John Doe",
  "inviterEmail": "john@organisation.com",
  "timestamp": "2025-01-17T10:30:00.000Z"
}`}
              </pre>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-900">
                <p className="font-medium mb-1">Important Notes:</p>
                <ul className="list-disc list-inside space-y-1 text-amber-800">
                  <li>The webhook must accept POST requests with JSON body</li>
                  <li>Invitations can only be sent to email addresses matching the organisation's domain</li>
                  <li>The webhook is responsible for sending the actual invitation email</li>
                </ul>
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-slate-200">
              <Button
                onClick={() => saveSettingsMutation.mutate()}
                disabled={!webhookUrl || saveSettingsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {saveSettingsMutation.isPending ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
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
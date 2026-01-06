import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save, ClipboardList, Mail, FileText, Users } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function FormSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [consentMessage, setConsentMessage] = useState("");
  const [settingId, setSettingId] = useState(null);
  const [newsletterFormId, setNewsletterFormId] = useState("");
  const [newsletterSettingId, setNewsletterSettingId] = useState(null);
  const [statsBarRoleIds, setStatsBarRoleIds] = useState([]);
  const [statsBarSettingId, setStatsBarSettingId] = useState(null);

  const queryClient = useQueryClient();

  const { data: roles, isLoading: rolesLoading } = useQuery({
    queryKey: ['all-roles-list'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 60000,
  });

  const { data: activeForms, isLoading: formsLoading } = useQuery({
    queryKey: ['active-forms-list'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.filter(f => f.is_active);
    },
    staleTime: 60000,
  });

  const { data: formSettings, isLoading } = useQuery({
    queryKey: ['formDefaultSettings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const consentSetting = allSettings.find(s => s.setting_key === 'form_default_consent_message');
      const newsletterSetting = allSettings.find(s => s.setting_key === 'newsletter_signup_form_id');
      const statsBarSetting = allSettings.find(s => s.setting_key === 'submission_stats_allowed_roles');
      
      return {
        id: consentSetting?.id || null,
        consent_message: consentSetting?.setting_value || "",
        newsletter_setting_id: newsletterSetting?.id || null,
        newsletter_form_id: newsletterSetting?.setting_value || "",
        stats_bar_setting_id: statsBarSetting?.id || null,
        stats_bar_role_ids: statsBarSetting?.setting_value ? JSON.parse(statsBarSetting.setting_value) : []
      };
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
      setNewsletterFormId(formSettings.newsletter_form_id || "");
      setNewsletterSettingId(formSettings.newsletter_setting_id || null);
      setStatsBarRoleIds(formSettings.stats_bar_role_ids || []);
      setStatsBarSettingId(formSettings.stats_bar_setting_id || null);
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

  const saveNewsletterFormMutation = useMutation({
    mutationFn: async (formId) => {
      if (newsletterSettingId) {
        return await base44.entities.SystemSettings.update(newsletterSettingId, {
          setting_value: formId
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'newsletter_signup_form_id',
          setting_value: formId,
          description: 'Form used for newsletter signup in the public footer'
        });
      }
    },
    onSuccess: (data) => {
      if (data?.id && !newsletterSettingId) {
        setNewsletterSettingId(data.id);
      }
      queryClient.invalidateQueries({ queryKey: ['formDefaultSettings'] });
      queryClient.invalidateQueries({ queryKey: ['newsletter-signup-form'] });
      toast.success('Newsletter form setting saved');
    },
    onError: (error) => {
      console.error('Failed to save newsletter form setting:', error);
      toast.error('Failed to save newsletter form setting');
    }
  });

  const saveStatsBarRolesMutation = useMutation({
    mutationFn: async (roleIds) => {
      const value = JSON.stringify(roleIds);
      if (statsBarSettingId) {
        return await base44.entities.SystemSettings.update(statsBarSettingId, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'submission_stats_allowed_roles',
          setting_value: value,
          description: 'Role IDs that can see the form submissions stats bar in the sidebar'
        });
      }
    },
    onSuccess: (data) => {
      if (data?.id && !statsBarSettingId) {
        setStatsBarSettingId(data.id);
      }
      queryClient.invalidateQueries({ queryKey: ['formDefaultSettings'] });
      queryClient.invalidateQueries({ queryKey: ['form-submission-stats'] });
      toast.success('Stats bar visibility saved');
    },
    onError: (error) => {
      console.error('Failed to save stats bar roles:', error);
      toast.error('Failed to save stats bar visibility settings');
    }
  });

  const handleSave = () => {
    saveSettingsMutation.mutate(consentMessage);
  };

  const handleNewsletterFormChange = (formId) => {
    setNewsletterFormId(formId);
    saveNewsletterFormMutation.mutate(formId);
  };

  const handleToggleRole = (roleId) => {
    const newRoleIds = statsBarRoleIds.includes(roleId)
      ? statsBarRoleIds.filter(id => id !== roleId)
      : [...statsBarRoleIds, roleId];
    setStatsBarRoleIds(newRoleIds);
    saveStatsBarRolesMutation.mutate(newRoleIds);
  };

  const activeRoles = (roles || []).filter(r => r.is_active !== false);

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

        <Card data-testid="stats-bar-visibility-card" className="mb-6">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <CardTitle>Submission Stats Bar Visibility</CardTitle>
            </div>
            <CardDescription>
              Select which roles can see the form submissions stats bar in the sidebar.
              If no roles are selected, the stats bar will not be visible to anyone.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {rolesLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading roles...
              </div>
            ) : activeRoles.length === 0 ? (
              <p className="text-sm text-slate-500">No active roles found.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {activeRoles.map(role => (
                  <div 
                    key={role.id}
                    className="flex items-center gap-3 p-2 bg-white rounded hover:bg-blue-50 transition-colors cursor-pointer border border-slate-200"
                    onClick={() => handleToggleRole(role.id)}
                    onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? handleToggleRole(role.id) : null}
                    tabIndex={0}
                    role="checkbox"
                    aria-checked={statsBarRoleIds.includes(role.id)}
                    data-testid={`role-checkbox-container-${role.id}`}
                  >
                    <Checkbox
                      id={`stats-role-${role.id}`}
                      checked={statsBarRoleIds.includes(role.id)}
                      className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600 pointer-events-none"
                      tabIndex={-1}
                      data-testid={`checkbox-stats-role-${role.id}`}
                    />
                    <span className="flex-1 text-sm font-medium text-slate-700">
                      <span className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-400" />
                        {role.name}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {saveStatsBarRolesMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                Saving...
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="newsletter-form-card" className="mb-6">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-blue-600" />
              <CardTitle>Newsletter Signup Form</CardTitle>
            </div>
            <CardDescription>
              Select which form to use for the newsletter signup button in the public footer.
              The form must be active to appear in the dropdown.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newsletter-form">Newsletter Form</Label>
              <Select
                value={newsletterFormId}
                onValueChange={handleNewsletterFormChange}
                disabled={formsLoading || saveNewsletterFormMutation.isPending}
              >
                <SelectTrigger id="newsletter-form" data-testid="select-newsletter-form">
                  <SelectValue placeholder="Select a form..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (disable newsletter signup)</SelectItem>
                  {activeForms?.map(form => (
                    <SelectItem key={form.id} value={form.id}>
                      {form.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {saveNewsletterFormMutation.isPending && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Saving...
                </div>
              )}
            </div>
          </CardContent>
        </Card>

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

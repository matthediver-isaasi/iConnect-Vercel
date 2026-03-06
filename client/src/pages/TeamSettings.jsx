import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Settings, Loader2, User, Mail, Briefcase, Shield, Clock, Calendar, FileText, Trophy, ToggleLeft, UserPlus, Link, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const DEFAULT_SETTINGS = {
  show_profile_photo: true,
  show_role_badge: true,
  show_job_title: true,
  show_email: true,
  show_last_activity: true,
  show_login_toggle: true,
  show_events_count: true,
  show_articles_count: true,
  show_awards: true
};

export default function TeamSettingsPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [inviteTemplateId, setInviteTemplateId] = useState(null);
  const [signupLinkTemplate, setSignupLinkTemplate] = useState('');
  const queryClient = useQueryClient();

  const [roleSignupLinks, setRoleSignupLinks] = useState({});

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates-list'],
    queryFn: async () => {
      const templates = await base44.entities.EmailTemplate.list();
      return templates.filter(t => t.is_active !== false);
    }
  });

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const allRoles = await base44.entities.Role.list();
      return allRoles.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
  });

  useEffect(() => {
    if (roles.length > 0) {
      const links = {};
      roles.forEach(r => {
        if (r.signup_link_template) links[r.id] = r.signup_link_template;
      });
      setRoleSignupLinks(prev => {
        const merged = { ...links };
        Object.keys(prev).forEach(k => {
          if (prev[k] !== undefined) merged[k] = prev[k];
        });
        return Object.keys(prev).length === 0 ? links : merged;
      });
    }
  }, [roles]);

  const updateRoleInviteMutation = useMutation({
    mutationFn: async ({ roleId, invite_email_template_id, signup_link_template }) => {
      const updateData = {};
      if (invite_email_template_id !== undefined) updateData.invite_email_template_id = invite_email_template_id;
      if (signup_link_template !== undefined) updateData.signup_link_template = signup_link_template;
      return await base44.entities.Role.update(roleId, updateData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast.success('Role invite settings updated');
    },
    onError: (error) => {
      toast.error('Failed to update role settings: ' + error.message);
    }
  });

  const { data: inviteTemplateSetting } = useQuery({
    queryKey: ['team-invite-template-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'team_invite_email_template') || null;
    }
  });

  useEffect(() => {
    if (inviteTemplateSetting?.setting_value) {
      try {
        const parsed = JSON.parse(inviteTemplateSetting.setting_value);
        setInviteTemplateId(parsed.template_id || null);
      } catch {
        setInviteTemplateId(null);
      }
    }
  }, [inviteTemplateSetting]);

  // Fetch signup link template setting
  const { data: signupLinkSetting } = useQuery({
    queryKey: ['team-signup-link-template-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'team_signup_link_template') || null;
    }
  });

  useEffect(() => {
    if (signupLinkSetting?.setting_value) {
      setSignupLinkTemplate(signupLinkSetting.setting_value);
    }
  }, [signupLinkSetting]);

  const updateInviteTemplateMutation = useMutation({
    mutationFn: async (templateId) => {
      const settingValue = JSON.stringify({ template_id: templateId });
      if (inviteTemplateSetting) {
        return await base44.entities.SystemSettings.update(inviteTemplateSetting.id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'team_invite_email_template',
          setting_value: settingValue,
          description: 'Email template used for team member invitations'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-invite-template-setting'] });
      toast.success('Invite email template updated');
    },
    onError: (error) => {
      toast.error('Failed to update invite template: ' + error.message);
    }
  });

  const updateSignupLinkMutation = useMutation({
    mutationFn: async (linkTemplate) => {
      if (signupLinkSetting) {
        return await base44.entities.SystemSettings.update(signupLinkSetting.id, {
          setting_value: linkTemplate
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'team_signup_link_template',
          setting_value: linkTemplate,
          description: 'Sign up link template shown on Team page with [[organization_id]] placeholder'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-signup-link-template-setting'] });
      toast.success('Sign up link template saved');
    },
    onError: (error) => {
      toast.error('Failed to save sign up link: ' + error.message);
    }
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_TeamSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: savedSettings, isLoading } = useQuery({
    queryKey: ['team-card-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'team_card_display');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return DEFAULT_SETTINGS;
        }
      }
      return DEFAULT_SETTINGS;
    },
    staleTime: 0
  });

  const { data: existingSetting } = useQuery({
    queryKey: ['team-card-settings-record'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const found = allSettings.find(s => s.setting_key === 'team_card_display');
      return found || null;
    },
    staleTime: 0
  });

  useEffect(() => {
    if (savedSettings) {
      setSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
    }
  }, [savedSettings]);

  const updateSettingMutation = useMutation({
    mutationFn: async (newSettings) => {
      const settingValue = JSON.stringify(newSettings);
      if (existingSetting) {
        return await base44.entities.SystemSettings.update(existingSetting.id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'team_card_display',
          setting_value: settingValue,
          description: 'Team card display settings - controls which elements are shown'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-card-settings'] });
      queryClient.invalidateQueries({ queryKey: ['team-card-settings-record'] });
      toast.success('Team card settings updated successfully');
    },
    onError: (error) => {
      console.error('Failed to save team settings:', error);
      toast.error('Failed to update settings: ' + error.message);
    }
  });

  const handleToggle = (key) => {
    setSettings(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const handleSave = () => {
    updateSettingMutation.mutate(settings);
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  const toggleItems = [
    {
      key: 'show_profile_photo',
      label: 'Profile Photo',
      description: 'Show member profile photo or avatar placeholder',
      icon: User
    },
    {
      key: 'show_role_badge',
      label: 'Role Badge',
      description: 'Show member role badge (e.g., Admin, Member)',
      icon: Shield
    },
    {
      key: 'show_job_title',
      label: 'Job Title',
      description: 'Show member job title',
      icon: Briefcase
    },
    {
      key: 'show_email',
      label: 'Email Address',
      description: 'Show member email address',
      icon: Mail
    },
    {
      key: 'show_last_activity',
      label: 'Last Activity',
      description: 'Show when member was last active',
      icon: Clock
    },
    {
      key: 'show_login_toggle',
      label: 'Login Access Toggle',
      description: 'Show toggle to enable/disable member login (admin only)',
      icon: ToggleLeft
    },
    {
      key: 'show_events_count',
      label: 'Events Attended',
      description: 'Show count of events member has attended',
      icon: Calendar
    },
    {
      key: 'show_articles_count',
      label: 'Articles Published',
      description: 'Show count of articles member has published',
      icon: FileText
    },
    {
      key: 'show_awards',
      label: 'Awards',
      description: 'Show awards earned by member',
      icon: Trophy
    }
  ];

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Team Settings</h1>
          <p className="text-slate-600">Configure which elements appear on team member cards</p>
        </div>

        {isLoading ? (
          <Card>
            <CardContent className="p-8">
              <div className="flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Team Card Display Options
                </CardTitle>
                <CardDescription>
                  Toggle which information is displayed on each team member's card. The member's name is always shown.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {toggleItems.map((item) => {
                  const IconComponent = item.icon;
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-between py-4 border-b border-slate-100 last:border-0"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 p-2 bg-slate-100 rounded-lg">
                          <IconComponent className="w-4 h-4 text-slate-600" />
                        </div>
                        <div>
                          <Label htmlFor={item.key} className="text-base font-medium cursor-pointer">
                            {item.label}
                          </Label>
                          <p className="text-sm text-slate-500 mt-0.5">{item.description}</p>
                        </div>
                      </div>
                      <Switch
                        id={item.key}
                        checked={settings[item.key]}
                        onCheckedChange={() => handleToggle(item.key)}
                        data-testid={`toggle-${item.key}`}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserPlus className="w-5 h-5" />
                  Invite Email Template
                </CardTitle>
                <CardDescription>
                  Select the email template to use when inviting new team members. The template can include placeholders like {"{{invitee_email}}"}, {"{{inviter_name}}"}, and {"{{invite_link}}"}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-template">Email Template</Label>
                    <Select
                      value={inviteTemplateId || "__none__"}
                      onValueChange={(value) => {
                        const newId = value === "__none__" ? null : value;
                        setInviteTemplateId(newId);
                        updateInviteTemplateMutation.mutate(newId);
                      }}
                    >
                      <SelectTrigger id="invite-template" className="w-full" data-testid="select-invite-template">
                        <SelectValue placeholder="Select an email template..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None (use default)</SelectItem>
                        {emailTemplates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      The selected template will be pre-loaded in the invite modal, allowing the sender to preview and customize before sending.
                    </p>
                  </div>
                  {inviteTemplateId && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-sm text-green-700">
                        Template selected: <strong>{emailTemplates.find(t => t.id === inviteTemplateId)?.name || 'Unknown'}</strong>
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link className="w-5 h-5" />
                  Team Sign Up Link
                </CardTitle>
                <CardDescription>
                  Configure the sign up link that team members can share. Use <code className="bg-slate-100 px-1 rounded">[[tenant_domain]]</code> for the current portal URL and <code className="bg-slate-100 px-1 rounded">[[organization_id]]</code> for the organisation ID.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-link-template">Link Template</Label>
                    <Input
                      id="signup-link-template"
                      type="text"
                      placeholder="[[tenant_domain]]/FormView?slug=join&organization_id=[[organization_id]]"
                      value={signupLinkTemplate}
                      onChange={(e) => setSignupLinkTemplate(e.target.value)}
                      data-testid="input-signup-link-template"
                    />
                    <p className="text-xs text-slate-500">
                      Example: [[tenant_domain]]/FormView?slug=individual-join&organization_id=[[organization_id]]
                    </p>
                  </div>
                  <Button
                    onClick={() => updateSignupLinkMutation.mutate(signupLinkTemplate)}
                    disabled={updateSignupLinkMutation.isPending}
                    size="sm"
                    data-testid="button-save-signup-link"
                  >
                    {updateSignupLinkMutation.isPending ? 'Saving...' : 'Save Link Template'}
                  </Button>
                  {signupLinkSetting?.setting_value && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-sm text-green-700">
                        Current template: <code className="bg-green-100 px-1 rounded break-all">{signupLinkSetting.setting_value}</code>
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" />
                  Role-Specific Invite Settings
                </CardTitle>
                <CardDescription>
                  Override the default invite email template and sign-up link for specific roles. Roles without overrides will use the default settings above.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {rolesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  </div>
                ) : roles.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4">No roles found.</p>
                ) : (
                  <div className="space-y-4">
                    {roles.map((role) => {
                      const hasOverride = role.invite_email_template_id || role.signup_link_template;
                      return (
                        <div
                          key={role.id}
                          className="border border-slate-200 rounded-md p-4 space-y-3"
                          data-testid={`role-invite-settings-${role.id}`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-slate-900">{role.name}</span>
                            {hasOverride ? (
                              <Badge variant="secondary" className="text-xs">
                                <Check className="w-3 h-3 mr-1" />
                                Custom
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-slate-500">
                                Using Default
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs text-slate-500">Invite Email Template</Label>
                              <Select
                                value={role.invite_email_template_id || "__default__"}
                                onValueChange={(value) => {
                                  const newId = value === "__default__" ? null : value;
                                  updateRoleInviteMutation.mutate({
                                    roleId: role.id,
                                    invite_email_template_id: newId
                                  });
                                }}
                              >
                                <SelectTrigger className="w-full" data-testid={`select-role-template-${role.id}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__default__">Use Default</SelectItem>
                                  {emailTemplates.map((template) => (
                                    <SelectItem key={template.id} value={template.id}>
                                      {template.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs text-slate-500">Sign Up Link</Label>
                              <div className="flex gap-2">
                                <Input
                                  type="text"
                                  placeholder="Use default"
                                  value={roleSignupLinks[role.id] || ''}
                                  onChange={(e) => {
                                    setRoleSignupLinks(prev => ({ ...prev, [role.id]: e.target.value }));
                                  }}
                                  data-testid={`input-role-signup-link-${role.id}`}
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    const val = roleSignupLinks[role.id] || '';
                                    updateRoleInviteMutation.mutate({
                                      roleId: role.id,
                                      signup_link_template: val || null
                                    });
                                  }}
                                  disabled={updateRoleInviteMutation.isPending}
                                  data-testid={`button-save-role-link-${role.id}`}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Preview</CardTitle>
                <CardDescription>
                  This shows which elements will be visible on team cards
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <div className="flex items-start gap-3 mb-3">
                    {settings.show_profile_photo && (
                      <div className="w-12 h-12 rounded-full bg-slate-300 flex items-center justify-center flex-shrink-0">
                        <User className="w-6 h-6 text-slate-500" />
                      </div>
                    )}
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">John Smith</p>
                      {settings.show_role_badge && (
                        <span className="inline-block text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded mt-1">
                          Member
                        </span>
                      )}
                      {settings.show_job_title && (
                        <p className="text-sm text-slate-600 mt-1">Careers Advisor</p>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-2 text-sm">
                    {settings.show_email && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Mail className="w-4 h-4" />
                        <span>john.smith@example.ac.uk</span>
                      </div>
                    )}
                    {settings.show_last_activity && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Clock className="w-4 h-4" />
                        <span>Last active 2 hours ago</span>
                      </div>
                    )}
                    {settings.show_login_toggle && (
                      <div className="flex items-center justify-between py-2 border-y border-slate-200 mt-3">
                        <span className="text-slate-700">Login Access</span>
                        <span className="text-xs text-green-600">Active</span>
                      </div>
                    )}
                    {settings.show_events_count && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-green-600" />
                          <span>Events</span>
                        </div>
                        <span className="bg-slate-200 px-2 py-0.5 rounded text-xs">12</span>
                      </div>
                    )}
                    {settings.show_articles_count && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-purple-600" />
                          <span>Articles</span>
                        </div>
                        <span className="bg-slate-200 px-2 py-0.5 rounded text-xs">5</span>
                      </div>
                    )}
                    {settings.show_awards && (
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-200 mt-2">
                        <Trophy className="w-4 h-4 text-amber-600" />
                        <span className="text-xs font-semibold">Awards (3)</span>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                onClick={handleSave}
                disabled={updateSettingMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-settings"
              >
                {updateSettingMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={updateSettingMutation.isPending}
                data-testid="button-reset-settings"
              >
                Reset to Defaults
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { UserCircle, Save, FileText, Share2, Mail, Filter } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function ResourceSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.resource-settings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: authorSettings, isLoading: settingsLoading, refetch: refetchSettings } = useQuery({
    queryKey: ['resource-author-settings'],
    queryFn: async () => {
      const settings = await base44.entities.ResourceAuthorSettings.list();
      console.log('[ResourceSettings] Fetched settings:', settings);
      return settings.length > 0 ? settings[0] : null;
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [selectedRoles, setSelectedRoles] = useState([]);
  const [descriptionLimit, setDescriptionLimit] = useState(500);
  const [showFolders, setShowFolders] = useState(true);
  const [enabledSocialIcons, setEnabledSocialIcons] = useState(['x', 'linkedin', 'email']);
  const [hideEmptySubcategories, setHideEmptySubcategories] = useState(false);

  // Initialize selected roles and description limit when settings load
  React.useEffect(() => {
    if (authorSettings) {
      setSelectedRoles(authorSettings.author_role_ids || []);
      setDescriptionLimit(authorSettings.description_character_limit || 500);
      setShowFolders(authorSettings.show_folders !== false);
      setEnabledSocialIcons(authorSettings.enabled_social_icons || ['x', 'linkedin', 'email']);
      setHideEmptySubcategories(authorSettings.hide_empty_subcategories === true);
    }
  }, [authorSettings]);

  const saveMutation = useMutation({
    mutationFn: async ({ roleIds, limit, showFolders, socialIcons, hideEmpty }) => {
      // Core payload without hide_empty_subcategories (column may not exist in database)
      const payload = {
        author_role_ids: roleIds,
        description_character_limit: limit,
        show_folders: showFolders,
        enabled_social_icons: socialIcons,
      };
      
      // First, always get fresh settings from the database
      const freshSettings = await base44.entities.ResourceAuthorSettings.list();
      const currentSettings = freshSettings.length > 0 ? freshSettings[0] : null;
      
      console.log('[ResourceSettings] Saving with fresh settings ID:', currentSettings?.id);
      
      // Check if the hide_empty_subcategories column exists by checking if it's in the fetched data
      const columnExists = currentSettings && 'hide_empty_subcategories' in currentSettings;
      if (columnExists) {
        payload.hide_empty_subcategories = hideEmpty;
      } else {
        console.log('[ResourceSettings] hide_empty_subcategories column not in database, skipping');
      }
      
      if (currentSettings) {
        // Update existing settings using the fresh ID
        return await base44.entities.ResourceAuthorSettings.update(currentSettings.id, payload);
      } else {
        // Create new settings
        return await base44.entities.ResourceAuthorSettings.create(payload);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-author-settings'] });
      toast.success('Settings saved successfully');
    },
    onError: (error) => {
      console.error('[ResourceSettings] Save error:', error);
      toast.error('Failed to save settings: ' + error.message);
    }
  });

  const handleToggleRole = (roleId) => {
    setSelectedRoles(prev => {
      if (prev.includes(roleId)) {
        return prev.filter(id => id !== roleId);
      } else {
        return [...prev, roleId];
      }
    });
  };

  const handleToggleSocialIcon = (icon) => {
    setEnabledSocialIcons(prev => {
      if (prev.includes(icon)) {
        return prev.filter(i => i !== icon);
      } else {
        return [...prev, icon];
      }
    });
  };

  const handleSave = () => {
    const limit = parseInt(descriptionLimit);
    if (isNaN(limit) || limit < 1) {
      toast.error('Description limit must be a positive number');
      return;
    }
    saveMutation.mutate({ roleIds: selectedRoles, limit, showFolders, socialIcons: enabledSocialIcons, hideEmpty: hideEmptySubcategories });
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isLoading = rolesLoading || settingsLoading;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Resource Settings
          </h1>
          <p className="text-slate-600">
            Configure resource management preferences
          </p>
        </div>

        {isLoading ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <p className="text-slate-600">Loading settings...</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Author Roles Section */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <UserCircle className="w-5 h-5 text-blue-600" />
                  Author Roles
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4 mb-6">
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-900">
                      Select the roles whose members can be assigned as authors when creating or editing resources. 
                      This includes both regular members and team members with the selected roles.
                    </p>
                  </div>

                  {roles.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-slate-600">No roles available. Create roles first in Role Management.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {roles.map((role) => (
                        <div
                          key={role.id}
                          className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                          onClick={() => handleToggleRole(role.id)}
                        >
                          <Checkbox
                            id={`role-${role.id}`}
                            checked={selectedRoles.includes(role.id)}
                            onCheckedChange={() => handleToggleRole(role.id)}
                            className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                          />
                          <Label
                            htmlFor={`role-${role.id}`}
                            className="flex-1 cursor-pointer"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-900">{role.name}</span>
                            </div>
                            {role.description && (
                              <p className="text-xs text-slate-500 mt-1">{role.description}</p>
                            )}
                          </Label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {selectedRoles.length > 0 && (
                  <div className="p-4 bg-slate-50 rounded-lg">
                    <p className="text-sm font-medium text-slate-900 mb-2">
                      Selected: {selectedRoles.length} {selectedRoles.length === 1 ? 'role' : 'roles'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {selectedRoles.map(roleId => {
                        const role = roles.find(r => r.id === roleId);
                        return role ? (
                          <Badge key={roleId} className="bg-blue-100 text-blue-700">
                            {role.name}
                          </Badge>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Folder View Section */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Folder Management
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Checkbox
                    id="show-folders"
                    checked={showFolders}
                    onCheckedChange={setShowFolders}
                    className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                  />
                  <div className="flex-1">
                    <Label htmlFor="show-folders" className="cursor-pointer font-medium">
                      Show Folder Management
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">
                      Enable folder organisation in the Resource Management page
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Subcategory Filter Settings */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Filter className="w-5 h-5 text-blue-600" />
                  Subcategory Filters
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-900">
                      Control how subcategory filter options are displayed on the Resources page. 
                      When enabled, subcategories with no available resources will be hidden from the filter panel.
                    </p>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                    <Checkbox
                      id="hide-empty-subcategories"
                      checked={hideEmptySubcategories}
                      onCheckedChange={setHideEmptySubcategories}
                      className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                    />
                    <div className="flex-1">
                      <Label htmlFor="hide-empty-subcategories" className="cursor-pointer font-medium">
                        Hide Empty Subcategories
                      </Label>
                      <p className="text-xs text-slate-500 mt-1">
                        Only show subcategory filters that have at least one resource available
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Social Sharing Icons Section */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Share2 className="w-5 h-5 text-blue-600" />
                  Social Sharing Icons
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-900">
                      Choose which social sharing icons to display on public resource cards. 
                      Users will be able to share resources on the selected platforms.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div
                      className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => handleToggleSocialIcon('x')}
                    >
                      <Checkbox
                        id="icon-x"
                        checked={enabledSocialIcons.includes('x')}
                        onCheckedChange={() => handleToggleSocialIcon('x')}
                        className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                      />
                      <Label htmlFor="icon-x" className="flex-1 cursor-pointer flex items-center gap-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                        </svg>
                        <span className="font-medium text-slate-900">X (Twitter)</span>
                      </Label>
                    </div>

                    <div
                      className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => handleToggleSocialIcon('linkedin')}
                    >
                      <Checkbox
                        id="icon-linkedin"
                        checked={enabledSocialIcons.includes('linkedin')}
                        onCheckedChange={() => handleToggleSocialIcon('linkedin')}
                        className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                      />
                      <Label htmlFor="icon-linkedin" className="flex-1 cursor-pointer flex items-center gap-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                        </svg>
                        <span className="font-medium text-slate-900">LinkedIn</span>
                      </Label>
                    </div>

                    <div
                      className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => handleToggleSocialIcon('email')}
                    >
                      <Checkbox
                        id="icon-email"
                        checked={enabledSocialIcons.includes('email')}
                        onCheckedChange={() => handleToggleSocialIcon('email')}
                        className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                      />
                      <Label htmlFor="icon-email" className="flex-1 cursor-pointer flex items-center gap-2">
                        <Mail className="w-4 h-4" />
                        <span className="font-medium text-slate-900">Email</span>
                      </Label>
                    </div>

                    <div
                      className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                      onClick={() => handleToggleSocialIcon('copy')}
                    >
                      <Checkbox
                        id="icon-copy"
                        checked={enabledSocialIcons.includes('copy')}
                        onCheckedChange={() => handleToggleSocialIcon('copy')}
                        className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                      />
                      <Label htmlFor="icon-copy" className="flex-1 cursor-pointer flex items-center gap-2">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span className="font-medium text-slate-900">Copy Link</span>
                      </Label>
                    </div>
                  </div>

                  {enabledSocialIcons.length > 0 && (
                    <div className="p-4 bg-slate-50 rounded-lg">
                      <p className="text-sm font-medium text-slate-900 mb-2">
                        Selected: {enabledSocialIcons.length} {enabledSocialIcons.length === 1 ? 'platform' : 'platforms'}
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Description Limit Section */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Description Character Limit
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-900">
                      Set the maximum number of characters allowed for resource descriptions. 
                      This helps maintain consistent formatting and prevents overly long descriptions.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description-limit">Maximum Characters</Label>
                    <Input
                      id="description-limit"
                      type="number"
                      min="1"
                      value={descriptionLimit}
                      onChange={(e) => setDescriptionLimit(e.target.value)}
                      placeholder="500"
                      className="max-w-xs"
                    />
                    <p className="text-xs text-slate-500">
                      Recommended: 500 characters (approximately 75-100 words)
                    </p>
                  </div>

                  {descriptionLimit && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-sm text-slate-700">
                        Current limit: <span className="font-semibold text-blue-600">{descriptionLimit}</span> characters
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Save Button */}
            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save All Settings'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
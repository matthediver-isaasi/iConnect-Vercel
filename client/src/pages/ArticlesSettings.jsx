import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Settings, Loader2, ThumbsUp, ThumbsDown, MessageSquare, User } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function ArticlesSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [showThumbsUp, setShowThumbsUp] = useState(true);
  const [showThumbsDown, setShowThumbsDown] = useState(true);
  const [showAuthorBio, setShowAuthorBio] = useState(true);
  const [showAuthorLabel, setShowAuthorLabel] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_ArticlesSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['article-display-name-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting;
    },
    staleTime: 0
  });

  // Fetch reaction and author settings
  const { data: reactionSettings, isLoading: reactionsLoading } = useQuery({
    queryKey: ['article-reaction-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const thumbsUpSetting = allSettings.find(s => s.setting_key === 'article_show_thumbs_up');
      const thumbsDownSetting = allSettings.find(s => s.setting_key === 'article_show_thumbs_down');
      const authorBioSetting = allSettings.find(s => s.setting_key === 'article_show_author_bio');
      const authorLabelSetting = allSettings.find(s => s.setting_key === 'article_show_about_author_label');
      return {
        thumbsUp: thumbsUpSetting,
        thumbsDown: thumbsDownSetting,
        authorBio: authorBioSetting,
        authorLabel: authorLabelSetting
      };
    },
    staleTime: 0
  });

  React.useEffect(() => {
    if (settings) {
      setDisplayName(settings.setting_value || 'Articles');
    } else {
      setDisplayName('Articles');
    }
  }, [settings]);

  // Initialize reaction and author bio toggles from settings
  React.useEffect(() => {
    if (reactionSettings) {
      setShowThumbsUp(reactionSettings.thumbsUp?.setting_value !== 'false');
      setShowThumbsDown(reactionSettings.thumbsDown?.setting_value !== 'false');
      setShowAuthorBio(reactionSettings.authorBio?.setting_value !== 'false');
      setShowAuthorLabel(reactionSettings.authorLabel?.setting_value !== 'false');
    }
  }, [reactionSettings]);

  const updateSettingMutation = useMutation({
    mutationFn: async (value) => {
      if (settings) {
        await base44.entities.SystemSettings.update(settings.id, {
          setting_value: value
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'article_display_name',
          setting_value: value,
          setting_type: 'text',
          description: 'Custom display name for articles section'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-display-name-setting'] });
      toast.success('Display name updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update setting: ' + error.message);
    }
  });

  const handleSave = () => {
    if (!displayName.trim()) {
      toast.error('Display name cannot be empty');
      return;
    }
    updateSettingMutation.mutate(displayName.trim());
  };

  // Mutation for updating reaction settings
  const updateReactionSettingMutation = useMutation({
    mutationFn: async ({ key, value, existingSetting }) => {
      if (existingSetting) {
        await base44.entities.SystemSettings.update(existingSetting.id, {
          setting_value: value.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: key,
          setting_value: value.toString(),
          setting_type: 'boolean',
          description: key === 'article_show_thumbs_up' 
            ? 'Show thumbs up button on article view' 
            : 'Show thumbs down button on article view'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-reaction-settings'] });
      queryClient.invalidateQueries({ queryKey: ['article-settings'] });
      toast.success('Reaction setting updated');
    },
    onError: (error) => {
      toast.error('Failed to update setting: ' + error.message);
    }
  });

  const handleThumbsUpToggle = (checked) => {
    setShowThumbsUp(checked);
    updateReactionSettingMutation.mutate({
      key: 'article_show_thumbs_up',
      value: checked,
      existingSetting: reactionSettings?.thumbsUp
    });
  };

  const handleThumbsDownToggle = (checked) => {
    setShowThumbsDown(checked);
    updateReactionSettingMutation.mutate({
      key: 'article_show_thumbs_down',
      value: checked,
      existingSetting: reactionSettings?.thumbsDown
    });
  };

  const handleAuthorBioToggle = (checked) => {
    setShowAuthorBio(checked);
    updateReactionSettingMutation.mutate({
      key: 'article_show_author_bio',
      value: checked,
      existingSetting: reactionSettings?.authorBio
    });
  };

  const handleAuthorLabelToggle = (checked) => {
    setShowAuthorLabel(checked);
    updateReactionSettingMutation.mutate({
      key: 'article_show_about_author_label',
      value: checked,
      existingSetting: reactionSettings?.authorLabel
    });
  };

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
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Articles Settings</h1>
          <p className="text-slate-600">Configure how articles appear throughout the portal</p>
        </div>

        {isLoading || reactionsLoading ? (
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
                  Display Name
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="display-name">Section Display Name</Label>
                  <Input
                    id="display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g., Articles, Blog, Letters, Insights"
                    className="max-w-md"
                  />
                  <p className="text-sm text-slate-500">
                    Customize how this section is labeled throughout the portal. For example, change "Articles" to "Blog", "Letters", or anything else.
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="font-semibold text-blue-900 mb-2">Preview</h4>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li>• Page title: "{displayName || 'Articles'} & Insights"</li>
                    <li>• Management page: "All {displayName || 'Articles'}"</li>
                    <li>• Buttons: "New {displayName?.slice(0, -1) || 'Article'}"</li>
                  </ul>
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={handleSave}
                    disabled={updateSettingMutation.isPending || !displayName.trim()}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {updateSettingMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setDisplayName(settings?.setting_value || 'Articles')}
                    disabled={updateSettingMutation.isPending}
                  >
                    Reset
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  Reaction Buttons
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-900">
                    Control which reaction buttons are displayed on article view pages. 
                    These appear in the comments section and allow readers to provide feedback.
                  </p>
                </div>

                <div className="space-y-4">
                  <div 
                    className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => handleThumbsUpToggle(!showThumbsUp)}
                  >
                    <div className="flex items-center gap-3">
                      <ThumbsUp className="w-5 h-5 text-green-600" />
                      <div>
                        <Label className="font-medium text-slate-900 cursor-pointer">Thumbs Up Button</Label>
                        <p className="text-sm text-slate-500">Allow readers to give positive feedback on comments</p>
                      </div>
                    </div>
                    <Switch
                      checked={showThumbsUp}
                      onCheckedChange={handleThumbsUpToggle}
                      disabled={updateReactionSettingMutation.isPending}
                      data-testid="switch-thumbs-up"
                    />
                  </div>

                  <div 
                    className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => handleThumbsDownToggle(!showThumbsDown)}
                  >
                    <div className="flex items-center gap-3">
                      <ThumbsDown className="w-5 h-5 text-red-600" />
                      <div>
                        <Label className="font-medium text-slate-900 cursor-pointer">Thumbs Down Button</Label>
                        <p className="text-sm text-slate-500">Allow readers to give negative feedback on comments</p>
                      </div>
                    </div>
                    <Switch
                      checked={showThumbsDown}
                      onCheckedChange={handleThumbsDownToggle}
                      disabled={updateReactionSettingMutation.isPending}
                      data-testid="switch-thumbs-down"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="w-5 h-5" />
                  Author Section
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-900">
                    Control what information is displayed in the author section when viewing an article.
                  </p>
                </div>

                <div className="space-y-4">
                  <div 
                    className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => handleAuthorLabelToggle(!showAuthorLabel)}
                  >
                    <div className="flex items-center gap-3">
                      <User className="w-5 h-5 text-blue-600" />
                      <div>
                        <Label className="font-medium text-slate-900 cursor-pointer">Show "About the author" Label</Label>
                        <p className="text-sm text-slate-500">Display the heading text above the author section</p>
                      </div>
                    </div>
                    <Switch
                      checked={showAuthorLabel}
                      onCheckedChange={handleAuthorLabelToggle}
                      disabled={updateReactionSettingMutation.isPending}
                      data-testid="switch-author-label"
                    />
                  </div>

                  <div 
                    className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => handleAuthorBioToggle(!showAuthorBio)}
                  >
                    <div className="flex items-center gap-3">
                      <User className="w-5 h-5 text-blue-600" />
                      <div>
                        <Label className="font-medium text-slate-900 cursor-pointer">Show Author Biography</Label>
                        <p className="text-sm text-slate-500">Display the author's professional biography in the author section</p>
                      </div>
                    </div>
                    <Switch
                      checked={showAuthorBio}
                      onCheckedChange={handleAuthorBioToggle}
                      disabled={updateReactionSettingMutation.isPending}
                      data-testid="switch-author-bio"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
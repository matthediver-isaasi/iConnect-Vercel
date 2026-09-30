import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Users } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  MEMBER_GROUP_SETTING_KEYS,
  MEMBER_GROUP_SETTING_DEFAULTS,
} from "@/hooks/useMemberGroupSettings";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";

const FEATURE_ID = "membership.member-group-settings";

export default function MemberGroupSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  const [eventsPerPage, setEventsPerPage] = useState(
    String(MEMBER_GROUP_SETTING_DEFAULTS.eventsPerPage)
  );
  const [resourcesPerPage, setResourcesPerPage] = useState(
    String(MEMBER_GROUP_SETTING_DEFAULTS.resourcesPerPage)
  );
  const [featureName, setFeatureName] = useState(
    MEMBER_GROUP_SETTING_DEFAULTS.featureName
  );
  const [ticketTypeName, setTicketTypeName] = useState(
    MEMBER_GROUP_SETTING_DEFAULTS.ticketTypeName
  );
  const [defaultTermsOfReference, setDefaultTermsOfReference] = useState(
    MEMBER_GROUP_SETTING_DEFAULTS.defaultTermsOfReference
  );
  const [allowGroupTermsOverride, setAllowGroupTermsOverride] = useState(
    MEMBER_GROUP_SETTING_DEFAULTS.allowGroupTermsOverride
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded(FEATURE_ID)) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["system-settings"],
    queryFn: () => base44.entities.SystemSettings.list(),
    staleTime: 0,
    refetchOnMount: true,
    enabled: accessChecked,
  });

  useEffect(() => {
    const eventsSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.eventsPerPage
    );
    if (eventsSetting?.setting_value) setEventsPerPage(String(eventsSetting.setting_value));

    const resourcesSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.resourcesPerPage
    );
    if (resourcesSetting?.setting_value) setResourcesPerPage(String(resourcesSetting.setting_value));

    const nameSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.featureName
    );
    if (nameSetting?.setting_value) setFeatureName(nameSetting.setting_value);

    const ticketSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.ticketTypeName
    );
    if (ticketSetting?.setting_value) setTicketTypeName(ticketSetting.setting_value);

    const torSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.defaultTermsOfReference
    );
    if (torSetting !== undefined) {
      setDefaultTermsOfReference(torSetting?.setting_value ?? "");
    }

    const overrideSetting = settings.find(
      (s) => s.setting_key === MEMBER_GROUP_SETTING_KEYS.allowGroupTermsOverride
    );
    if (overrideSetting !== undefined) {
      setAllowGroupTermsOverride(overrideSetting?.setting_value !== "false");
    }
  }, [settings]);

  const upsertSetting = async (key, value, description) => {
    const existing = settings.find((s) => s.setting_key === key);
    if (existing) {
      await base44.entities.SystemSettings.update(existing.id, {
        setting_value: value,
        description,
      });
    } else {
      await base44.entities.SystemSettings.create({
        setting_key: key,
        setting_value: value,
        description,
      });
    }
  };

  const handleSave = async () => {
    const eventsNum = parseInt(eventsPerPage, 10);
    const resourcesNum = parseInt(resourcesPerPage, 10);

    if (!Number.isFinite(eventsNum) || eventsNum < 1) {
      toast.error("Events per page must be a positive whole number.");
      return;
    }
    if (!Number.isFinite(resourcesNum) || resourcesNum < 1) {
      toast.error("Resources per page must be a positive whole number.");
      return;
    }

    const trimmedName = featureName.trim();
    const trimmedTicket = ticketTypeName.trim();

    setIsSaving(true);
    try {
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.eventsPerPage,
        String(eventsNum),
        "Number of events shown per page on a member group detail page"
      );
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.resourcesPerPage,
        String(resourcesNum),
        "Number of resources shown per page on a member group detail page"
      );
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.featureName,
        trimmedName,
        "Display name for the Member Groups feature (route unchanged)"
      );
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.ticketTypeName,
        trimmedTicket,
        "Default ticket type name used for member group events"
      );
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.defaultTermsOfReference,
        defaultTermsOfReference ?? "",
        "Default terms of reference applied to all member groups"
      );
      await upsertSetting(
        MEMBER_GROUP_SETTING_KEYS.allowGroupTermsOverride,
        allowGroupTermsOverride ? "true" : "false",
        "Whether individual member groups can override the default terms of reference"
      );

      await queryClient.invalidateQueries({ queryKey: ["system-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["member-group-settings"] });
      toast.success("Member group settings saved");
    } catch (error) {
      console.error("Failed to save member group settings:", error);
      toast.error("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Users className="w-7 h-7 text-blue-600" />
          <div>
            <h1
              className="text-2xl md:text-3xl font-bold text-slate-900"
              data-testid="text-page-title"
            >
              Member Group Settings
            </h1>
            <p className="text-slate-600">
              Customise how the member groups feature behaves and is labelled.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Detail page pagination</CardTitle>
            <CardDescription>
              Control how many cards appear per page on a member group detail page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="events-per-page">Events per page</Label>
              <Input
                id="events-per-page"
                type="number"
                min="1"
                value={eventsPerPage}
                onChange={(e) => setEventsPerPage(e.target.value)}
                data-testid="input-events-per-page"
              />
              <p className="text-xs text-slate-500">
                Defaults to {MEMBER_GROUP_SETTING_DEFAULTS.eventsPerPage} when unset.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resources-per-page">Resources per page</Label>
              <Input
                id="resources-per-page"
                type="number"
                min="1"
                value={resourcesPerPage}
                onChange={(e) => setResourcesPerPage(e.target.value)}
                data-testid="input-resources-per-page"
              />
              <p className="text-xs text-slate-500">
                Defaults to {MEMBER_GROUP_SETTING_DEFAULTS.resourcesPerPage} when unset.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Labels</CardTitle>
            <CardDescription>
              These names appear in the interface. The page address is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="feature-name">Feature display name</Label>
              <Input
                id="feature-name"
                value={featureName}
                onChange={(e) => setFeatureName(e.target.value)}
                placeholder={MEMBER_GROUP_SETTING_DEFAULTS.featureName}
                data-testid="input-feature-name"
              />
              <p className="text-xs text-slate-500">
                Falls back to "{MEMBER_GROUP_SETTING_DEFAULTS.featureName}" when left blank.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ticket-type-name">Member group event ticket type name</Label>
              <Input
                id="ticket-type-name"
                value={ticketTypeName}
                onChange={(e) => setTicketTypeName(e.target.value)}
                placeholder={MEMBER_GROUP_SETTING_DEFAULTS.ticketTypeName}
                data-testid="input-ticket-type-name"
              />
              <p className="text-xs text-slate-500">
                Falls back to "{MEMBER_GROUP_SETTING_DEFAULTS.ticketTypeName}" when left blank.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Default Terms of Reference</CardTitle>
            <CardDescription>
              Set a default terms of reference that applies to all member groups. Groups without their own terms will use this text at join time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="allow-group-terms-override">Allow groups to override the default terms of reference</Label>
                <p className="text-xs text-slate-500">
                  When off, the default terms apply to every group and individual groups cannot set their own.
                </p>
              </div>
              <Switch
                id="allow-group-terms-override"
                checked={allowGroupTermsOverride}
                onCheckedChange={setAllowGroupTermsOverride}
                data-testid="switch-allow-group-terms-override"
              />
            </div>
            <div className="space-y-2">
              <Label>Default terms of reference</Label>
              <SimpleRichTextEditor
                content={defaultTermsOfReference}
                onChange={(html) => setDefaultTermsOfReference(html)}
                placeholder="Enter default terms of reference for member groups..."
                className="min-h-[260px] [&_.tiptap]:min-h-[220px]"
                data-testid="input-default-terms-of-reference"
              />
              <p className="text-xs text-slate-500">
                Optional. Groups that have not set their own terms of reference will show this text to members at join time.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving || isLoading} data-testid="button-save">
            {isSaving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}

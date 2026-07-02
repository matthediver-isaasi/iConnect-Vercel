import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Save, Settings, Search, Building, Filter, Shield } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function OrganisationDirectorySettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();
  const [directoryHeader, setDirectoryHeader] = useState("Organisation Directory");
  const [showLogo, setShowLogo] = useState(true);
  const [showTitle, setShowTitle] = useState(true);
  const [showDomains, setShowDomains] = useState(true);
  const [showMemberCount, setShowMemberCount] = useState(true);
  const [showNameTooltip, setShowNameTooltip] = useState(false);
  const [cardsPerRow, setCardsPerRow] = useState("3");
  const [excludedOrgIds, setExcludedOrgIds] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [allowedApplicationStatuses, setAllowedApplicationStatuses] = useState([]);
  const [visibleOrgTypes, setVisibleOrgTypes] = useState([]);
  const [reverseCardRoleIds, setReverseCardRoleIds] = useState([]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('membership.organisation-directory-settings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Fetch all organizations
  const { data: organizations = [] } = useQuery({
    queryKey: ['all-organizations'],
    queryFn: () => base44.entities.Organization.list('name')
  });

  // Fetch all roles for the reverse card multi-select
  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-org-directory-settings'],
    queryFn: async () => {
      const allRoles = await base44.entities.Role.list();
      return (allRoles || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    staleTime: 5 * 60 * 1000
  });

  // Fetch organization custom fields to get application_status options
  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['org-custom-fields-for-directory-settings'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' }
        });
        return fields || [];
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    }
  });

  // Find the application_status field
  const applicationStatusField = useMemo(() => {
    return orgCustomFields.find(f => f.name === 'application_status');
  }, [orgCustomFields]);

  // Find the org_type field
  const orgTypeField = useMemo(() => {
    return orgCustomFields.find(f =>
      f.name === 'org_type' || f.name === 'organisation_type' || f.name === 'organization_type'
    );
  }, [orgCustomFields]);

  const orgTypeOptions = useMemo(() => {
    if (!orgTypeField?.options) return [];
    return orgTypeField.options.map(opt => {
      if (typeof opt === 'string') {
        return { value: opt, label: opt };
      }
      return { value: opt.value || opt, label: opt.label || opt.value || opt };
    });
  }, [orgTypeField]);

  // Normalize application_status options to ensure we always have { value, label } pairs
  const applicationStatusOptions = useMemo(() => {
    if (!applicationStatusField?.options) return [];
    return applicationStatusField.options.map(opt => {
      // Handle both string options and object options with value/label
      if (typeof opt === 'string') {
        return { value: opt, label: opt };
      }
      return { value: opt.value || opt, label: opt.label || opt.value || opt };
    });
  }, [applicationStatusField]);

  // Fetch current settings
  const { data: settings } = useQuery({
    queryKey: ['organisation-directory-settings-admin'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const headerSetting = allSettings.find((s) => s.setting_key === 'org_directory_header');
      const logoSetting = allSettings.find((s) => s.setting_key === 'org_directory_show_logo');
      const titleSetting = allSettings.find((s) => s.setting_key === 'org_directory_show_title');
      const domainsSetting = allSettings.find((s) => s.setting_key === 'org_directory_show_domains');
      const memberCountSetting = allSettings.find((s) => s.setting_key === 'org_directory_show_member_count');
      const nameTooltipSetting = allSettings.find((s) => s.setting_key === 'org_directory_show_name_tooltip');
      const cardsPerRowSetting = allSettings.find((s) => s.setting_key === 'org_directory_cards_per_row');
      const excludedOrgsSetting = allSettings.find((s) => s.setting_key === 'org_directory_excluded_orgs');
      const allowedStatusesSetting = allSettings.find((s) => s.setting_key === 'org_directory_allowed_application_statuses');
      const visibleOrgTypesSetting = allSettings.find((s) => s.setting_key === 'org_directory_visible_org_types');
      const reverseCardRolesSetting = allSettings.find((s) => s.setting_key === 'org_directory_reverse_card_role_ids');
      return {
        header: headerSetting,
        logo: logoSetting,
        title: titleSetting,
        domains: domainsSetting,
        memberCount: memberCountSetting,
        nameTooltip: nameTooltipSetting,
        cardsPerRow: cardsPerRowSetting,
        excludedOrgs: excludedOrgsSetting,
        allowedStatuses: allowedStatusesSetting,
        visibleOrgTypes: visibleOrgTypesSetting,
        reverseCardRoles: reverseCardRolesSetting
      };
    },
    refetchOnMount: true
  });

  useEffect(() => {
    if (settings?.header) {
      setDirectoryHeader(settings.header.setting_value || "Organisation Directory");
    }
    if (settings?.logo) {
      setShowLogo(settings.logo.setting_value === 'true');
    }
    if (settings?.title) {
      setShowTitle(settings.title.setting_value !== 'false'); // Default to true if not set
    }
    if (settings?.domains) {
      setShowDomains(settings.domains.setting_value === 'true');
    }
    if (settings?.memberCount) {
      setShowMemberCount(settings.memberCount.setting_value === 'true');
    }
    if (settings?.nameTooltip) {
      setShowNameTooltip(settings.nameTooltip.setting_value === 'true');
    }
    if (settings?.cardsPerRow) {
      setCardsPerRow(settings.cardsPerRow.setting_value || "3");
    }
    if (settings?.excludedOrgs) {
      try {
        const excluded = JSON.parse(settings.excludedOrgs.setting_value);
        setExcludedOrgIds(Array.isArray(excluded) ? excluded : []);
      } catch {
        setExcludedOrgIds([]);
      }
    }
    if (settings?.allowedStatuses) {
      try {
        const statuses = JSON.parse(settings.allowedStatuses.setting_value);
        setAllowedApplicationStatuses(Array.isArray(statuses) ? statuses : []);
      } catch {
        setAllowedApplicationStatuses([]);
      }
    }
    if (settings?.visibleOrgTypes) {
      try {
        const types = JSON.parse(settings.visibleOrgTypes.setting_value);
        setVisibleOrgTypes(Array.isArray(types) ? types : []);
      } catch {
        setVisibleOrgTypes([]);
      }
    }
    if (settings?.reverseCardRoles) {
      try {
        const ids = JSON.parse(settings.reverseCardRoles.setting_value);
        setReverseCardRoleIds(Array.isArray(ids) ? ids : []);
      } catch {
        setReverseCardRoleIds([]);
      }
    }
  }, [settings]);

  // Handler for toggling logo - ensures at least one of logo/title is enabled
  const handleLogoToggle = (checked) => {
    if (!checked && !showTitle) {
      toast.error('At least one of Logo or Title must be enabled');
      return;
    }
    setShowLogo(checked);
  };

  // Handler for toggling title - ensures at least one of logo/title is enabled
  const handleTitleToggle = (checked) => {
    if (!checked && !showLogo) {
      toast.error('At least one of Logo or Title must be enabled');
      return;
    }
    setShowTitle(checked);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Validation: at least one of logo or title must be enabled
      if (!showLogo && !showTitle) {
        throw new Error('At least one of Logo or Title must be enabled');
      }

      // Save header setting
      if (settings?.header) {
        await base44.entities.SystemSettings.update(settings.header.id, {
          setting_value: directoryHeader.trim() || 'Organisation Directory'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_header',
          setting_value: directoryHeader.trim() || 'Organisation Directory',
          description: 'Page header title for the organisation directory'
        });
      }

      // Save logo setting
      if (settings?.logo) {
        await base44.entities.SystemSettings.update(settings.logo.id, {
          setting_value: showLogo.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_show_logo',
          setting_value: showLogo.toString(),
          description: 'Show organisation logo on directory cards'
        });
      }

      // Save title setting
      if (settings?.title) {
        await base44.entities.SystemSettings.update(settings.title.id, {
          setting_value: showTitle.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_show_title',
          setting_value: showTitle.toString(),
          description: 'Show organisation title on directory cards'
        });
      }

      // Save domains setting
      if (settings?.domains) {
        await base44.entities.SystemSettings.update(settings.domains.id, {
          setting_value: showDomains.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_show_domains',
          setting_value: showDomains.toString(),
          description: 'Show organisation domains on directory cards'
        });
      }

      // Save member count setting
      if (settings?.memberCount) {
        await base44.entities.SystemSettings.update(settings.memberCount.id, {
          setting_value: showMemberCount.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_show_member_count',
          setting_value: showMemberCount.toString(),
          description: 'Show member count on directory cards'
        });
      }

      // Save name tooltip setting
      if (settings?.nameTooltip) {
        await base44.entities.SystemSettings.update(settings.nameTooltip.id, {
          setting_value: showNameTooltip.toString()
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_show_name_tooltip',
          setting_value: showNameTooltip.toString(),
          description: 'Show organisation name as tooltip on hover'
        });
      }

      // Save cards per row setting
      if (settings?.cardsPerRow) {
        await base44.entities.SystemSettings.update(settings.cardsPerRow.id, {
          setting_value: cardsPerRow
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_cards_per_row',
          setting_value: cardsPerRow,
          description: 'Number of organisation cards to show per row'
        });
      }

      // Save excluded organizations setting
      if (settings?.excludedOrgs) {
        await base44.entities.SystemSettings.update(settings.excludedOrgs.id, {
          setting_value: JSON.stringify(excludedOrgIds)
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_excluded_orgs',
          setting_value: JSON.stringify(excludedOrgIds),
          description: 'List of organisation IDs excluded from the directory'
        });
      }

      // Save allowed application statuses setting
      if (settings?.allowedStatuses) {
        await base44.entities.SystemSettings.update(settings.allowedStatuses.id, {
          setting_value: JSON.stringify(allowedApplicationStatuses)
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_allowed_application_statuses',
          setting_value: JSON.stringify(allowedApplicationStatuses),
          description: 'List of application_status values that allow an organisation to appear in the directory'
        });
      }

      // Save visible organisation types setting
      if (settings?.visibleOrgTypes) {
        await base44.entities.SystemSettings.update(settings.visibleOrgTypes.id, {
          setting_value: JSON.stringify(visibleOrgTypes)
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_visible_org_types',
          setting_value: JSON.stringify(visibleOrgTypes),
          description: 'List of organisation type values that allow an organisation to appear in the directory'
        });
      }

      // Save reverse card role IDs setting
      if (settings?.reverseCardRoles) {
        await base44.entities.SystemSettings.update(settings.reverseCardRoles.id, {
          setting_value: JSON.stringify(reverseCardRoleIds)
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'org_directory_reverse_card_role_ids',
          setting_value: JSON.stringify(reverseCardRoleIds),
          description: 'List of role IDs whose members are listed on the reverse of organisation directory cards'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisation-directory-settings-admin'] });
      queryClient.invalidateQueries({ queryKey: ['organisation-directory-settings'] });
      toast.success('Settings saved successfully');
    },
    onError: (error) => {
      toast.error('Failed to save settings: ' + error.message);
    }
  });

  const toggleOrganization = (orgId) => {
    setExcludedOrgIds((prev) =>
    prev.includes(orgId) ?
    prev.filter((id) => id !== orgId) :
    [...prev, orgId]
    );
  };

  const toggleApplicationStatus = (status) => {
    setAllowedApplicationStatuses((prev) =>
      prev.includes(status)
        ? prev.filter((s) => s !== status)
        : [...prev, status]
    );
  };

  const toggleOrgType = (typeValue) => {
    setVisibleOrgTypes((prev) =>
      prev.includes(typeValue)
        ? prev.filter((t) => t !== typeValue)
        : [...prev, typeValue]
    );
  };

  const toggleReverseCardRole = (roleId) => {
    setReverseCardRoleIds((prev) =>
      prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId]
    );
  };

  const filteredOrganizations = organizations.filter((org) =>
  org.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-slate-600">Loading...</p>
            </CardContent>
          </Card>
        </div>
      </div>);

  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2 flex items-center gap-3">
            <Settings className="w-8 h-8" />
            Organisation Directory Settings
          </h1>
          <p className="text-slate-600">
            Configure what information is displayed on organisation directory cards
          </p>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Display Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-4 bg-slate-50 rounded-lg space-y-2">
              <Label htmlFor="directoryHeader" className="text-base font-medium">
                Page Header
              </Label>
              <p className="text-sm text-slate-600">
                The heading displayed at the top of the organisation directory page
              </p>
              <Input
                id="directoryHeader"
                value={directoryHeader}
                onChange={(e) => setDirectoryHeader(e.target.value)}
                placeholder="Organisation Directory"
                data-testid="input-directory-header"
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="showLogo" className="text-base font-medium cursor-pointer">
                  Show Organization Logo
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Display organization logos on directory cards
                </p>
              </div>
              <input
                type="checkbox"
                id="showLogo"
                checked={showLogo}
                onChange={(e) => handleLogoToggle(e.target.checked)}
                className="w-5 h-5 cursor-pointer" />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="showTitle" className="text-base font-medium cursor-pointer">
                  Show Organization Title
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Display organization name on directory cards
                </p>
              </div>
              <input
                type="checkbox"
                id="showTitle"
                checked={showTitle}
                onChange={(e) => handleTitleToggle(e.target.checked)}
                className="w-5 h-5 cursor-pointer" />
            </div>

            {(!showLogo || !showTitle) && (
              <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg">
                <p className="text-sm text-warning">
                  Note: At least one of Logo or Title must be enabled for cards to display content.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="showDomains" className="text-base font-medium cursor-pointer">
                  Show Domains
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Display organization domains on directory cards
                </p>
              </div>
              <input
                type="checkbox"
                id="showDomains"
                checked={showDomains}
                onChange={(e) => setShowDomains(e.target.checked)}
                className="w-5 h-5 cursor-pointer" />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="showMemberCount" className="text-base font-medium cursor-pointer">
                  Show Member Count
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Display the number of members from each organisation
                </p>
              </div>
              <input
                type="checkbox"
                id="showMemberCount"
                checked={showMemberCount}
                onChange={(e) => setShowMemberCount(e.target.checked)}
                className="w-5 h-5 cursor-pointer" />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="showNameTooltip" className="text-base font-medium cursor-pointer">
                  Show Name Tooltip on Hover
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Display the organisation name as a tooltip when hovering over a card
                </p>
              </div>
              <input
                type="checkbox"
                id="showNameTooltip"
                checked={showNameTooltip}
                onChange={(e) => setShowNameTooltip(e.target.checked)}
                className="w-5 h-5 cursor-pointer" />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div>
                <Label htmlFor="cardsPerRow" className="text-base font-medium">
                  Cards Per Row
                </Label>
                <p className="text-sm text-slate-600 mt-1">
                  Number of organisation cards to display per row on large screens
                </p>
              </div>
              <Select value={cardsPerRow} onValueChange={setCardsPerRow}>
                <SelectTrigger className="w-24" data-testid="select-cards-per-row">
                  <SelectValue placeholder="3" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="4">4</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="6">6</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="pt-4 border-t">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700">

                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {applicationStatusField && applicationStatusOptions.length > 0 && (
          <Card className="border-slate-200 shadow-sm mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="w-5 h-5" />
                Application Status Filter
              </CardTitle>
              <p className="text-sm text-slate-600 mt-2">
                Only show organisations with specific application status values. If no statuses are selected, all organisations will be shown.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {applicationStatusOptions.map((opt) => (
                  <div
                    key={opt.value}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <span className="font-medium text-slate-900">{opt.label}</span>
                    <Checkbox
                      checked={allowedApplicationStatuses.includes(opt.value)}
                      onCheckedChange={() => toggleApplicationStatus(opt.value)}
                      data-testid={`checkbox-status-${String(opt.value).toLowerCase().replace(/\s+/g, '-')}`}
                    />
                  </div>
                ))}
              </div>

              {allowedApplicationStatuses.length > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    Only showing organisations with status: {allowedApplicationStatuses.map(val => {
                      const opt = applicationStatusOptions.find(o => o.value === val);
                      return opt?.label || val;
                    }).join(', ')}
                  </p>
                </div>
              )}

              {allowedApplicationStatuses.length === 0 && (
                <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg">
                  <p className="text-sm text-warning">
                    No filter applied - all organisations will be shown regardless of application status
                  </p>
                </div>
              )}

              <div className="pt-4 border-t">
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {orgTypeField && orgTypeOptions.length > 0 && (
          <Card className="border-slate-200 shadow-sm mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="w-5 h-5" />
                Organisation Type Filter
              </CardTitle>
              <p className="text-sm text-slate-600 mt-2">
                Only show organisations with specific types. If no types are selected, all organisations will be shown.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {orgTypeOptions.map((opt) => (
                  <div
                    key={opt.value}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <span className="font-medium text-slate-900">{opt.label}</span>
                    <Checkbox
                      checked={visibleOrgTypes.includes(opt.value)}
                      onCheckedChange={() => toggleOrgType(opt.value)}
                      data-testid={`checkbox-org-type-${String(opt.value).toLowerCase().replace(/\s+/g, '-')}`}
                    />
                  </div>
                ))}
              </div>

              {visibleOrgTypes.length > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    Only showing organisations with type: {visibleOrgTypes.map(val => {
                      const opt = orgTypeOptions.find(o => o.value === val);
                      return opt?.label || val;
                    }).join(', ')}
                  </p>
                </div>
              )}

              {visibleOrgTypes.length === 0 && (
                <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg">
                  <p className="text-sm text-warning">
                    No filter applied - all organisations will be shown regardless of type
                  </p>
                </div>
              )}

              <div className="pt-4 border-t">
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-slate-200 shadow-sm mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Reverse card member roles
            </CardTitle>
            <p className="text-sm text-slate-600 mt-2">
              Members holding any of the selected roles will be listed as contacts on the reverse of each organisation's card.
              If no roles are selected, the contacts section will not appear.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {roles.length === 0 ? (
              <p className="text-sm text-slate-500">No roles found.</p>
            ) : (
              <div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                data-testid="select-reverse-card-roles"
              >
                {roles.map((role) => {
                  const isChecked = reverseCardRoleIds.includes(role.id);
                  return (
                    <label
                      key={role.id}
                      className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover-elevate"
                      data-testid={`checkbox-reverse-card-role-${role.id}`}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleReverseCardRole(role.id)}
                      />
                      <span className="text-sm font-medium text-slate-700 truncate">{role.name}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {reverseCardRoleIds.length > 0 && (
              <p className="text-xs text-slate-500">
                {reverseCardRoleIds.length} role{reverseCardRoleIds.length !== 1 ? 's' : ''} selected
              </p>
            )}

            <div className="pt-4 border-t">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-reverse-card-roles"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm mt-6">
          <CardHeader>
            <CardTitle className="text-2xl font-semibold leading-none tracking-tight">Exclude Organisations</CardTitle>
            <p className="text-sm text-slate-600 mt-2">
              Hide specific organisations from appearing in the directory
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search organisations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10" />

            </div>

            <div className="max-h-96 overflow-y-auto space-y-2 border border-slate-200 rounded-lg p-4">
              {filteredOrganizations.length === 0 ?
              <p className="text-center text-slate-500 py-4">No organizations found</p> :

              filteredOrganizations.map((org) =>
              <div
                key={org.id}
                className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">

                    <div className="flex items-center gap-3">
                      <Building className="w-5 h-5 text-slate-400" />
                      <div>
                        <p className="font-medium text-slate-900">{org.name}</p>
                        {org.domain &&
                    <p className="text-xs text-slate-500">{org.domain}</p>
                    }
                      </div>
                    </div>
                    <input
                  type="checkbox"
                  checked={!excludedOrgIds.includes(org.id)}
                  onChange={() => toggleOrganization(org.id)}
                  className="w-5 h-5 cursor-pointer"
                  title={excludedOrgIds.includes(org.id) ? "Click to include" : "Click to exclude"} />

                  </div>
              )
              }
            </div>

            {excludedOrgIds.length > 0 &&
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm text-blue-800">
                  {excludedOrgIds.length} organization{excludedOrgIds.length !== 1 ? 's' : ''} excluded from directory
                </p>
              </div>
            }

            <div className="pt-4 border-t">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700">

                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>);

}
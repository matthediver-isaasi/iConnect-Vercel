import { useState, useMemo, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Building2, Search, Globe, Users, Loader2, ChevronLeft, ChevronRight, ArrowDownAZ, ArrowUpZA, Pencil, Trash2, Upload, ExternalLink, ClipboardList, User, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";

export default function DynamicDirectoryView() {
  const { slug } = useParams();
  const { isAdmin, isFeatureExcluded } = useMemberAccess();
  const queryClient = useQueryClient();

  const canEditLogos = isAdmin && !isFeatureExcluded('action_org_logo_edit');
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(12);
  const [sortOrder, setSortOrder] = useState("asc");
  const [editingOrg, setEditingOrg] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [selectedOrg, setSelectedOrg] = useState(null);

  const { data: directory, isLoading: isLoadingDirectory } = useQuery({
    queryKey: ['dynamic-directory', slug],
    queryFn: async () => {
      const directories = await base44.entities.DynamicDirectory.list({
        filter: { slug: slug, is_active: true }
      });
      return directories?.[0] || null;
    },
    enabled: !!slug
  });

  const { data: filterField } = useQuery({
    queryKey: ['preference-field', directory?.filter_field_id],
    enabled: !!directory?.filter_field_id,
    queryFn: async () => {
      return await base44.entities.PreferenceField.get(directory.filter_field_id);
    }
  });

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations-dynamic-directory', slug],
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    },
    enabled: !!directory && directory.entity_type === 'organization',
    refetchOnMount: true
  });

  const { data: members = [], isLoading: isLoadingMembers } = useQuery({
    queryKey: ['members-dynamic-directory', slug],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    enabled: !!directory && directory.entity_type === 'member',
    refetchOnMount: true
  });

  const { data: displaySettings } = useQuery({
    queryKey: ['organisation-directory-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const logoSetting = allSettings.find(s => s.setting_key === 'org_directory_show_logo');
      const titleSetting = allSettings.find(s => s.setting_key === 'org_directory_show_title');
      const domainsSetting = allSettings.find(s => s.setting_key === 'org_directory_show_domains');
      const memberCountSetting = allSettings.find(s => s.setting_key === 'org_directory_show_member_count');
      const nameTooltipSetting = allSettings.find(s => s.setting_key === 'org_directory_show_name_tooltip');
      const cardsPerRowSetting = allSettings.find(s => s.setting_key === 'org_directory_cards_per_row');
      const excludedOrgsSetting = allSettings.find(s => s.setting_key === 'org_directory_excluded_orgs');

      let excludedOrgIds = [];
      if (excludedOrgsSetting) {
        try {
          excludedOrgIds = JSON.parse(excludedOrgsSetting.setting_value);
        } catch {
          excludedOrgIds = [];
        }
      }

      return {
        showLogo: logoSetting?.setting_value !== 'false',
        showTitle: titleSetting?.setting_value !== 'false',
        showDomains: domainsSetting?.setting_value !== 'false',
        showMemberCount: memberCountSetting?.setting_value !== 'false',
        showNameTooltip: nameTooltipSetting?.setting_value === 'true',
        cardsPerRow: cardsPerRowSetting?.setting_value || '3',
        excludedOrgIds: excludedOrgIds
      };
    },
    enabled: !!directory && directory.entity_type === 'organization',
    staleTime: 0,
    refetchOnMount: true
  });

  const { data: allOrgMembersForCount = [] } = useQuery({
    queryKey: ['all-members-for-org-directory-count'],
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers;
    },
    enabled: !!directory && directory.entity_type === 'organization',
    staleTime: 0,
    refetchOnMount: true
  });

  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values', directory?.filter_field_id],
    enabled: !!directory && directory.entity_type === 'organization' && !!directory.filter_field_id,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
  });

  const { data: allMemberPreferenceValues = [] } = useQuery({
    queryKey: ['all-member-preference-values', directory?.filter_field_id],
    enabled: !!directory && directory.entity_type === 'member' && !!directory.filter_field_id,
    queryFn: async () => {
      try {
        const values = await base44.entities.MemberPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
  });

  const orgPreferenceMap = useMemo(() => {
    const map = {};
    allOrgPreferenceValues.forEach(pv => {
      if (!map[pv.organization_id]) {
        map[pv.organization_id] = {};
      }
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        const trimmed = pv.value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            normalizedValue = JSON.parse(trimmed);
          } catch {
          }
        }
      }
      map[pv.organization_id][pv.preference_field_id] = normalizedValue;
    });
    return map;
  }, [allOrgPreferenceValues]);

  const memberPreferenceMap = useMemo(() => {
    const map = {};
    allMemberPreferenceValues.forEach(pv => {
      if (!map[pv.member_id]) {
        map[pv.member_id] = {};
      }
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        const trimmed = pv.value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            normalizedValue = JSON.parse(trimmed);
          } catch {
          }
        }
      }
      map[pv.member_id][pv.preference_field_id] = normalizedValue;
    });
    return map;
  }, [allMemberPreferenceValues]);

  const organizationMemberCounts = useMemo(() => {
    const counts = {};
    allOrgMembersForCount.forEach((member) => {
      if (member.organization_id) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [allOrgMembersForCount]);

  const getGridClass = () => {
    const cols = displaySettings?.cardsPerRow || '3';
    switch (cols) {
      case '2':
        return 'grid grid-cols-1 md:grid-cols-2 gap-6';
      case '3':
        return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6';
      case '4':
        return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6';
      case '5':
        return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6';
      case '6':
        return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6';
      default:
        return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6';
    }
  };

  const filteredOrganizations = useMemo(() => {
    if (!directory || directory.entity_type !== 'organization') return [];

    const excludedIds = displaySettings?.excludedOrgIds || [];
    let filtered = organizations.filter(org => !excludedIds.includes(org.id));

    if (directory.filter_field_id && directory.filter_value) {
      filtered = filtered.filter(org => {
        const orgValues = orgPreferenceMap[org.id] || {};
        const orgValue = orgValues[directory.filter_field_id];
        if (!orgValue) return false;
        if (Array.isArray(orgValue)) {
          return orgValue.includes(directory.filter_value);
        }
        return orgValue === directory.filter_value;
      });
    }

    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter((org) =>
        org.name?.toLowerCase().includes(searchLower) ||
        org.domain?.toLowerCase().includes(searchLower)
      );
    }

    filtered.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      if (sortOrder === 'asc') {
        return nameA.localeCompare(nameB);
      } else {
        return nameB.localeCompare(nameA);
      }
    });

    return filtered;
  }, [organizations, searchQuery, displaySettings?.excludedOrgIds, sortOrder, directory, orgPreferenceMap]);

  const filteredMembers = useMemo(() => {
    if (!directory || directory.entity_type !== 'member') return [];

    let filtered = members.filter(member => member.show_in_directory !== false && member.login_enabled !== false);

    if (directory.filter_field_id && directory.filter_value) {
      filtered = filtered.filter(member => {
        const memberValues = memberPreferenceMap[member.id] || {};
        const memberValue = memberValues[directory.filter_field_id];
        if (!memberValue) return false;
        if (Array.isArray(memberValue)) {
          return memberValue.includes(directory.filter_value);
        }
        return memberValue === directory.filter_value;
      });
    }

    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter((member) =>
        member.first_name?.toLowerCase().includes(searchLower) ||
        member.last_name?.toLowerCase().includes(searchLower) ||
        member.email?.toLowerCase().includes(searchLower) ||
        member.job_title?.toLowerCase().includes(searchLower)
      );
    }

    filtered.sort((a, b) => {
      const nameA = `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase();
      const nameB = `${b.first_name || ''} ${b.last_name || ''}`.toLowerCase();
      if (sortOrder === 'asc') {
        return nameA.localeCompare(nameB);
      } else {
        return nameB.localeCompare(nameA);
      }
    });

    return filtered;
  }, [members, searchQuery, sortOrder, directory, memberPreferenceMap]);

  const items = directory?.entity_type === 'organization' ? filteredOrganizations : filteredMembers;
  const totalPages = Math.ceil(items.length / itemsPerPage);

  // Debug logging
  console.log('[DynamicDirectory] directory:', directory);
  console.log('[DynamicDirectory] filter_field_id:', directory?.filter_field_id);
  console.log('[DynamicDirectory] filter_value:', directory?.filter_value);
  console.log('[DynamicDirectory] allOrgPreferenceValues RAW:', allOrgPreferenceValues);
  
  // Log all unique preference_field_ids in the data
  if (allOrgPreferenceValues.length > 0) {
    const uniqueFieldIds = [...new Set(allOrgPreferenceValues.map(pv => pv.preference_field_id))];
    console.log('[DynamicDirectory] Unique preference_field_ids in data:', uniqueFieldIds);
    console.log('[DynamicDirectory] Looking for field_id:', directory?.filter_field_id);
    console.log('[DynamicDirectory] Match found:', uniqueFieldIds.includes(directory?.filter_field_id));
    
    // Show first few preference values for debugging - log FULL object to see actual keys
    allOrgPreferenceValues.slice(0, 5).forEach((pv, idx) => {
      console.log(`[DynamicDirectory] PrefValue[${idx}] FULL:`, pv);
      console.log(`[DynamicDirectory] PrefValue[${idx}] KEYS:`, Object.keys(pv));
    });
  }
  const paginatedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return items.slice(startIndex, startIndex + itemsPerPage);
  }, [items, currentPage, itemsPerPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const updateLogoMutation = useMutation({
    mutationFn: async ({ orgId, logoUrl }) => {
      return await base44.entities.Organization.update(orgId, { logo_url: logoUrl });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations-dynamic-directory'] });
      toast.success('Logo updated successfully');
      setEditingOrg(null);
    },
    onError: (error) => {
      toast.error('Failed to update logo: ' + error.message);
    }
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !editingOrg) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    setIsUploading(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });

      if (result?.file_url) {
        updateLogoMutation.mutate({ orgId: editingOrg.id, logoUrl: result.file_url });
      } else {
        toast.error('Upload failed: No file URL returned');
      }
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteLogo = () => {
    if (!editingOrg) return;
    updateLogoMutation.mutate({ orgId: editingOrg.id, logoUrl: null });
    setShowDeleteConfirm(false);
  };

  const openEditDialog = (e, org) => {
    e.stopPropagation();
    setEditingOrg(org);
  };

  const openDeleteConfirm = (e) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  const isLoading = isLoadingDirectory || (directory?.entity_type === 'organization' ? isLoadingOrgs : isLoadingMembers);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center" data-testid="loading-container">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" data-testid="loading-spinner" />
      </div>
    );
  }

  if (!directory) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center" data-testid="not-found-container">
        <Card className="max-w-md w-full" data-testid="not-found-card">
          <CardContent className="p-8 text-center">
            <AlertCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-slate-900 mb-2" data-testid="not-found-title">Directory Not Found</h2>
            <p className="text-slate-600" data-testid="not-found-message">
              The directory you're looking for doesn't exist or is no longer active.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const EntityIcon = directory.entity_type === 'organization' ? Building2 : Users;
  const entityLabel = directory.entity_type === 'organization' ? 'organisation' : 'member';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8" data-testid="dynamic-directory-container">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8" data-testid="directory-header">
          <div className="flex items-center gap-3 mb-2">
            <EntityIcon className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="directory-title">
              {directory.name}
            </h1>
          </div>
          <p className="text-slate-600" data-testid="directory-count">
            {items.length} {items.length === 1 ? entityLabel : `${entityLabel}s`}
            {filterField && (
              <span className="ml-2 text-sm">
                <Badge variant="secondary" className="ml-2" data-testid="filter-badge">
                  {filterField.label}: {directory.filter_value}
                </Badge>
              </span>
            )}
          </p>
        </div>

        <Card className="mb-6 border-slate-200" data-testid="search-card">
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder={directory.entity_type === 'organization' 
                    ? "Search organisations by name or domain..." 
                    : "Search members by name, email, or job title..."}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
              <Select value={sortOrder} onValueChange={setSortOrder}>
                <SelectTrigger className="w-full sm:w-36" data-testid="select-sort-order">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">
                    <span className="flex items-center gap-2">
                      <ArrowDownAZ className="w-4 h-4" />
                      A-Z
                    </span>
                  </SelectItem>
                  <SelectItem value="desc">
                    <span className="flex items-center gap-2">
                      <ArrowUpZA className="w-4 h-4" />
                      Z-A
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {items.length === 0 ? (
          <Card className="border-slate-200" data-testid="empty-state-card">
            <CardContent className="p-12 text-center">
              <EntityIcon className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2" data-testid="empty-state-title">
                No {entityLabel}s found
              </h3>
              <p className="text-slate-600" data-testid="empty-state-message">
                {searchQuery ? 'Try adjusting your search criteria' : `No ${entityLabel}s match the selected filter`}
              </p>
            </CardContent>
          </Card>
        ) : directory.entity_type === 'organization' ? (
          <>
            <div className={getGridClass()} data-testid="organization-grid">
              {paginatedItems.map((org) => {
                const memberCount = organizationMemberCounts[org.id] || 0;
                const allDomains = [org.domain, ...(org.additional_verified_domains || [])].filter(Boolean);

                return (
                  <Card
                    key={org.id}
                    className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer relative group"
                    onClick={() => setSelectedOrg(org)}
                    data-testid={`card-organization-${org.id}`}
                  >
                    {canEditLogos && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        onClick={(e) => openEditDialog(e, org)}
                        data-testid={`button-edit-logo-${org.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                    )}
                    <CardContent className="p-4">
                      {displaySettings?.showLogo && (
                        <div className="flex justify-center mb-4">
                          {org.logo_url ? (
                            <img
                              src={org.logo_url}
                              alt={`${org.name} logo`}
                              className="h-20 w-auto object-contain"
                              data-testid={`img-logo-${org.id}`}
                            />
                          ) : (
                            <div className="h-20 w-20 bg-slate-100 rounded-lg flex items-center justify-center">
                              <Building2 className="w-10 h-10 text-slate-400" />
                            </div>
                          )}
                        </div>
                      )}
                      {displaySettings?.showTitle && (
                        <h3 className="font-semibold text-slate-900 text-center mb-2 line-clamp-2" data-testid={`text-org-name-${org.id}`}>
                          {org.name}
                        </h3>
                      )}
                      {displaySettings?.showDomains && allDomains.length > 0 && (
                        <div className="flex flex-wrap gap-1 justify-center mb-2">
                          {allDomains.slice(0, 2).map((domain, idx) => (
                            <Badge key={idx} variant="secondary" className="text-xs" data-testid={`badge-domain-${org.id}-${idx}`}>
                              <Globe className="w-3 h-3 mr-1" />
                              {domain}
                            </Badge>
                          ))}
                          {allDomains.length > 2 && (
                            <Badge variant="secondary" className="text-xs">
                              +{allDomains.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}
                      {displaySettings?.showMemberCount && (
                        <div className="flex items-center justify-center gap-1 text-sm text-slate-600">
                          <Users className="w-4 h-4" />
                          <span data-testid={`text-member-count-${org.id}`}>{memberCount} {memberCount === 1 ? 'member' : 'members'}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-4 mt-6" data-testid="pagination-container">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-slate-600" data-testid="text-pagination-info">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="member-grid">
              {paginatedItems.map((member) => (
                <Card key={member.id} className="border-slate-200" data-testid={`card-member-${member.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      {member.profile_image_url ? (
                        <img
                          src={member.profile_image_url}
                          alt={`${member.first_name} ${member.last_name}`}
                          className="w-12 h-12 rounded-full object-cover"
                          data-testid={`img-profile-${member.id}`}
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
                          <User className="w-6 h-6 text-slate-400" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate" data-testid={`text-member-name-${member.id}`}>
                          {member.first_name} {member.last_name}
                        </h3>
                        {member.job_title && (
                          <p className="text-sm text-slate-600 truncate" data-testid={`text-job-title-${member.id}`}>
                            {member.job_title}
                          </p>
                        )}
                        {member.email && (
                          <p className="text-sm text-slate-500 truncate" data-testid={`text-email-${member.id}`}>
                            {member.email}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-4 mt-6" data-testid="pagination-container">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-slate-600" data-testid="text-pagination-info">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={!!editingOrg && !showDeleteConfirm} onOpenChange={(open) => !open && setEditingOrg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle data-testid="dialog-edit-logo-title">Edit Logo - {editingOrg?.name}</DialogTitle>
            <DialogDescription>
              Upload a new logo image or remove the existing one.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex justify-center mb-4">
              {editingOrg?.logo_url ? (
                <img
                  src={editingOrg.logo_url}
                  alt={`${editingOrg.name} logo`}
                  className="h-24 w-auto object-contain border rounded-lg p-2"
                />
              ) : (
                <div className="h-24 w-24 bg-slate-100 rounded-lg flex items-center justify-center">
                  <Building2 className="w-12 h-12 text-slate-400" />
                </div>
              )}
            </div>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              onChange={handleFileUpload}
            />
          </div>
          <DialogFooter className="flex gap-2">
            {editingOrg?.logo_url && (
              <Button
                variant="destructive"
                onClick={openDeleteConfirm}
                disabled={isUploading}
                data-testid="button-remove-logo"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Remove Logo
              </Button>
            )}
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              data-testid="button-upload-logo"
            >
              {isUploading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Upload New Logo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle data-testid="dialog-confirm-delete-title">Remove Logo</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the logo for {editingOrg?.name}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteLogo} data-testid="button-confirm-delete">
              Remove Logo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedOrg} onOpenChange={(open) => !open && setSelectedOrg(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle data-testid="dialog-org-profile-title">{selectedOrg?.name}</DialogTitle>
          </DialogHeader>
          {selectedOrg && (
            <div className="py-4">
              <div className="flex justify-center mb-4">
                {selectedOrg.logo_url ? (
                  <img
                    src={selectedOrg.logo_url}
                    alt={`${selectedOrg.name} logo`}
                    className="h-24 w-auto object-contain"
                  />
                ) : (
                  <div className="h-24 w-24 bg-slate-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-12 h-12 text-slate-400" />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                {selectedOrg.domain && (
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-slate-500" />
                    <span className="text-slate-700">{selectedOrg.domain}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-slate-500" />
                  <span className="text-slate-700">
                    {organizationMemberCounts[selectedOrg.id] || 0} members
                  </span>
                </div>
                {selectedOrg.website && (
                  <a
                    href={selectedOrg.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-blue-600 hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Visit Website
                  </a>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

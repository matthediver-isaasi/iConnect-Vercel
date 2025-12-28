import { useState, useMemo, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Building2, Search, Globe, Users, Loader2, ChevronLeft, ChevronRight, ArrowDownAZ, ArrowUpZA, Pencil, Trash2, Upload, ExternalLink, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";

export default function OrganisationDirectoryPage() {
  const { isAdmin, isFeatureExcluded } = useMemberAccess();
  const queryClient = useQueryClient();
  
  // Check if user can edit organisation logos (admin AND not excluded from feature)
  const canEditLogos = isAdmin && !isFeatureExcluded('action_org_logo_edit');
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(12);
  const [sortOrder, setSortOrder] = useState("asc");
  const [editingOrg, setEditingOrg] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  
  // State for organization profile modal
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [customFieldFilters, setCustomFieldFilters] = useState({});

  const { data: organizations = [], isLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    },
    refetchOnMount: true
  });

  // Fetch display settings
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
        showTitle: titleSetting?.setting_value !== 'false', // Default to true if not set
        showDomains: domainsSetting?.setting_value !== 'false',
        showMemberCount: memberCountSetting?.setting_value !== 'false',
        showNameTooltip: nameTooltipSetting?.setting_value === 'true',
        cardsPerRow: cardsPerRowSetting?.setting_value || '3',
        excludedOrgIds: excludedOrgIds
      };
    },
    staleTime: 0,
    refetchOnMount: true
  });

  // Get grid class based on cards per row setting
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

  const { data: members = [] } = useQuery({
    queryKey: ['all-members-for-org-directory'],
    queryFn: async () => {
      // Use listAll to handle Supabase's 1000 row limit with automatic pagination
      const allMembers = await base44.entities.Member.listAll();
      console.log(`[OrganisationDirectory] Loaded ${allMembers.length} total members`);
      return allMembers;
    },
    staleTime: 0,
    refetchOnMount: true
  });

  const organizationMemberCounts = useMemo(() => {
    const counts = {};
    members.forEach((member) => {
      if (member.organization_id) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [members]);

  // Fetch organization-scoped custom fields
  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization', 'directory'],
    queryFn: async () => {
      try {
        // Try to filter by entity_scope (requires migration to be run)
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
          sort: { display_order: 'asc' }
        });
        // Filter for fields visible in Organisation Directory card
        return (fields || []).filter(f => f.entity_scope === 'organization' && f.show_in_directory_card !== false);
      } catch {
        // Fallback: if entity_scope column doesn't exist, fetch all and filter client-side
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization' && f.show_in_directory_card !== false);
        } catch {
          return [];
        }
      }
    }
  });

  // Fetch custom field values for the selected organization
  const { data: selectedOrgValues = [], isLoading: isLoadingOrgValues } = useQuery({
    queryKey: ['/api/entities/OrganizationPreferenceValue', selectedOrg?.id],
    enabled: !!selectedOrg?.id,
    queryFn: async () => {
      if (!selectedOrg?.id) return [];
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: selectedOrg.id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  // Get filterable fields for the directory filter dropdowns
  const filterableFields = useMemo(() => {
    return orgCustomFields.filter(f => f.is_filterable);
  }, [orgCustomFields]);

  // Fetch ALL organization preference values for filtering
  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values'],
    enabled: filterableFields.length > 0,
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

  // Build a lookup map: organization_id -> { field_id -> value }
  // Normalizes values: JSON arrays/objects are parsed and reduced to primitive values
  const orgPreferenceMap = useMemo(() => {
    const map = {};
    
    // Helper to extract primitive value from object/array
    const extractPrimitiveValue = (val) => {
      if (val === null || val === undefined) return val;
      
      // If it's an object with a 'value' property, extract it
      if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
        return val.value;
      }
      
      // If it's an array, extract primitive values from each element
      if (Array.isArray(val)) {
        return val.map(item => {
          if (typeof item === 'object' && item !== null && item.value !== undefined) {
            return item.value;
          }
          return item;
        });
      }
      
      return val;
    };
    
    allOrgPreferenceValues.forEach(pv => {
      if (!map[pv.organization_id]) {
        map[pv.organization_id] = {};
      }
      // Parse JSON array/object strings if applicable
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        const trimmed = pv.value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            normalizedValue = JSON.parse(trimmed);
          } catch {
            // Keep as string if parse fails
          }
        }
      }
      // Extract primitive values from objects/arrays (e.g., {value: "x", label: "X"} -> "x")
      normalizedValue = extractPrimitiveValue(normalizedValue);
      // Use field_id (the actual DB column) not preference_field_id
      map[pv.organization_id][pv.field_id] = normalizedValue;
    });
    return map;
  }, [allOrgPreferenceValues]);

  const filteredOrganizations = useMemo(() => {
    const excludedIds = displaySettings?.excludedOrgIds || [];
    
    // First filter out excluded organizations
    let filtered = organizations.filter(org => 
      !excludedIds.includes(org.id)
    );
    
    // Then apply search filter
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter((org) =>
        org.name?.toLowerCase().includes(searchLower) ||
        org.domain?.toLowerCase().includes(searchLower)
      );
    }
    
    // Filter by custom fields
    const activeFilters = Object.entries(customFieldFilters).filter(([_, value]) => value && value !== 'all');
    if (activeFilters.length > 0) {
      filtered = filtered.filter(org => {
        const orgValues = orgPreferenceMap[org.id] || {};
        return activeFilters.every(([fieldId, filterValue]) => {
          const orgValue = orgValues[fieldId];
          if (!orgValue) return false;
          // For picklist (array), check if filterValue is in the array
          if (Array.isArray(orgValue)) {
            return orgValue.includes(filterValue);
          }
          // For dropdown (single value), check exact match
          return orgValue === filterValue;
        });
      });
    }
    
    // Apply sorting
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
  }, [organizations, searchQuery, displaySettings?.excludedOrgIds, sortOrder, customFieldFilters, orgPreferenceMap]);

  const totalPages = Math.ceil(filteredOrganizations.length / itemsPerPage);
  const paginatedOrganizations = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredOrganizations.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredOrganizations, currentPage, itemsPerPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const updateLogoMutation = useMutation({
    mutationFn: async ({ orgId, logoUrl }) => {
      return await base44.entities.Organization.update(orgId, { logo_url: logoUrl });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>);

  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">University Directory

            </h1>
          </div>
          <p className="text-slate-600">
            {filteredOrganizations.length} {filteredOrganizations.length === 1 ? 'organisation' : 'organisations'}
          </p>
        </div>

        <Card className="mb-6 border-slate-200">
          <CardContent className="p-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search organisations by name or domain..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                    data-testid="input-search-organisations"
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
              
              {filterableFields.length > 0 && (
                <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-200">
                  {filterableFields.map(field => (
                    <div key={field.id} className="flex items-center gap-2">
                      <span className="text-sm text-slate-700">{field.label}:</span>
                      <Select 
                        value={customFieldFilters[field.id] || "all"} 
                        onValueChange={(value) => {
                          setCustomFieldFilters(prev => ({
                            ...prev,
                            [field.id]: value === "all" ? "" : value
                          }));
                          setCurrentPage(1);
                        }}
                      >
                        <SelectTrigger className="w-[180px]" data-testid={`select-filter-${field.name}`}>
                          <SelectValue placeholder={`All ${field.label}`} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          {(field.options || []).map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {filteredOrganizations.length === 0 ?
        <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No organisations found</h3>
              <p className="text-slate-600">
                {searchQuery ? 'Try adjusting your search criteria' : 'No organisations available'}
              </p>
            </CardContent>
          </Card> :

        <>
            <div className={getGridClass()}>
              {paginatedOrganizations.map((org) => {
              const memberCount = organizationMemberCounts[org.id] || 0;
              const allDomains = [org.domain, ...(org.additional_verified_domains || [])].filter(Boolean);

              return (
                <Card 
                  key={org.id} 
                  className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => setSelectedOrg(org)}
                  data-testid={`card-organisation-${org.id}`}
                >
                    <CardHeader className="flex flex-col items-center text-center pb-2">
                      {displaySettings?.showLogo && (
                        <div className="relative w-[90%] aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center mb-3 group">
                          {org.logo_url ?
                            <img
                              src={org.logo_url}
                              alt={org.name}
                              className={`w-full h-full object-contain transition-all duration-300 ${displaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`} /> :
                            <Building2 className={`w-16 h-16 text-slate-400 transition-all duration-300 ${displaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`} />
                          }
                          {displaySettings?.showNameTooltip && (
                            <div className="absolute inset-0 flex items-center justify-center p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                              <span className="text-lg font-bold text-slate-800 text-center leading-tight line-clamp-4">
                                {org.name}
                              </span>
                            </div>
                          )}
                          {canEditLogos && (
                            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                              <Button
                                size="icon"
                                variant="secondary"
                                className="h-8 w-8 bg-white/90 hover:bg-white shadow-sm"
                                onClick={(e) => openEditDialog(e, org)}
                                data-testid={`button-edit-logo-${org.id}`}
                              >
                                <Pencil className="w-4 h-4 text-slate-600" />
                              </Button>
                              {org.logo_url && (
                                <Button
                                  size="icon"
                                  variant="secondary"
                                  className="h-8 w-8 bg-white/90 hover:bg-red-50 shadow-sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingOrg(org);
                                    setShowDeleteConfirm(true);
                                  }}
                                  data-testid={`button-delete-logo-${org.id}`}
                                >
                                  <Trash2 className="w-4 h-4 text-red-500" />
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {displaySettings?.showTitle !== false && (
                        <CardTitle className="text-base line-clamp-2 w-full">{org.name}</CardTitle>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {displaySettings?.showDomains && allDomains.length > 0 &&
                        <div className="space-y-1 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Globe className="w-4 h-4 text-slate-400" />
                            <span className="text-sm font-medium text-slate-700">
                              {allDomains.length > 1 ? 'Domains' : 'Domain'}
                            </span>
                          </div>
                          <div className="flex flex-wrap justify-center gap-1">
                            {allDomains.map((domain, idx) =>
                              <span key={idx} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">
                                @{domain}
                              </span>
                            )}
                          </div>
                        </div>
                      }

                      {displaySettings?.showMemberCount && (
                        <div className="flex items-center justify-center gap-2 pt-2 border-t border-slate-200">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span className="text-sm text-slate-600">Members:</span>
                          <span className="text-sm font-semibold text-slate-900">{memberCount}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>);

            })}
            </div>

            {totalPages > 1 &&
          <div className="mt-6 flex justify-center items-center gap-2">
                <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}>

                  <ChevronLeft className="w-4 h-4" />
                </Button>
                
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) =>
              <Button
                key={page}
                variant={currentPage === page ? "default" : "outline"}
                size="sm"
                onClick={() => setCurrentPage(page)}
                className="w-9">

                      {page}
                    </Button>
              )}
                </div>

                <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}>

                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
          }
          </>
        }
      </div>

      {/* Edit Logo Dialog */}
      <Dialog open={!!editingOrg && !showDeleteConfirm} onOpenChange={(open) => !open && setEditingOrg(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Organisation Logo</DialogTitle>
            <DialogDescription>
              Upload a new logo for {editingOrg?.name}
            </DialogDescription>
            <p className="text-xs text-slate-500 mt-1">
              Recommended size: 200 x 200 pixels (square)
            </p>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-center">
              <div className="w-32 h-32 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center">
                {editingOrg?.logo_url ? (
                  <img
                    src={editingOrg.logo_url}
                    alt={editingOrg.name}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <Building2 className="w-12 h-12 text-slate-400" />
                )}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              className="w-full"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || updateLogoMutation.isPending}
            >
              {isUploading || updateLogoMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Upload New Logo
                </>
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingOrg(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove Logo</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the logo for {editingOrg?.name}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteLogo}
              disabled={updateLogoMutation.isPending}
            >
              {updateLogoMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : (
                'Remove Logo'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Organization Profile Modal */}
      <Dialog open={!!selectedOrg} onOpenChange={(open) => !open && setSelectedOrg(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-4">
              {displaySettings?.showLogo && (
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center flex-shrink-0">
                  {selectedOrg?.logo_url ? (
                    <img
                      src={selectedOrg.logo_url}
                      alt={selectedOrg?.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <Building2 className="w-8 h-8 text-slate-400" />
                  )}
                </div>
              )}
              <div>
                {displaySettings?.showTitle !== false && (
                  <DialogTitle className="text-xl">{selectedOrg?.name}</DialogTitle>
                )}
                {displaySettings?.showDomains && selectedOrg?.domain && (
                  <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                    <Globe className="w-3 h-3" />
                    @{selectedOrg.domain}
                  </p>
                )}
              </div>
            </div>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {/* Member count */}
            {displaySettings?.showMemberCount && (
              <div className="flex items-center gap-2 text-slate-600">
                <Users className="w-4 h-4" />
                <span>{organizationMemberCounts[selectedOrg?.id] || 0} members</span>
              </div>
            )}

            {/* Additional domains */}
            {displaySettings?.showDomains && selectedOrg?.additional_verified_domains?.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-700">Additional Domains</p>
                <div className="flex flex-wrap gap-1">
                  {selectedOrg.additional_verified_domains.map((domain, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs">
                      @{domain}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Custom Fields Section */}
            {orgCustomFields.length > 0 && (
              <div className="space-y-3 pt-2 border-t">
                <div className="flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-blue-600" />
                  <h4 className="font-medium text-slate-900">Additional Information</h4>
                </div>
                
                {isLoadingOrgValues ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    {orgCustomFields.map((field) => {
                      const valueRecord = selectedOrgValues.find(v => v.field_id === field.id);
                      let displayValue = valueRecord?.value || '';
                      
                      // Handle picklist (array) values
                      if (field.field_type === 'picklist' && displayValue) {
                        try {
                          const parsed = JSON.parse(displayValue);
                          if (Array.isArray(parsed) && field.options) {
                            displayValue = parsed
                              .map(v => field.options.find(o => o.value === v)?.label || v)
                              .join(', ');
                          }
                        } catch {
                          // Keep as is
                        }
                      }
                      
                      // Handle dropdown - show label instead of value
                      if (field.field_type === 'dropdown' && displayValue && field.options) {
                        const option = field.options.find(o => o.value === displayValue);
                        if (option) displayValue = option.label;
                      }
                      
                      return (
                        <div key={field.id} className="flex justify-between items-start gap-4">
                          <span className="text-sm text-slate-600">{field.label}</span>
                          <span className="text-sm font-medium text-slate-900 text-right">
                            {displayValue || <span className="text-slate-400 italic">Not set</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setSelectedOrg(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                window.location.href = `/memberdirectory?org=${selectedOrg?.id}`;
              }}
              className="bg-blue-600 hover:bg-blue-700 gap-2"
              data-testid="button-view-members"
            >
              <Users className="w-4 h-4" />
              View Members
              <ExternalLink className="w-3 h-3" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>);

}
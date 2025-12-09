import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Search, Globe, Users, Loader2, ChevronLeft, ChevronRight, ArrowDownAZ, ArrowUpZA } from "lucide-react";

export function IEditOrganisationDirectoryElementEditor({ element, onChange }) {
  const defaultContent = {
    backgroundColor: '#f8fafc',
    showSearch: true,
    showSortFilter: true,
    showPagination: true,
    showLogo: true,
    showTitle: true,
    showDomains: false,
    showMemberCount: false,
    showNameTooltip: false,
    columns: '3',
    rowsPerPage: '4',
    cardBorderRadius: 8,
    headerText: '',
    headerFontSize: 32,
    headerColor: '#0f172a',
  };
  
  const [content, setContent] = React.useState({ ...defaultContent, ...(element.content || {}) });

  const updateContent = (key, value) => {
    const newContent = { ...content, [key]: value };
    setContent(newContent);
    onChange({ ...element, content: newContent });
  };

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., directory-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-orgdirectory-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <div>
        <Label htmlFor="headerText">Section Header (optional)</Label>
        <Input
          id="headerText"
          value={content.headerText || ''}
          onChange={(e) => updateContent('headerText', e.target.value)}
          placeholder="e.g., Our Member Organisations"
        />
      </div>

      {content.headerText && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="headerFontSize">Header Size (px)</Label>
            <Input
              id="headerFontSize"
              type="number"
              value={content.headerFontSize || 32}
              onChange={(e) => updateContent('headerFontSize', parseInt(e.target.value) || 32)}
              min="16"
              max="72"
            />
          </div>
          <div>
            <Label htmlFor="headerColor">Header Color</Label>
            <input
              id="headerColor"
              type="color"
              value={content.headerColor || '#0f172a'}
              onChange={(e) => updateContent('headerColor', e.target.value)}
              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
            />
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="backgroundColor">Background Color</Label>
        <input
          id="backgroundColor"
          type="color"
          value={content.backgroundColor || '#f8fafc'}
          onChange={(e) => updateContent('backgroundColor', e.target.value)}
          className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="columns">Cards Per Row</Label>
          <Select
            value={content.columns || '3'}
            onValueChange={(value) => updateContent('columns', value)}
          >
            <SelectTrigger>
              <SelectValue />
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
        <div>
          <Label htmlFor="rowsPerPage">Rows Per Page</Label>
          <Select
            value={content.rowsPerPage || '4'}
            onValueChange={(value) => updateContent('rowsPerPage', value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2 Rows</SelectItem>
              <SelectItem value="3">3 Rows</SelectItem>
              <SelectItem value="4">4 Rows</SelectItem>
              <SelectItem value="5">5 Rows</SelectItem>
              <SelectItem value="6">6 Rows</SelectItem>
              <SelectItem value="8">8 Rows</SelectItem>
              <SelectItem value="10">10 Rows</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="cardBorderRadius">Card Border Radius (px)</Label>
        <Input
          id="cardBorderRadius"
          type="number"
          value={content.cardBorderRadius || 8}
          onChange={(e) => updateContent('cardBorderRadius', parseInt(e.target.value) || 8)}
          min="0"
          max="32"
        />
      </div>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <p className="text-sm font-medium text-slate-700">Display Options</p>
        
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showSearch"
            checked={content.showSearch !== false}
            onChange={(e) => updateContent('showSearch', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showSearch" className="cursor-pointer">
            Show Search Bar
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showSortFilter"
            checked={content.showSortFilter !== false}
            onChange={(e) => updateContent('showSortFilter', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showSortFilter" className="cursor-pointer">
            Show A-Z / Z-A Sort Filter
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showPagination"
            checked={content.showPagination !== false}
            onChange={(e) => updateContent('showPagination', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showPagination" className="cursor-pointer">
            Show Pagination Controls
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showLogo"
            checked={content.showLogo !== false}
            onChange={(e) => updateContent('showLogo', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showLogo" className="cursor-pointer">
            Show Organisation Logo
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showTitle"
            checked={content.showTitle !== false}
            onChange={(e) => updateContent('showTitle', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showTitle" className="cursor-pointer">
            Show Organisation Name
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showDomains"
            checked={content.showDomains || false}
            onChange={(e) => updateContent('showDomains', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showDomains" className="cursor-pointer">
            Show Domains
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showMemberCount"
            checked={content.showMemberCount || false}
            onChange={(e) => updateContent('showMemberCount', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showMemberCount" className="cursor-pointer">
            Show Member Count
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showNameTooltip"
            checked={content.showNameTooltip || false}
            onChange={(e) => updateContent('showNameTooltip', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showNameTooltip" className="cursor-pointer">
            Show Name Tooltip on Hover
          </Label>
        </div>
      </div>
    </div>
  );
}

export function IEditOrganisationDirectoryElementRenderer({ content, settings }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);

  const {
    anchor,
    backgroundColor = '#f8fafc',
    showSearch = true,
    showSortFilter = true,
    showPagination = true,
    showLogo = true,
    showTitle = true,
    showDomains = false,
    showMemberCount = false,
    showNameTooltip = false,
    columns = '3',
    rowsPerPage = '4',
    cardBorderRadius = 8,
    headerText = '',
    headerFontSize = 32,
    headerColor = '#0f172a',
  } = content || {};

  const { data: organizations = [], isLoading } = useQuery({
    queryKey: ['organizations-element'],
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    },
    refetchOnMount: true
  });

  const { data: displaySettings } = useQuery({
    queryKey: ['org-directory-settings-element'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const excludedOrgsSetting = allSettings.find(s => s.setting_key === 'org_directory_excluded_orgs');
      
      let excludedOrgIds = [];
      if (excludedOrgsSetting) {
        try {
          excludedOrgIds = JSON.parse(excludedOrgsSetting.setting_value);
        } catch {
          excludedOrgIds = [];
        }
      }
      
      return { excludedOrgIds };
    },
    staleTime: 0
  });

  const { data: members = [] } = useQuery({
    queryKey: ['members-for-org-directory-element'],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    enabled: showMemberCount,
    staleTime: 0
  });

  const organizationMemberCounts = useMemo(() => {
    if (!showMemberCount) return {};
    const counts = {};
    members.forEach((member) => {
      if (member.organization_id) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [members, showMemberCount]);

  const filteredOrganizations = useMemo(() => {
    const excludedIds = displaySettings?.excludedOrgIds || [];
    
    let filtered = organizations.filter(org => 
      !excludedIds.includes(org.id)
    );
    
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
  }, [organizations, searchQuery, displaySettings?.excludedOrgIds, sortOrder]);

  const columnsNum = parseInt(columns) || 3;
  const rowsPerPageNum = parseInt(rowsPerPage) || 4;
  const itemsPerPage = columnsNum * rowsPerPageNum;
  
  const totalPages = Math.ceil(filteredOrganizations.length / itemsPerPage);
  
  const displayedOrganizations = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredOrganizations.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredOrganizations, currentPage, itemsPerPage]);

  const getGridClass = () => {
    switch (columns) {
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

  if (isLoading) {
    return (
      <div 
        className="p-8 flex items-center justify-center"
        style={{ backgroundColor }}
      >
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div id={anchor || undefined} style={{ backgroundColor }} className="p-4 md:p-8">
      <div className={settings?.fullWidth ? 'px-4' : 'max-w-7xl mx-auto'}>
        {headerText && (
          <h2 
            className="mb-6 font-bold"
            style={{ 
              fontSize: `${headerFontSize}px`,
              color: headerColor 
            }}
          >
            {headerText}
          </h2>
        )}

        {(showSearch || showSortFilter) && (
          <Card className="mb-6 border-slate-200">
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-3">
                {showSearch && (
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search organisations..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="pl-10"
                      data-testid="input-search-org-element"
                    />
                  </div>
                )}
                {showSortFilter && (
                  <Select value={sortOrder} onValueChange={setSortOrder}>
                    <SelectTrigger className="w-full sm:w-36" data-testid="select-sort-org-element">
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
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {displayedOrganizations.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No organisations found</h3>
              <p className="text-slate-600">
                {searchQuery ? 'Try adjusting your search criteria' : 'No organisations available'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className={getGridClass()}>
              {displayedOrganizations.map((org) => {
                const memberCount = organizationMemberCounts[org.id] || 0;
                const allDomains = [org.domain, ...(org.additional_verified_domains || [])].filter(Boolean);

                return (
                  <Card 
                    key={org.id} 
                    className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer"
                    style={{ borderRadius: `${cardBorderRadius}px` }}
                    onClick={() => {
                      window.location.href = `/memberdirectory?org=${org.id}`;
                    }}
                    data-testid={`card-org-element-${org.id}`}
                  >
                    <CardHeader className="flex flex-col items-center text-center pb-2">
                      {showLogo && (
                        <div 
                          className="relative w-[90%] aspect-square overflow-hidden bg-slate-100 flex items-center justify-center mb-3 group"
                          style={{ borderRadius: `${cardBorderRadius}px` }}
                        >
                          {org.logo_url ? (
                            <img
                              src={org.logo_url}
                              alt={org.name}
                              className={`w-full h-full object-contain transition-all duration-300 ${showNameTooltip ? 'group-hover:opacity-20' : ''}`}
                            />
                          ) : (
                            <Building2 className={`w-16 h-16 text-slate-400 transition-all duration-300 ${showNameTooltip ? 'group-hover:opacity-20' : ''}`} />
                          )}
                          {showNameTooltip && (
                            <div className="absolute inset-0 flex items-center justify-center p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                              <span className="text-lg font-bold text-slate-800 text-center leading-tight line-clamp-4">
                                {org.name}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      {showTitle && (
                        <CardTitle className="text-base line-clamp-2 w-full">{org.name}</CardTitle>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {showDomains && allDomains.length > 0 && (
                        <div className="space-y-1 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Globe className="w-4 h-4 text-slate-400" />
                            <span className="text-sm font-medium text-slate-700">
                              {allDomains.length > 1 ? 'Domains' : 'Domain'}
                            </span>
                          </div>
                          <div className="flex flex-wrap justify-center gap-1">
                            {allDomains.map((domain, idx) => (
                              <span key={idx} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">
                                @{domain}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {showMemberCount && (
                        <div className="flex items-center justify-center gap-2 pt-2 border-t border-slate-200">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span className="text-sm text-slate-600">Members:</span>
                          <span className="text-sm font-semibold text-slate-900">{memberCount}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {showPagination && totalPages > 1 && (
              <div className="mt-6 flex justify-center items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page-org-element"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm text-slate-600">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  data-testid="button-next-page-org-element"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

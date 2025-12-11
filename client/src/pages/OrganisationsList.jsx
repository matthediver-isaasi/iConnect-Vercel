import { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  Building2, 
  Search, 
  LayoutGrid, 
  LayoutList, 
  Filter, 
  X, 
  ChevronLeft, 
  ChevronRight, 
  Users, 
  Globe, 
  Phone, 
  Mail, 
  MapPin,
  Loader2,
  SlidersHorizontal,
  RotateCcw
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import OrganisationDetailView from "@/components/OrganisationDetailView";

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'pending', label: 'Pending' }
];

export default function OrganisationsListPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  
  const [viewMode, setViewMode] = useState('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [showFilters, setShowFilters] = useState(true);

  useEffect(() => {
    if (isAccessReady) {
      // Admin-only page, also check OrganisationDirectory feature exclusion for consistency
      if (!isAdmin || isFeatureExcluded('page_OrganisationsList') || isFeatureExcluded('page_OrganisationDirectory')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady, isFeatureExcluded]);

  const { data: organizations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['organizations-crm-list'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    }
  });

  const { data: members = [] } = useQuery({
    queryKey: ['all-members-for-org-list'],
    enabled: accessChecked,
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers || [];
    }
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization', 'crm'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'organization');
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    }
  });

  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values-crm'],
    enabled: accessChecked && orgCustomFields.length > 0,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    }
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

  const orgValuesMap = useMemo(() => {
    const map = {};
    allOrgPreferenceValues.forEach(pv => {
      if (!map[pv.organization_id]) {
        map[pv.organization_id] = {};
      }
      map[pv.organization_id][pv.field_id] = pv.value;
    });
    return map;
  }, [allOrgPreferenceValues]);

  const filteredOrganizations = useMemo(() => {
    let result = [...organizations];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(org => 
        org.name?.toLowerCase().includes(query) ||
        org.invoicing_email?.toLowerCase().includes(query) ||
        org.phone?.toLowerCase().includes(query) ||
        org.website_url?.toLowerCase().includes(query)
      );
    }

    if (statusFilter !== 'all') {
      result = result.filter(org => org.status === statusFilter);
    }

    Object.entries(customFieldFilters).forEach(([fieldId, filterValue]) => {
      if (filterValue && filterValue !== 'all') {
        result = result.filter(org => {
          const orgFieldValue = orgValuesMap[org.id]?.[fieldId];
          if (!orgFieldValue) return false;
          
          try {
            const parsed = JSON.parse(orgFieldValue);
            if (Array.isArray(parsed)) {
              return parsed.includes(filterValue);
            }
            return orgFieldValue === filterValue;
          } catch {
            return orgFieldValue === filterValue;
          }
        });
      }
    });

    return result;
  }, [organizations, searchQuery, statusFilter, customFieldFilters, orgValuesMap]);

  const paginatedOrganizations = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredOrganizations.slice(start, start + itemsPerPage);
  }, [filteredOrganizations, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredOrganizations.length / itemsPerPage);

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setCustomFieldFilters({});
    setCurrentPage(1);
  };

  const hasActiveFilters = searchQuery || statusFilter !== 'all' || Object.values(customFieldFilters).some(v => v && v !== 'all');

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (selectedOrg) {
    return (
      <OrganisationDetailView 
        organization={selectedOrg}
        onBack={() => setSelectedOrg(null)}
        orgCustomFields={orgCustomFields}
        memberCount={organizationMemberCounts[selectedOrg.id] || 0}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex h-screen">
        {showFilters && (
          <aside className="w-72 bg-white border-r border-slate-200 flex flex-col">
            <div className="p-4 border-b border-slate-200">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4" />
                  Filters
                </h2>
                {hasActiveFilters && (
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={resetFilters}
                    className="text-slate-500 hover:text-slate-700 h-8 px-2"
                    data-testid="button-reset-filters"
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Reset
                  </Button>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search organisations..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  className="pl-9"
                  data-testid="input-search-orgs"
                />
              </div>
            </div>

            <ScrollArea className="flex-1 p-4">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Status</Label>
                  <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}>
                    <SelectTrigger data-testid="select-status-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {orgCustomFields.filter(f => f.is_filterable && f.options && f.options.length > 0).map(field => (
                  <div key={field.id} className="space-y-2">
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">{field.label}</Label>
                    <Select 
                      value={customFieldFilters[field.id] || 'all'} 
                      onValueChange={(v) => { 
                        setCustomFieldFilters(prev => ({ ...prev, [field.id]: v })); 
                        setCurrentPage(1); 
                      }}
                    >
                      <SelectTrigger data-testid={`select-filter-${field.id}`}>
                        <SelectValue placeholder={`All ${field.label}`} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All {field.label}</SelectItem>
                        {field.options.map((opt, idx) => (
                          <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}

                {orgCustomFields.filter(f => !f.is_filterable || !f.options?.length).length > 0 && (
                  <>
                    <Separator />
                    <p className="text-xs text-slate-400">
                      {orgCustomFields.filter(f => f.is_filterable && (!f.options || f.options.length === 0)).length > 0 && 
                        "Some filterable fields need dropdown options to appear here."
                      }
                    </p>
                  </>
                )}
              </div>
            </ScrollArea>

            <div className="p-4 border-t border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-500">
                Showing {filteredOrganizations.length} of {organizations.length} organisations
              </p>
            </div>
          </aside>
        )}

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-white border-b border-slate-200 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowFilters(!showFilters)}
                  className={showFilters ? 'bg-slate-100' : ''}
                  data-testid="button-toggle-filters"
                >
                  <Filter className="w-4 h-4" />
                </Button>
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-blue-600" />
                    Organisations
                  </h1>
                  <p className="text-sm text-slate-500">
                    {filteredOrganizations.length} organisation{filteredOrganizations.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="bg-slate-100 rounded-lg p-1 flex">
                  <Button
                    variant={viewMode === 'list' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('list')}
                    className="gap-1"
                    data-testid="button-view-list"
                  >
                    <LayoutList className="w-4 h-4" />
                    List
                  </Button>
                  <Button
                    variant={viewMode === 'card' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('card')}
                    className="gap-1"
                    data-testid="button-view-card"
                  >
                    <LayoutGrid className="w-4 h-4" />
                    Cards
                  </Button>
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-auto p-6">
            {orgsLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : paginatedOrganizations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <Building2 className="w-16 h-16 mb-4 text-slate-300" />
                <p className="text-lg font-medium">No organisations found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : viewMode === 'list' ? (
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Organisation</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Members</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Contact</th>
                      {orgCustomFields.slice(0, 2).map(field => (
                        <th key={field.id} className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedOrganizations.map(org => (
                      <tr 
                        key={org.id} 
                        className="hover:bg-slate-50 cursor-pointer transition-colors"
                        onClick={() => setSelectedOrg(org)}
                        data-testid={`row-org-${org.id}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {org.logo_url ? (
                              <img src={org.logo_url} alt={org.name} className="w-10 h-10 rounded-lg object-contain bg-slate-100" />
                            ) : (
                              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                <Building2 className="w-5 h-5 text-blue-600" />
                              </div>
                            )}
                            <div>
                              <p className="font-medium text-slate-900">{org.name}</p>
                              {org.website_url && (
                                <p className="text-xs text-slate-500 truncate max-w-[200px]">{org.website_url}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={org.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                            {org.status || 'unknown'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 text-slate-600">
                            <Users className="w-4 h-4" />
                            <span>{organizationMemberCounts[org.id] || 0}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm text-slate-600">
                            {org.invoicing_email && (
                              <p className="truncate max-w-[180px]">{org.invoicing_email}</p>
                            )}
                            {org.phone && (
                              <p className="text-xs text-slate-400">{org.phone}</p>
                            )}
                          </div>
                        </td>
                        {orgCustomFields.slice(0, 2).map(field => {
                          const value = orgValuesMap[org.id]?.[field.id];
                          let displayValue = value || '-';
                          if (value && (field.field_type === 'picklist' || field.field_type === 'dropdown')) {
                            try {
                              const parsed = JSON.parse(value);
                              if (Array.isArray(parsed)) {
                                displayValue = parsed.map(v => {
                                  const opt = field.options?.find(o => o.value === v);
                                  return opt?.label || v;
                                }).join(', ');
                              } else {
                                const opt = field.options?.find(o => o.value === value);
                                displayValue = opt?.label || value;
                              }
                            } catch {
                              const opt = field.options?.find(o => o.value === value);
                              displayValue = opt?.label || value;
                            }
                          }
                          return (
                            <td key={field.id} className="px-4 py-3 text-sm text-slate-600">
                              {displayValue}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {paginatedOrganizations.map(org => (
                  <Card 
                    key={org.id} 
                    className="cursor-pointer hover:shadow-md transition-shadow hover-elevate"
                    onClick={() => setSelectedOrg(org)}
                    data-testid={`card-org-${org.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3 mb-3">
                        {org.logo_url ? (
                          <img src={org.logo_url} alt={org.name} className="w-12 h-12 rounded-lg object-contain bg-slate-100" />
                        ) : (
                          <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-6 h-6 text-blue-600" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-slate-900 truncate">{org.name}</h3>
                          <Badge variant={org.status === 'active' ? 'default' : 'secondary'} className="capitalize mt-1">
                            {org.status || 'unknown'}
                          </Badge>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-slate-600">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span>{organizationMemberCounts[org.id] || 0} members</span>
                        </div>
                        {org.invoicing_email && (
                          <div className="flex items-center gap-2">
                            <Mail className="w-4 h-4 text-slate-400" />
                            <span className="truncate">{org.invoicing_email}</span>
                          </div>
                        )}
                        {org.phone && (
                          <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-slate-400" />
                            <span>{org.phone}</span>
                          </div>
                        )}
                        {org.website_url && (
                          <div className="flex items-center gap-2">
                            <Globe className="w-4 h-4 text-slate-400" />
                            <span className="truncate">{org.website_url}</span>
                          </div>
                        )}
                      </div>

                      {orgCustomFields.slice(0, 2).map(field => {
                        const value = orgValuesMap[org.id]?.[field.id];
                        if (!value) return null;
                        let displayValue = value;
                        if (field.field_type === 'picklist' || field.field_type === 'dropdown') {
                          try {
                            const parsed = JSON.parse(value);
                            if (Array.isArray(parsed)) {
                              displayValue = parsed.map(v => {
                                const opt = field.options?.find(o => o.value === v);
                                return opt?.label || v;
                              }).join(', ');
                            } else {
                              const opt = field.options?.find(o => o.value === value);
                              displayValue = opt?.label || value;
                            }
                          } catch {
                            const opt = field.options?.find(o => o.value === value);
                            displayValue = opt?.label || value;
                          }
                        }
                        return (
                          <div key={field.id} className="mt-2 text-xs">
                            <span className="text-slate-400">{field.label}: </span>
                            <span className="text-slate-600">{displayValue}</span>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <footer className="bg-white border-t border-slate-200 px-6 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">
                  Page {currentPage} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}

import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, User, Mail, FileText, Trophy, Search, Users, Shield, Calendar, ChevronLeft, ChevronRight, Building2, Briefcase, ChevronDown, ChevronUp, Linkedin, ArrowUpDown, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { isDeletedMember } from "@/utils";

export default function MemberDirectoryPage() {
  const { memberInfo, isFeatureExcluded } = useMemberAccess();
  const { hasBanner } = useLayoutContext();
  
  // Check if user can see the "Show disabled accounts" toggle
  const canShowDisabledAccounts = !isFeatureExcluded('element_ShowDisabledAccounts');
  
  // Check if user can view other members' biographies
  const canViewMemberBiography = !isFeatureExcluded('view_member_biography');
  
  const [searchQuery, setSearchQuery] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(9);
  const [viewingMember, setViewingMember] = useState(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [sortBy, setSortBy] = useState("name-asc");
  const [selectedOrganization, setSelectedOrganization] = useState(() => {
    const searchParams = new URLSearchParams(window.location.search);
    return searchParams.get('org') || "";
  });
  const [customFieldFilters, setCustomFieldFilters] = useState({});

  const { data: allMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['all-members-directory'],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    staleTime: 60 * 1000,
  });

  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles'],
    queryFn: async () => {
      return await base44.entities.BlogPost.list();
    },
    staleTime: 60 * 1000,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      return await base44.entities.Role.list();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => {
      return await base44.entities.Organization.list();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments'],
    queryFn: async () => {
      return await base44.entities.OfflineAwardAssignment.list();
    },
    staleTime: 60 * 1000,
  });

  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offline-awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.filter(a => a.is_active);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings'],
    queryFn: async () => {
      return await base44.entities.Booking.list();
    },
    staleTime: 60 * 1000,
  });

  const { data: displaySettings } = useQuery({
    queryKey: ['memberDirectoryDisplay'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'member_directory_display');
      
      if (setting?.setting_value) {
        try {
          const parsed = JSON.parse(setting.setting_value);
          return parsed;
        } catch (e) {
          console.error('Failed to parse member directory settings:', e);
          return {
            show_profile_photo: true,
            show_events: true,
            show_articles: true,
            show_organization: true,
            show_job_title: true,
            show_linkedin: true,
            show_awards: true,
            show_bio_in_popup: true
          };
        }
      }
      
      return {
        show_profile_photo: true,
        show_events: true,
        show_articles: true,
        show_organization: true,
        show_job_title: true,
        show_linkedin: true,
        show_awards: true,
        show_bio_in_popup: true
      };
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch member-scoped filterable custom fields
  const { data: filterableFields = [] } = useQuery({
    queryKey: ['member-filterable-fields'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member', is_filterable: true },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member' && f.is_filterable);
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => 
            (!f.entity_scope || f.entity_scope === 'member') && f.is_filterable
          );
        } catch {
          return [];
        }
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch all member preference values for filtering
  const { data: memberPreferenceValues = [] } = useQuery({
    queryKey: ['all-member-preference-values'],
    enabled: filterableFields.length > 0,
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

  // Build a lookup map: member_id -> { field_id -> value }
  // Normalizes values: JSON arrays are parsed, strings are kept as-is
  const memberPreferenceMap = useMemo(() => {
    const map = {};
    memberPreferenceValues.forEach(pv => {
      if (!map[pv.member_id]) {
        map[pv.member_id] = {};
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
      map[pv.member_id][pv.preference_field_id] = normalizedValue;
    });
    return map;
  }, [memberPreferenceValues]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const orgParam = searchParams.get('org') || "";
      setSelectedOrganization(orgParam);
      setCurrentPage(1);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const memberStats = useMemo(() => {
    const stats = {};
    
    allMembers.forEach(member => {
      const publishedArticles = allArticles.filter(
        a => a.author_id === member.id && a.status === 'published'
      ).length;

      const eventsAttended = allBookings.filter(
        b => b.member_id === member.id && b.status === 'confirmed'
      ).length;

      const earnedOnlineAwards = awards.filter(award => {
        const stat = award.award_type === 'events_attended' ? eventsAttended :
                     award.award_type === 'articles_published' ? publishedArticles : 0;
        return stat >= award.threshold;
      });

      const memberOfflineAssignments = offlineAssignments.filter(a => a.member_id === member.id);
      const earnedOfflineAwards = memberOfflineAssignments
        .map(assignment => offlineAwards.find(award => award.id === assignment.offline_award_id))
        .filter(Boolean);

      stats[member.id] = {
        publishedArticles,
        eventsAttended,
        onlineAwards: earnedOnlineAwards,
        offlineAwards: earnedOfflineAwards,
        totalAwards: earnedOnlineAwards.length + earnedOfflineAwards.length
      };
    });

    return stats;
  }, [allMembers, allArticles, allBookings, awards, offlineAssignments, offlineAwards]);

  const filteredAndSortedMembers = useMemo(() => {
    let filtered = allMembers;
    
    // Filter out deleted/anonymized members
    filtered = filtered.filter(member => !isDeletedMember(member));
    
    // Filter out members who opted out of directory
    filtered = filtered.filter(member => member.show_in_directory !== false);
    
    if (!showDisabled) {
      filtered = filtered.filter(member => member.login_enabled !== false);
    }
    
    // Filter by selected organization
    if (selectedOrganization) {
      filtered = filtered.filter(member => {
        const org = organizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
        return org?.id === selectedOrganization;
      });
    }
    
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter(member => {
        const organization = organizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
        return (
          member.first_name?.toLowerCase().includes(searchLower) ||
          member.last_name?.toLowerCase().includes(searchLower) ||
          member.email?.toLowerCase().includes(searchLower) ||
          (displaySettings?.show_job_title && member.job_title?.toLowerCase().includes(searchLower)) ||
          (displaySettings?.show_organization && organization?.name?.toLowerCase().includes(searchLower))
        );
      });
    }
    
    // Filter by custom fields
    const activeFilters = Object.entries(customFieldFilters).filter(([_, value]) => value && value !== 'all');
    if (activeFilters.length > 0) {
      filtered = filtered.filter(member => {
        const memberValues = memberPreferenceMap[member.id] || {};
        return activeFilters.every(([fieldId, filterValue]) => {
          const memberValue = memberValues[fieldId];
          if (!memberValue) return false;
          // For picklist (array), check if filterValue is in the array
          if (Array.isArray(memberValue)) {
            return memberValue.includes(filterValue);
          }
          // For dropdown (single value), check exact match
          return memberValue === filterValue;
        });
      });
    }
    
    // Sort members
    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "name-asc":
          return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
        case "name-desc":
          return `${b.first_name} ${b.last_name}`.localeCompare(`${a.first_name} ${a.last_name}`);
        case "org-asc": {
          const orgA = displaySettings?.show_organization ? (organizations.find(o => o.id === a.organization_id || o.zoho_account_id === a.organization_id)?.name || "") : "";
          const orgB = displaySettings?.show_organization ? (organizations.find(o => o.id === b.organization_id || o.zoho_account_id === b.organization_id)?.name || "") : "";
          return orgA.localeCompare(orgB);
        }
        case "org-desc": {
          const orgA = displaySettings?.show_organization ? (organizations.find(o => o.id === a.organization_id || o.zoho_account_id === a.organization_id)?.name || "") : "";
          const orgB = displaySettings?.show_organization ? (organizations.find(o => o.id === b.organization_id || o.zoho_account_id === b.organization_id)?.name || "") : "";
          return orgB.localeCompare(orgA);
        }
        case "events-desc": {
          const statsA = displaySettings?.show_events ? (memberStats[a.id]?.eventsAttended || 0) : 0;
          const statsB = displaySettings?.show_events ? (memberStats[b.id]?.eventsAttended || 0) : 0;
          return statsB - statsA;
        }
        case "articles-desc": {
          const statsA = displaySettings?.show_articles ? (memberStats[a.id]?.publishedArticles || 0) : 0;
          const statsB = displaySettings?.show_articles ? (memberStats[b.id]?.publishedArticles || 0) : 0;
          return statsB - statsA;
        }
        default:
          return 0;
      }
    });
    
    return sorted;
  }, [allMembers, searchQuery, showDisabled, sortBy, organizations, memberStats, displaySettings, selectedOrganization, customFieldFilters, memberPreferenceMap]);

  const totalPages = Math.ceil(filteredAndSortedMembers.length / itemsPerPage);
  const paginatedMembers = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredAndSortedMembers.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredAndSortedMembers, currentPage, itemsPerPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, showDisabled, sortBy, itemsPerPage, customFieldFilters]);

  const handleViewMember = (member) => {
    setViewingMember(member);
    setBioExpanded(false);
    setEmailCopied(false);
  };

  const handleEmailMember = (email) => {
    window.location.href = `mailto:${email}`;
  };

  const handleCopyEmail = async (email) => {
    try {
      await navigator.clipboard.writeText(email);
      setEmailCopied(true);
      toast.success("Email address copied to clipboard");
      setTimeout(() => setEmailCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy email address");
    }
  };

  const isLoading = membersLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          {/* Header - hidden when custom banner is present */}
          {!hasBanner && (
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-2">
                <Users className="w-8 h-8 text-blue-600" />
                <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                  Member Directory
                </h1>
              </div>
              <p className="text-slate-600">
                {filteredAndSortedMembers.length} {filteredAndSortedMembers.length === 1 ? 'member' : 'members'} across all organisations
              </p>
            </div>
          )}

          <Card className="mb-6 border-slate-200">
            <CardContent className="p-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col md:flex-row gap-4">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search by name, email, job title, or organisation..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  {canShowDisabledAccounts && (
                    <div className="flex items-center gap-3">
                      <Label htmlFor="show-disabled" className="text-sm text-slate-700 whitespace-nowrap cursor-pointer">
                        Show disabled accounts
                      </Label>
                      <Switch
                        id="show-disabled"
                        checked={showDisabled}
                        onCheckedChange={setShowDisabled}
                        data-testid="switch-show-disabled"
                      />
                    </div>
                  )}
                </div>

                <div className="flex flex-col md:flex-row md:items-center gap-4">
                  {displaySettings?.show_organization && (
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-slate-500" />
                      <Label className="text-sm text-slate-700">Organisation:</Label>
                      <Select 
                        value={selectedOrganization || "all"} 
                        onValueChange={(value) => {
                          setSelectedOrganization(value === "all" ? "" : value);
                          setCurrentPage(1);
                        }}
                      >
                        <SelectTrigger className="w-[250px]" data-testid="select-organization-filter">
                          <SelectValue placeholder="All Organisations" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Organisations</SelectItem>
                          {organizations
                            .filter(org => org.name)
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(org => (
                              <SelectItem key={org.id} value={org.id}>
                                {org.name}
                              </SelectItem>
                            ))
                          }
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  
                  <div className="flex items-center gap-2">
                    <ArrowUpDown className="w-4 h-4 text-slate-500" />
                    <Label className="text-sm text-slate-700">Sort by:</Label>
                    <Select value={sortBy} onValueChange={setSortBy}>
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                        <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                        {displaySettings?.show_organization && <SelectItem value="org-asc">Organisation (A-Z)</SelectItem>}
                        {displaySettings?.show_organization && <SelectItem value="org-desc">Organisation (Z-A)</SelectItem>}
                        {displaySettings?.show_events && <SelectItem value="events-desc">Most Events</SelectItem>}
                        {displaySettings?.show_articles && <SelectItem value="articles-desc">Most Articles</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {filterableFields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-200">
                    {filterableFields.map(field => (
                      <div key={field.id} className="flex items-center gap-2">
                        <Label className="text-sm text-slate-700">{field.label}:</Label>
                        <Select 
                          value={customFieldFilters[field.id] || "all"} 
                          onValueChange={(value) => {
                            setCustomFieldFilters(prev => ({
                              ...prev,
                              [field.id]: value === "all" ? "" : value
                            }));
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

          {paginatedMembers.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="p-12 text-center">
                <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No members found</h3>
                <p className="text-slate-600">
                  {searchQuery ? 'Try adjusting your search criteria' : 'No members available'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginatedMembers.map(member => {
                  const stats = memberStats[member.id] || {};
                  const role = roles.find(r => r.id === member.role_id);
                  const organization = organizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
                  
                  return (
                    <Card 
                      key={member.id} 
                      className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer"
                      onClick={() => handleViewMember(member)}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0">
                            {displaySettings?.show_profile_photo && member.profile_photo_url ? (
                              <img 
                                src={member.profile_photo_url} 
                                alt={`${member.first_name} ${member.last_name}`}
                                className="w-16 h-16 rounded-full object-cover border-2 border-slate-200"
                              />
                            ) : (
                              <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center">
                                <User className="w-8 h-8 text-slate-400" />
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <CardTitle className="text-base mb-1">
                              {member.first_name} {member.last_name}
                            </CardTitle>
                            {role && (
                              <div className="flex items-center gap-1 mb-1">
                                <Badge 
                                  variant="secondary" 
                                  className="bg-blue-100 text-blue-700"
                                >
                                  {role.name}
                                </Badge>
                              </div>
                            )}
                            {displaySettings?.show_job_title && member.job_title && (
                              <p className="text-xs text-slate-600 line-clamp-1">{member.job_title}</p>
                            )}
                          </div>
                        </div>
                      </CardHeader>

                      <CardContent className="space-y-3">
                        {displaySettings?.show_organization && organization && (
                          <div className="flex items-start gap-2">
                            <Building2 className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                            <span className="text-sm text-slate-700">{organization.name}</span>
                          </div>
                        )}

                        {displaySettings?.show_linkedin && member.linkedin_url && (
                          <div className="flex items-center gap-2">
                            <a
                              href={member.linkedin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 hover:underline"
                            >
                              <Linkedin className="w-4 h-4" />
                              <span>LinkedIn Profile</span>
                            </a>
                          </div>
                        )}

                        {displaySettings?.show_events && (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Calendar className="w-4 h-4 text-green-600" />
                              <span className="text-sm text-slate-600">Events</span>
                            </div>
                            <Badge variant="secondary">{stats.eventsAttended || 0}</Badge>
                          </div>
                        )}

                        {displaySettings?.show_articles && (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-purple-600" />
                              <span className="text-sm text-slate-600">Articles</span>
                            </div>
                            <Badge variant="secondary">{stats.publishedArticles || 0}</Badge>
                          </div>
                        )}

                        {displaySettings?.show_awards && stats.totalAwards > 0 && (
                          <div className="pt-3 border-t border-slate-200">
                            <div className="flex items-center gap-2 mb-2">
                              <Trophy className="w-4 h-4 text-amber-600" />
                              <span className="text-xs font-semibold text-slate-700">
                                Awards ({stats.totalAwards})
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {stats.onlineAwards.slice(0, 2).map(award => (
                                <Tooltip key={award.id}>
                                  <TooltipTrigger asChild>
                                    <div className="px-2 py-1 bg-gradient-to-br from-amber-50 to-amber-100 rounded border border-amber-200 cursor-help">
                                      {award.image_url ? (
                                        <img src={award.image_url} alt={award.name} className="w-4 h-4 object-contain" />
                                      ) : (
                                        <span className="text-xs font-medium text-slate-900">{award.name}</span>
                                      )}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="font-semibold">{award.name}</p>
                                    {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                                  </TooltipContent>
                                </Tooltip>
                              ))}
                              {stats.offlineAwards.slice(0, 2).map(award => (
                                <Tooltip key={award.id}>
                                  <TooltipTrigger asChild>
                                    <div className="px-2 py-1 bg-gradient-to-br from-purple-50 to-purple-100 rounded border border-purple-200 cursor-help">
                                      {award.image_url ? (
                                        <img src={award.image_url} alt={award.name} className="w-4 h-4 object-contain" />
                                      ) : (
                                        <span className="text-xs font-medium text-slate-900">{award.name}</span>
                                      )}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="font-semibold">{award.name}</p>
                                    {award.period_text && <p className="text-xs text-slate-400 mt-1">{award.period_text}</p>}
                                    {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                                  </TooltipContent>
                                </Tooltip>
                              ))}
                              {stats.totalAwards > 2 && (
                                <div className="px-2 py-1 bg-slate-100 rounded border border-slate-200">
                                  <span className="text-xs font-medium text-slate-600">+{stats.totalAwards - 2}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="mt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm text-slate-700">Show:</Label>
                    <Select value={itemsPerPage.toString()} onValueChange={(val) => setItemsPerPage(parseInt(val))}>
                      <SelectTrigger className="w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="6">6</SelectItem>
                        <SelectItem value="9">9</SelectItem>
                        <SelectItem value="12">12</SelectItem>
                        <SelectItem value="24">24</SelectItem>
                        <SelectItem value="48">48</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-slate-600">per page</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        let pageNum;
                        if (totalPages <= 5) {
                          pageNum = i + 1;
                        } else if (currentPage <= 3) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                          pageNum = totalPages - 4 + i;
                        } else {
                          pageNum = currentPage - 2 + i;
                        }
                        return (
                          <Button
                            key={pageNum}
                            variant={currentPage === pageNum ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCurrentPage(pageNum)}
                            className="w-9"
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* View Member Dialog */}
      <Dialog open={!!viewingMember} onOpenChange={(open) => !open && setViewingMember(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="sr-only">Member Information</DialogTitle>
          </DialogHeader>

          {viewingMember && (
            <div className="space-y-6">
              <div className="flex items-start gap-6">
                <div className="flex-shrink-0">
                  {displaySettings?.show_profile_photo && viewingMember.profile_photo_url ? (
                    <img 
                      src={viewingMember.profile_photo_url} 
                      alt={`${viewingMember.first_name} ${viewingMember.last_name}`}
                      className="w-24 h-24 rounded-full object-cover border-4 border-slate-200"
                    />
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center border-4 border-slate-200">
                      <User className="w-12 h-12 text-blue-600" />
                    </div>
                  )}
                </div>

                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-slate-900 mb-2">
                    {viewingMember.first_name} {viewingMember.last_name}
                  </h2>
                  {displaySettings?.show_job_title && viewingMember.job_title && (
                    <div className="flex items-center gap-2 text-slate-600 mb-3">
                      <Briefcase className="w-4 h-4" />
                      <span>{viewingMember.job_title}</span>
                    </div>
                  )}
                  {(() => {
                    const role = roles.find(r => r.id === viewingMember.role_id);
                    return role ? (
                      <Badge 
                        variant="secondary" 
                        className="bg-blue-100 text-blue-700"
                      >
                        {role.name}
                      </Badge>
                    ) : null;
                  })()}
                </div>
              </div>

              {displaySettings?.show_organization && (() => {
                const organization = organizations.find(o => o.id === viewingMember.organization_id || o.zoho_account_id === viewingMember.organization_id);
                return organization ? (
                  <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                    <div className="flex items-center gap-2 text-slate-700">
                      <Building2 className="w-5 h-5 text-blue-600" />
                      <span className="font-semibold">{organization.name}</span>
                    </div>
                  </div>
                ) : null;
              })()}

              {displaySettings?.show_bio_in_popup && viewingMember.biography && canViewMemberBiography && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">About</h3>
                  <p className={`text-slate-700 leading-relaxed ${!bioExpanded ? 'line-clamp-4' : ''}`}>
                    {viewingMember.biography}
                  </p>
                  {viewingMember.biography.length > 300 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setBioExpanded(!bioExpanded)}
                      className="text-blue-600 hover:text-blue-700 p-0 h-auto font-medium"
                    >
                      {bioExpanded ? (
                        <>
                          <ChevronUp className="w-4 h-4 mr-1" />
                          Show less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-4 h-4 mr-1" />
                          Read more
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {displaySettings?.show_events && (
                  <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="w-5 h-5 text-green-600" />
                      <span className="text-sm font-medium text-green-900">Events Attended</span>
                    </div>
                    <p className="text-2xl font-bold text-green-700">
                      {memberStats[viewingMember.id]?.eventsAttended || 0}
                    </p>
                  </div>
                )}

                {displaySettings?.show_articles && (
                  <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className="w-5 h-5 text-purple-600" />
                      <span className="text-sm font-medium text-purple-900">Articles Published</span>
                    </div>
                    <p className="text-2xl font-bold text-purple-700">
                      {memberStats[viewingMember.id]?.publishedArticles || 0}
                    </p>
                  </div>
                )}
              </div>

              {displaySettings?.show_awards && memberStats[viewingMember.id]?.totalAwards > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-amber-600" />
                    Awards & Recognition ({memberStats[viewingMember.id].totalAwards})
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {memberStats[viewingMember.id].onlineAwards.map(award => (
                      <div key={award.id} className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg p-3 border border-amber-200">
                        <div className="flex items-center gap-2">
                          {award.image_url && (
                            <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-amber-900 line-clamp-1">{award.name}</p>
                            {award.description && (
                              <p className="text-xs text-amber-700 line-clamp-1">{award.description}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    {memberStats[viewingMember.id].offlineAwards.map(award => (
                      <div key={award.id} className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-3 border border-purple-200">
                        <div className="flex items-center gap-2">
                          {award.image_url && (
                            <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-purple-900 line-clamp-1">{award.name}</p>
                            {award.period_text && (
                              <p className="text-xs text-purple-700">{award.period_text}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-slate-200 space-y-3">
                {viewingMember.email && (
                  <div className="flex items-center justify-between bg-slate-50 rounded-lg p-3 border border-slate-200">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Mail className="w-4 h-4 text-slate-500 flex-shrink-0" />
                      <span className="text-sm text-slate-700 truncate" data-testid="text-member-email">
                        {viewingMember.email}
                      </span>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => handleCopyEmail(viewingMember.email)}
                          data-testid="button-copy-email"
                        >
                          {emailCopied ? (
                            <Check className="w-4 h-4 text-green-600" />
                          ) : (
                            <Copy className="w-4 h-4 text-slate-500" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{emailCopied ? "Copied!" : "Copy"}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}

                <Button
                  onClick={() => handleEmailMember(viewingMember.email)}
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  size="lg"
                >
                  <Mail className="w-5 h-5 mr-2" />
                  Send Email to {viewingMember.first_name}
                </Button>

                {displaySettings?.show_linkedin && viewingMember.linkedin_url && (
                  <Button
                    onClick={() => window.open(viewingMember.linkedin_url, '_blank')}
                    variant="outline"
                    className="w-full"
                    size="lg"
                  >
                    <Linkedin className="w-5 h-5 mr-2" />
                    View LinkedIn Profile
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
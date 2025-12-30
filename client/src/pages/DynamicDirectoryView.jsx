import { useState, useMemo, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Building2, Search, Globe, Users, Loader2, ChevronLeft, ChevronRight, ArrowDownAZ, ArrowUpZA, Pencil, Trash2, Upload, ExternalLink, ClipboardList, User, AlertCircle, Mail, FileText, Trophy, Shield, Calendar, Briefcase, ChevronDown, ChevronUp, Linkedin, ArrowUpDown, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";
import { isDeletedMember } from "@/utils";

export default function DynamicDirectoryView() {
  const { slug } = useParams();
  const { isAdmin, isFeatureExcluded, memberInfo } = useMemberAccess();
  const queryClient = useQueryClient();

  const canEditLogos = isAdmin && !isFeatureExcluded('action_org_logo_edit');
  const canShowDisabledAccounts = !isFeatureExcluded('element_ShowDisabledAccounts');
  
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);
  const [sortOrder, setSortOrder] = useState("asc");
  const [sortBy, setSortBy] = useState("name-asc");
  const [editingOrg, setEditingOrg] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [viewingMember, setViewingMember] = useState(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  const [showDisabled, setShowDisabled] = useState(false);
  const [selectedOrganization, setSelectedOrganization] = useState("");

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

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => base44.entities.Role.list(),
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 5 * 60 * 1000,
  });

  const { data: allOrganizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => base44.entities.Organization.list(),
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 5 * 60 * 1000,
  });

  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active);
    },
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 5 * 60 * 1000,
  });

  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments'],
    queryFn: async () => base44.entities.OfflineAwardAssignment.list(),
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 60 * 1000,
  });

  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offline-awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.filter(a => a.is_active);
    },
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 5 * 60 * 1000,
  });

  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings'],
    queryFn: async () => base44.entities.Booking.list(),
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 60 * 1000,
  });

  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles'],
    queryFn: async () => base44.entities.BlogPost.list(),
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 60 * 1000,
  });

  const { data: orgDisplaySettings } = useQuery({
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

  const { data: memberDisplaySettings } = useQuery({
    queryKey: ['memberDirectoryDisplay'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'member_directory_display');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return {
            show_profile_photo: true, show_events: true, show_articles: true,
            show_organization: true, show_job_title: true, show_linkedin: true,
            show_awards: true, show_bio_in_popup: true
          };
        }
      }
      return {
        show_profile_photo: true, show_events: true, show_articles: true,
        show_organization: true, show_job_title: true, show_linkedin: true,
        show_awards: true, show_bio_in_popup: true
      };
    },
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: allOrgMembersForCount = [] } = useQuery({
    queryKey: ['all-members-for-org-directory-count'],
    queryFn: async () => base44.entities.Member.listAll(),
    enabled: !!directory && directory.entity_type === 'organization',
    staleTime: 0,
    refetchOnMount: true
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization'],
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
    },
    enabled: !!directory && directory.entity_type === 'organization',
  });

  const { data: memberCustomFields = [] } = useQuery({
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
          return (allFields || []).filter(f => (!f.entity_scope || f.entity_scope === 'member') && f.is_filterable);
        } catch {
          return [];
        }
      }
    },
    enabled: !!directory && directory.entity_type === 'member',
    staleTime: 5 * 60 * 1000,
  });

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

  const filterableOrgFields = useMemo(() => {
    const baseFilterable = orgCustomFields.filter(f => f.is_filterable && f.id !== directory?.filter_field_id);
    // If selected_filter_fields is undefined/null, show all filterable fields (backward compatibility)
    // If selected_filter_fields is an explicit empty array [], show no filters
    // If selected_filter_fields has values, only show those selected fields
    if (directory?.selected_filter_fields === undefined || directory?.selected_filter_fields === null) {
      return baseFilterable;
    }
    if (directory.selected_filter_fields.length === 0) {
      return [];
    }
    return baseFilterable.filter(f => directory.selected_filter_fields.includes(f.id));
  }, [orgCustomFields, directory?.filter_field_id, directory?.selected_filter_fields]);

  const filterableMemberFields = useMemo(() => {
    const baseFilterable = memberCustomFields.filter(f => f.id !== directory?.filter_field_id);
    // If selected_filter_fields is undefined/null, show all filterable fields (backward compatibility)
    // If selected_filter_fields is an explicit empty array [], show no filters
    // If selected_filter_fields has values, only show those selected fields
    if (directory?.selected_filter_fields === undefined || directory?.selected_filter_fields === null) {
      return baseFilterable;
    }
    if (directory.selected_filter_fields.length === 0) {
      return [];
    }
    return baseFilterable.filter(f => directory.selected_filter_fields.includes(f.id));
  }, [memberCustomFields, directory?.filter_field_id, directory?.selected_filter_fields]);

  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values', directory?.filter_field_id],
    enabled: !!directory && directory.entity_type === 'organization',
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
    enabled: !!directory && directory.entity_type === 'member',
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
          } catch {}
        }
      }
      const fieldId = pv.field_id || pv.preference_field_id;
      map[pv.organization_id][fieldId] = normalizedValue;
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
          } catch {}
        }
      }
      const fieldId = pv.field_id || pv.preference_field_id;
      map[pv.member_id][fieldId] = normalizedValue;
    });
    return map;
  }, [allMemberPreferenceValues]);

  const organizationMemberCounts = useMemo(() => {
    const counts = {};
    allOrgMembersForCount.forEach((member) => {
      if (member.organization_id && !isDeletedMember(member)) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [allOrgMembersForCount]);

  const memberStats = useMemo(() => {
    const stats = {};
    members.forEach(member => {
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
        publishedArticles, eventsAttended,
        onlineAwards: earnedOnlineAwards,
        offlineAwards: earnedOfflineAwards,
        totalAwards: earnedOnlineAwards.length + earnedOfflineAwards.length
      };
    });
    return stats;
  }, [members, allArticles, allBookings, awards, offlineAssignments, offlineAwards]);

  const getGridClass = () => {
    const cols = orgDisplaySettings?.cardsPerRow || '3';
    switch (cols) {
      case '2': return 'grid grid-cols-1 md:grid-cols-2 gap-6';
      case '3': return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6';
      case '4': return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6';
      case '5': return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6';
      case '6': return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6';
      default: return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6';
    }
  };

  const filteredOrganizations = useMemo(() => {
    if (!directory || directory.entity_type !== 'organization') return [];

    const excludedIds = orgDisplaySettings?.excludedOrgIds || [];
    let filtered = organizations.filter(org => !excludedIds.includes(org.id));

    if (directory.filter_field_id && directory.filter_value) {
      filtered = filtered.filter(org => {
        const orgValues = orgPreferenceMap[org.id] || {};
        const orgValue = orgValues[directory.filter_field_id];
        if (!orgValue) return false;
        if (Array.isArray(orgValue)) return orgValue.includes(directory.filter_value);
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

    const activeFilters = Object.entries(customFieldFilters).filter(([_, value]) => value && value !== 'all');
    if (activeFilters.length > 0) {
      filtered = filtered.filter(org => {
        const orgValues = orgPreferenceMap[org.id] || {};
        return activeFilters.every(([fieldId, filterValue]) => {
          const orgValue = orgValues[fieldId];
          if (!orgValue) return false;
          if (Array.isArray(orgValue)) return orgValue.includes(filterValue);
          return orgValue === filterValue;
        });
      });
    }

    filtered.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      return sortOrder === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
    });

    return filtered;
  }, [organizations, searchQuery, orgDisplaySettings?.excludedOrgIds, sortOrder, directory, orgPreferenceMap, customFieldFilters]);

  const filteredMembers = useMemo(() => {
    if (!directory || directory.entity_type !== 'member') return [];

    let filtered = members.filter(member => member.show_in_directory !== false);
    if (!showDisabled) {
      filtered = filtered.filter(member => member.login_enabled !== false);
    }

    if (directory.filter_field_id && directory.filter_value) {
      filtered = filtered.filter(member => {
        const memberValues = memberPreferenceMap[member.id] || {};
        const memberValue = memberValues[directory.filter_field_id];
        if (!memberValue) return false;
        if (Array.isArray(memberValue)) return memberValue.includes(directory.filter_value);
        return memberValue === directory.filter_value;
      });
    }

    if (selectedOrganization) {
      filtered = filtered.filter(member => {
        const org = allOrganizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
        return org?.id === selectedOrganization;
      });
    }

    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter(member => {
        const organization = allOrganizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
        return (
          member.first_name?.toLowerCase().includes(searchLower) ||
          member.last_name?.toLowerCase().includes(searchLower) ||
          member.email?.toLowerCase().includes(searchLower) ||
          (memberDisplaySettings?.show_job_title && member.job_title?.toLowerCase().includes(searchLower)) ||
          (memberDisplaySettings?.show_organization && organization?.name?.toLowerCase().includes(searchLower))
        );
      });
    }

    const activeFilters = Object.entries(customFieldFilters).filter(([_, value]) => value && value !== 'all');
    if (activeFilters.length > 0) {
      filtered = filtered.filter(member => {
        const memberValues = memberPreferenceMap[member.id] || {};
        return activeFilters.every(([fieldId, filterValue]) => {
          const memberValue = memberValues[fieldId];
          if (!memberValue) return false;
          if (Array.isArray(memberValue)) return memberValue.includes(filterValue);
          return memberValue === filterValue;
        });
      });
    }

    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "name-asc":
          return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
        case "name-desc":
          return `${b.first_name} ${b.last_name}`.localeCompare(`${a.first_name} ${a.last_name}`);
        case "org-asc": {
          const orgA = memberDisplaySettings?.show_organization ? (allOrganizations.find(o => o.id === a.organization_id || o.zoho_account_id === a.organization_id)?.name || "") : "";
          const orgB = memberDisplaySettings?.show_organization ? (allOrganizations.find(o => o.id === b.organization_id || o.zoho_account_id === b.organization_id)?.name || "") : "";
          return orgA.localeCompare(orgB);
        }
        case "org-desc": {
          const orgA = memberDisplaySettings?.show_organization ? (allOrganizations.find(o => o.id === a.organization_id || o.zoho_account_id === a.organization_id)?.name || "") : "";
          const orgB = memberDisplaySettings?.show_organization ? (allOrganizations.find(o => o.id === b.organization_id || o.zoho_account_id === b.organization_id)?.name || "") : "";
          return orgB.localeCompare(orgA);
        }
        case "events-desc": {
          const statsA = memberDisplaySettings?.show_events ? (memberStats[a.id]?.eventsAttended || 0) : 0;
          const statsB = memberDisplaySettings?.show_events ? (memberStats[b.id]?.eventsAttended || 0) : 0;
          return statsB - statsA;
        }
        case "articles-desc": {
          const statsA = memberDisplaySettings?.show_articles ? (memberStats[a.id]?.publishedArticles || 0) : 0;
          const statsB = memberDisplaySettings?.show_articles ? (memberStats[b.id]?.publishedArticles || 0) : 0;
          return statsB - statsA;
        }
        default:
          return 0;
      }
    });

    return sorted;
  }, [members, searchQuery, sortBy, directory, memberPreferenceMap, customFieldFilters, showDisabled, selectedOrganization, allOrganizations, memberDisplaySettings, memberStats]);

  const items = directory?.entity_type === 'organization' ? filteredOrganizations : filteredMembers;
  const totalPages = Math.ceil(items.length / itemsPerPage);
  const paginatedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return items.slice(startIndex, startIndex + itemsPerPage);
  }, [items, currentPage, itemsPerPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, showDisabled, sortBy, sortOrder, customFieldFilters, selectedOrganization]);

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
    } catch {
      toast.error("Failed to copy email address");
    }
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

  if (directory.entity_type === 'organization') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <Building2 className="w-8 h-8 text-blue-600" />
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="directory-title">
                {directory.name}
              </h1>
            </div>
            <p className="text-slate-600" data-testid="directory-count">
              {items.length} {items.length === 1 ? 'organisation' : 'organisations'}
              {filterField && (
                <Badge variant="secondary" className="ml-2">
                  {filterField.label}: {directory.filter_value}
                </Badge>
              )}
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
                
                {filterableOrgFields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-200">
                    {filterableOrgFields.map(field => (
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

          {items.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="p-12 text-center">
                <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No organisations found</h3>
                <p className="text-slate-600">
                  {searchQuery ? 'Try adjusting your search criteria' : 'No organisations match the selected filter'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className={getGridClass()}>
                {paginatedItems.map((org) => {
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
                        {orgDisplaySettings?.showLogo && (
                          <div className="relative w-[90%] aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center mb-3 group">
                            {org.logo_url ? (
                              <img
                                src={org.logo_url}
                                alt={org.name}
                                className={`w-full h-full object-contain transition-all duration-300 ${orgDisplaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`}
                              />
                            ) : (
                              <Building2 className={`w-16 h-16 text-slate-400 transition-all duration-300 ${orgDisplaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`} />
                            )}
                            {orgDisplaySettings?.showNameTooltip && (
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
                        {orgDisplaySettings?.showTitle !== false && (
                          <CardTitle className="text-base line-clamp-2 w-full">{org.name}</CardTitle>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {orgDisplaySettings?.showDomains && allDomains.length > 0 && (
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
                        {orgDisplaySettings?.showMemberCount && (
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

              {totalPages > 1 && (
                <div className="mt-6 flex justify-center items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
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
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <Dialog open={!!editingOrg && !showDeleteConfirm} onOpenChange={(open) => !open && setEditingOrg(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit Organisation Logo</DialogTitle>
              <DialogDescription>Upload a new logo for {editingOrg?.name}</DialogDescription>
              <p className="text-xs text-slate-500 mt-1">Recommended size: 200 x 200 pixels (square)</p>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex justify-center">
                <div className="w-32 h-32 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center">
                  {editingOrg?.logo_url ? (
                    <img src={editingOrg.logo_url} alt={editingOrg.name} className="w-full h-full object-contain" />
                  ) : (
                    <Building2 className="w-12 h-12 text-slate-400" />
                  )}
                </div>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
              <Button className="w-full" onClick={() => fileInputRef.current?.click()} disabled={isUploading || updateLogoMutation.isPending}>
                {isUploading || updateLogoMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading...</>
                ) : (
                  <><Upload className="w-4 h-4 mr-2" />Upload New Logo</>
                )}
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingOrg(null)}>Cancel</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Remove Logo</DialogTitle>
              <DialogDescription>Are you sure you want to remove the logo for {editingOrg?.name}? This action cannot be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteLogo} disabled={updateLogoMutation.isPending}>
                {updateLogoMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Removing...</> : 'Remove Logo'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!selectedOrg} onOpenChange={(open) => !open && setSelectedOrg(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center flex-shrink-0">
                  {selectedOrg?.logo_url ? (
                    <img src={selectedOrg.logo_url} alt={selectedOrg?.name} className="w-full h-full object-contain" />
                  ) : (
                    <Building2 className="w-8 h-8 text-slate-400" />
                  )}
                </div>
                <div>
                  <DialogTitle className="text-xl">{selectedOrg?.name}</DialogTitle>
                  {selectedOrg?.domain && (
                    <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                      <Globe className="w-3 h-3" />@{selectedOrg.domain}
                    </p>
                  )}
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 text-slate-600">
                <Users className="w-4 h-4" />
                <span>{organizationMemberCounts[selectedOrg?.id] || 0} members</span>
              </div>
              {selectedOrg?.additional_verified_domains?.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-700">Additional Domains</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedOrg.additional_verified_domains.map((domain, idx) => (
                      <Badge key={idx} variant="secondary" className="text-xs">@{domain}</Badge>
                    ))}
                  </div>
                </div>
              )}
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
                        if (field.field_type === 'picklist' && displayValue) {
                          try {
                            const parsed = JSON.parse(displayValue);
                            if (Array.isArray(parsed) && field.options) {
                              displayValue = parsed.map(v => field.options.find(o => o.value === v)?.label || v).join(', ');
                            }
                          } catch {}
                        }
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
              <Button variant="outline" onClick={() => setSelectedOrg(null)}>Close</Button>
              <Button
                onClick={() => { window.location.href = `/memberdirectory?org=${selectedOrg?.id}`; }}
                className="bg-blue-600 hover:bg-blue-700 gap-2"
                data-testid="button-view-members"
              >
                <Users className="w-4 h-4" />View Members<ExternalLink className="w-3 h-3" />
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <Users className="w-8 h-8 text-blue-600" />
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="directory-title">
                {directory.name}
              </h1>
            </div>
            <p className="text-slate-600" data-testid="directory-count">
              {items.length} {items.length === 1 ? 'member' : 'members'}
              {filterField && (
                <Badge variant="secondary" className="ml-2">
                  {filterField.label}: {directory.filter_value}
                </Badge>
              )}
            </p>
          </div>

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
                      data-testid="input-search-members"
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
                  {memberDisplaySettings?.show_organization && (
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
                          {allOrganizations
                            .filter(org => org.name)
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(org => (
                              <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
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
                        {memberDisplaySettings?.show_organization && <SelectItem value="org-asc">Organisation (A-Z)</SelectItem>}
                        {memberDisplaySettings?.show_organization && <SelectItem value="org-desc">Organisation (Z-A)</SelectItem>}
                        {memberDisplaySettings?.show_events && <SelectItem value="events-desc">Most Events</SelectItem>}
                        {memberDisplaySettings?.show_articles && <SelectItem value="articles-desc">Most Articles</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {filterableMemberFields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-200">
                    {filterableMemberFields.map(field => (
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
                              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
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

          {paginatedItems.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="p-12 text-center">
                <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No members found</h3>
                <p className="text-slate-600">
                  {searchQuery ? 'Try adjusting your search criteria' : 'No members match the selected filter'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginatedItems.map(member => {
                  const stats = memberStats[member.id] || {};
                  const role = roles.find(r => r.id === member.role_id);
                  const organization = allOrganizations.find(o => o.id === member.organization_id || o.zoho_account_id === member.organization_id);
                  
                  return (
                    <Card 
                      key={member.id} 
                      className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer"
                      onClick={() => handleViewMember(member)}
                      data-testid={`card-member-${member.id}`}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0">
                            {memberDisplaySettings?.show_profile_photo && member.profile_photo_url ? (
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
                            {memberDisplaySettings?.show_job_title && member.job_title && (
                              <p className="text-xs text-slate-600 line-clamp-1">{member.job_title}</p>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {memberDisplaySettings?.show_organization && organization && (
                          <div className="flex items-start gap-2">
                            <Building2 className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                            <span className="text-sm text-slate-700">{organization.name}</span>
                          </div>
                        )}
                        {memberDisplaySettings?.show_linkedin && member.linkedin_url && (
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
                        {memberDisplaySettings?.show_events && (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Calendar className="w-4 h-4 text-green-600" />
                              <span className="text-sm text-slate-600">Events</span>
                            </div>
                            <Badge variant="secondary">{stats.eventsAttended || 0}</Badge>
                          </div>
                        )}
                        {memberDisplaySettings?.show_articles && (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-purple-600" />
                              <span className="text-sm text-slate-600">Articles</span>
                            </div>
                            <Badge variant="secondary">{stats.publishedArticles || 0}</Badge>
                          </div>
                        )}
                        {memberDisplaySettings?.show_awards && stats.totalAwards > 0 && (
                          <div className="pt-3 border-t border-slate-200">
                            <div className="flex items-center gap-2 mb-2">
                              <Trophy className="w-4 h-4 text-amber-600" />
                              <span className="text-xs font-semibold text-slate-700">
                                Awards ({stats.totalAwards})
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {stats.onlineAwards?.slice(0, 2).map(award => (
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
                              {stats.offlineAwards?.slice(0, 2).map(award => (
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

      <Dialog open={!!viewingMember} onOpenChange={(open) => !open && setViewingMember(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="sr-only">Member Information</DialogTitle>
          </DialogHeader>
          {viewingMember && (
            <div className="space-y-6">
              <div className="flex items-start gap-6">
                <div className="flex-shrink-0">
                  {memberDisplaySettings?.show_profile_photo && viewingMember.profile_photo_url ? (
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
                  {memberDisplaySettings?.show_job_title && viewingMember.job_title && (
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

              {memberDisplaySettings?.show_organization && (() => {
                const organization = allOrganizations.find(o => o.id === viewingMember.organization_id || o.zoho_account_id === viewingMember.organization_id);
                return organization ? (
                  <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                    <div className="flex items-center gap-2 text-slate-700">
                      <Building2 className="w-5 h-5 text-blue-600" />
                      <span className="font-semibold">{organization.name}</span>
                    </div>
                  </div>
                ) : null;
              })()}

              {memberDisplaySettings?.show_bio_in_popup && viewingMember.biography && (
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
                        <><ChevronUp className="w-4 h-4 mr-1" />Show less</>
                      ) : (
                        <><ChevronDown className="w-4 h-4 mr-1" />Read more</>
                      )}
                    </Button>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                {memberDisplaySettings?.show_events && (
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
                {memberDisplaySettings?.show_articles && (
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

              {memberDisplaySettings?.show_awards && memberStats[viewingMember.id]?.totalAwards > 0 && (
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
                {memberDisplaySettings?.show_linkedin && viewingMember.linkedin_url && (
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

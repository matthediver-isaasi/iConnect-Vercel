import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import RoleBadge from "@/components/RoleBadge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, User, Mail, FileText, Trophy, Search, Users, Shield, Calendar, Clock, Edit, X, ChevronLeft, ChevronRight, UserPlus, Link, Copy, Check, UserCheck, Infinity as InfinityIcon, AlertTriangle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { formatDistanceToNow, differenceInCalendarDays, format } from "date-fns";
import { toast } from "sonner";
import { sendTeamMemberInvite } from "@/api/functions";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import GuestAccessControl, { getGuestStatus } from "@/components/GuestAccessControl";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

export default function TeamPage({ hasBanner }) {
  const { memberInfo, organizationInfo, isFeatureExcluded } = useMemberAccess();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("all");
  const [showDisabled, setShowDisabled] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(9);
  const [editingMember, setEditingMember] = useState(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubject, setInviteSubject] = useState("");
  const [inviteBody, setInviteBody] = useState("");
  const [editForm, setEditForm] = useState({ first_name: "", last_name: "", job_title: "", email: "", profile_photo_url: "", linkedin_url: "", role_id: "none", role_effective_from: null });
  const [signupLinkCopied, setSignupLinkCopied] = useState(false);
  // Local edit state for the per-org Guest Access card. Mirrors the
  // organisation row but lets the admin tweak the period without saving on
  // every keystroke.
  const [orgGuestForm, setOrgGuestForm] = useState({
    enabled: false,
    period_days: 30,
    unlimited: false,
  });
  const queryClient = useQueryClient();


  const handleCopySignupLink = async () => {
    if (!signupLink) return;
    try {
      await navigator.clipboard.writeText(signupLink);
      setSignupLinkCopied(true);
      toast.success('Link copied to clipboard');
      setTimeout(() => setSignupLinkCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  // Fetch members from the same organization directly via server-side filter
  const { data: teamMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['team-members', memberInfo?.organization_id],
    queryFn: async () => {
      if (!memberInfo?.organization_id) return [];
      // Use server-side filter to only fetch members from this organization
      return base44.entities.Member.filter({ organization_id: memberInfo.organization_id });
    },
    enabled: !!memberInfo?.organization_id
  });

  // Fetch organization's verified domains from preference_field/organization_preference_value
  const { data: orgDomainsData } = useQuery({
    queryKey: ['org-verified-domains', memberInfo?.organization_id],
    queryFn: async () => await publicClient.getOrganizationDomains(memberInfo?.organization_id) || null,
    enabled: !!memberInfo?.organization_id
  });

  // Fetch all articles to count posts
  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles'],
    queryFn: async () => {
      return await base44.entities.BlogPost.list();
    }
  });

  // Fetch roles
  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      return await base44.entities.Role.list();
    }
  });

  const memberRole = useMemo(() => {
    if (!memberInfo?.role_id || !roles.length) return null;
    return roles.find(r => r.id === memberInfo.role_id) || null;
  }, [memberInfo?.role_id, roles]);

  const signupLink = useMemo(() => {
    if (!memberInfo?.organization_id) return null;
    const linkTemplate = memberRole?.signup_link_template;
    if (!linkTemplate) return null;
    const tenantDomain = window.location.origin;
    return linkTemplate
      .replace(/\[\[organization_id\]\]/g, memberInfo.organization_id)
      .replace(/\[\[tenant_domain\]\]/g, tenantDomain);
  }, [memberRole?.signup_link_template, memberInfo?.organization_id]);

  const rolesInUse = useMemo(() => {
    const roleIdsInTeam = new Set(teamMembers.map(m => m.role_id).filter(Boolean));
    return roles
      .filter(r => roleIdsInTeam.has(r.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [teamMembers, roles]);

  const inviteTemplateId = useMemo(() => {
    return memberRole?.invite_email_template_id || null;
  }, [memberRole?.invite_email_template_id]);

  const { data: inviteTemplate } = useQuery({
    queryKey: ['email-template', inviteTemplateId],
    queryFn: async () => {
      if (!inviteTemplateId) return null;
      const templates = await base44.entities.EmailTemplate.list();
      return templates.find(t => t.id === inviteTemplateId) || null;
    },
    enabled: !!inviteTemplateId
  });

  const replaceAllPlaceholders = (text) => {
    if (!text) return text;
    const inviterFirst = memberInfo?.first_name || '';
    const inviterLast = memberInfo?.last_name || '';
    const inviterFull = [inviterFirst, inviterLast].filter(Boolean).join(' ');
    const orgName = organizationInfo?.name || '';
    const orgId = memberInfo?.organization_id || '';

    let result = text;
    result = result.replace(/\{\{inviter_name\}\}/gi, inviterFull);
    result = result.replace(/\{\{organization_name\}\}/gi, orgName);
    result = result.replace(/\{\{organization_id\}\}/gi, orgId);

    result = result.replace(/\[\[member\.full_name\]\]/gi, inviterFull);
    result = result.replace(/\[\[member_full_name\]\]/gi, inviterFull);
    result = result.replace(/\[\[member\.first_name\]\]/gi, inviterFirst);
    result = result.replace(/\[\[member_first_name\]\]/gi, inviterFirst);
    result = result.replace(/\[\[member\.last_name\]\]/gi, inviterLast);
    result = result.replace(/\[\[member_last_name\]\]/gi, inviterLast);
    result = result.replace(/\[\[member\.email\]\]/gi, memberInfo?.email || '');
    result = result.replace(/\[\[member_email\]\]/gi, memberInfo?.email || '');
    result = result.replace(/\[\[organization\.name\]\]/gi, orgName);
    result = result.replace(/\[\[organization_name\]\]/gi, orgName);
    result = result.replace(/\[\[organization\.id\]\]/gi, orgId);
    result = result.replace(/\[\[organization_id\]\]/gi, orgId);
    return result;
  };

  useEffect(() => {
    if (showInviteDialog && inviteTemplate) {
      let subject = inviteTemplate.subject || 'You have been invited to join our team';
      let body = inviteTemplate.body || '';
      
      setInviteSubject(replaceAllPlaceholders(subject));
      setInviteBody(replaceAllPlaceholders(body));
    } else if (showInviteDialog && !inviteTemplate) {
      const inviterFull = [memberInfo?.first_name, memberInfo?.last_name].filter(Boolean).join(' ');
      const orgName = organizationInfo?.name || '';
      setInviteSubject(`You're invited to join ${orgName || 'our team'}`);
      setInviteBody(`<p>Hi,</p><p>${inviterFull} has invited you to join ${orgName || 'our team'}.</p><p>Click the link below to accept the invitation and set up your account:</p><p style="margin: 20px 0; text-align: center;"><a href="{{invite_link}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invitation</a></p>`);
    }
  }, [showInviteDialog, inviteTemplate, memberInfo, organizationInfo]);

  // Fetch online awards
  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active);
    }
  });

  // Fetch offline award assignments
  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments'],
    queryFn: async () => {
      return await base44.entities.OfflineAwardAssignment.list();
    }
  });

  // Fetch award sublevels
  const { data: awardSublevels = [] } = useQuery({
    queryKey: ['award-sublevels'],
    queryFn: async () => {
      return await base44.entities.AwardSublevel.list();
    }
  });

  // Fetch award classifications
  const { data: awardClassifications = [] } = useQuery({
    queryKey: ['award-classifications'],
    queryFn: async () => {
      return await base44.entities.AwardClassification.list();
    }
  });

  // Fetch team card display settings
  const { data: cardSettings = {} } = useQuery({
    queryKey: ['team-card-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'team_card_display');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return {};
        }
      }
      return {};
    }
  });

  // Fetch section order settings
  const { data: sectionOrder = null } = useQuery({
    queryKey: ['team-card-section-order'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'team_card_section_order');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return null;
        }
      }
      return null;
    }
  });

  // Default section order
  const DEFAULT_SECTION_ORDER = ['profile_photo', 'name_role', 'email', 'last_activity', 'login_toggle', 'events_count', 'articles_count', 'awards'];
  const orderedSections = sectionOrder || DEFAULT_SECTION_ORDER;

  // Default settings - show everything if not configured
  const showProfilePhoto = cardSettings.show_profile_photo !== false;
  const showRoleBadge = cardSettings.show_role_badge !== false;
  const showJobTitle = cardSettings.show_job_title !== false;
  const showEmail = cardSettings.show_email !== false;
  const showLastActivity = cardSettings.show_last_activity !== false;
  const showLoginToggle = cardSettings.show_login_toggle !== false;
  const showEventsCount = cardSettings.show_events_count !== false;
  const showArticlesCount = cardSettings.show_articles_count !== false;
  const showAwards = cardSettings.show_awards !== false;

  // Fetch offline awards
  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offline-awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.filter(a => a.is_active);
    }
  });

  // Fetch all bookings for engagement stats
  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings'],
    queryFn: async () => {
      return await base44.entities.Booking.list();
    }
  });

  // Tenant master Guest Access setting — drives whether the per-org card is
  // even visible. When the master switch is off, every org behaves as if
  // guests are off regardless of the stored org settings.
  const { data: tenantGuestAccess = null } = useQuery({
    queryKey: ['tenant-guest-access-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'guest_access');
      let value = { enabled: false, default_period_days: 30, unlimited: false };
      if (setting?.setting_value) {
        try {
          const parsed = JSON.parse(setting.setting_value);
          const days = Number(parsed.default_period_days);
          value = {
            enabled: !!parsed.enabled,
            default_period_days: Number.isFinite(days) && days > 0 ? days : 30,
            unlimited: parsed.default_period_days === null || parsed.unlimited === true,
          };
        } catch {
          // ignore
        }
      }
      return value;
    }
  });

  // Fetch the latest Organization row so the Guest Access card reflects what
  // is persisted (rather than the cached organizationInfo from session).
  const { data: orgRecord = null } = useQuery({
    queryKey: ['organization-record', memberInfo?.organization_id],
    queryFn: async () => {
      if (!memberInfo?.organization_id) return null;
      return await base44.entities.Organization.get(memberInfo.organization_id);
    },
    enabled: !!memberInfo?.organization_id,
  });

  useEffect(() => {
    if (!orgRecord) return;
    const orgDays = Number(orgRecord.guest_access_period_days);
    const orgUnlimited = !!orgRecord.guest_access_unlimited;
    const orgHasOverride = orgUnlimited || (Number.isFinite(orgDays) && orgDays > 0);
    setOrgGuestForm({
      enabled: !!orgRecord.guest_access_enabled,
      // When the org has no override yet, prefill from the tenant default so
      // the very first save persists the inherited value.
      period_days: orgHasOverride && Number.isFinite(orgDays) && orgDays > 0
        ? orgDays
        : (tenantGuestAccess?.default_period_days || 30),
      unlimited: orgHasOverride
        ? orgUnlimited
        : !!tenantGuestAccess?.unlimited,
    });
  }, [orgRecord, tenantGuestAccess?.default_period_days, tenantGuestAccess?.unlimited]);

  // Update org guest access mutation
  const updateOrgGuestAccessMutation = useMutation({
    mutationFn: async (next) => {
      if (!memberInfo?.organization_id) throw new Error('No organisation');
      const payload = {
        guest_access_enabled: !!next.enabled,
        guest_access_unlimited: !!next.unlimited,
        guest_access_period_days: next.unlimited ? null : Number(next.period_days),
      };
      return await base44.entities.Organization.update(memberInfo.organization_id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-record', memberInfo?.organization_id] });
      toast.success('Guest Access updated');
    },
    onError: (error) => {
      toast.error('Failed to update Guest Access: ' + (error?.message || ''));
    }
  });

  const persistOrgGuestAccess = (next) => {
    setOrgGuestForm(next);
    updateOrgGuestAccessMutation.mutate(next);
  };

  // Toggle login mutation
  const toggleLoginMutation = useMutation({
    mutationFn: async ({ memberId, newValue }) => {
      return await base44.entities.Member.update(memberId, {
        login_enabled: newValue
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      toast.success('Login access updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update login access');
    }
  });

  // Update member mutation
  const updateMemberMutation = useMutation({
    mutationFn: async ({ memberId, data }) => {
      return await base44.entities.Member.update(memberId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      toast.success('Member updated successfully');
      setEditingMember(null);
    },
    onError: (error) => {
      const serverMsg = error?.response?.data?.error || error?.message;
      toast.error(serverMsg || 'Failed to update member');
    }
  });

  // Send invite mutation
  const sendInviteMutation = useMutation({
    mutationFn: async ({ email, subject, body }) => {
      const response = await sendTeamMemberInvite({
        email,
        inviterName: `${memberInfo.first_name} ${memberInfo.last_name}`,
        inviterEmail: memberInfo.email,
        emailSubject: subject,
        emailBody: body,
        organizationId: memberInfo.organization_id
      });
      return response.data;
    },
    onSuccess: () => {
      toast.success('Invitation sent successfully');
      setShowInviteDialog(false);
      setInviteEmail("");
      setInviteSubject("");
      setInviteBody("");
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to send invitation');
    }
  });

  // Calculate member stats
  const memberStats = useMemo(() => {
    const stats = {};
    
    teamMembers.forEach(member => {
      const publishedArticles = allArticles.filter(
        a => a.author_id === member.id && a.status === 'published'
      ).length;

      const eventsAttended = allBookings.filter(
        b => b.member_id === member.id && b.status === 'confirmed'
      ).length;

      // Calculate online awards
      const earnedOnlineAwards = awards.filter(award => {
        const stat = award.award_type === 'events_attended' ? eventsAttended :
                     award.award_type === 'articles_published' ? publishedArticles : 0;
        return stat >= award.threshold;
      });

      // Calculate offline awards with sublevel info
      const memberOfflineAssignments = offlineAssignments.filter(a => a.member_id === member.id);
      const earnedOfflineAwards = memberOfflineAssignments
        .map(assignment => {
          const award = offlineAwards.find(a => a.id === assignment.offline_award_id);
          if (!award) return null;
          const sublevel = assignment.sublevel_id ? awardSublevels.find(s => s.id === assignment.sublevel_id) : null;
          return { ...award, sublevel };
        })
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
  }, [teamMembers, allArticles, allBookings, awards, offlineAssignments, offlineAwards, awardSublevels]);

  // Filter members based on search, role, and showDisabled toggle
  const filteredMembers = useMemo(() => {
    let filtered = teamMembers;
    
    // Filter by disabled accounts
    if (!showDisabled) {
      filtered = filtered.filter(member => member.login_enabled !== false);
    }
    
    // Filter by role
    if (selectedRoleId && selectedRoleId !== 'all') {
      filtered = filtered.filter(member => member.role_id === selectedRoleId);
    }
    
    // Filter by search
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter(member => 
        member.first_name?.toLowerCase().includes(searchLower) ||
        member.last_name?.toLowerCase().includes(searchLower) ||
        member.email?.toLowerCase().includes(searchLower) ||
        member.job_title?.toLowerCase().includes(searchLower)
      );
    }
    
    return filtered;
  }, [teamMembers, searchQuery, selectedRoleId, showDisabled]);

  // Pagination
  const totalPages = Math.ceil(filteredMembers.length / itemsPerPage);
  const paginatedMembers = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredMembers.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredMembers, currentPage, itemsPerPage]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedRoleId, showDisabled]);

  const handleToggleLogin = (member, newValue) => {
    toggleLoginMutation.mutate({ memberId: member.id, newValue });
  };

  const handleEditClick = (member) => {
    setEditingMember(member);
    setEditForm({
      first_name: member.first_name || "",
      last_name: member.last_name || "",
      job_title: member.job_title || "",
      email: member.email || "",
      profile_photo_url: member.profile_photo_url || "",
      linkedin_url: member.linkedin_url || "",
      role_id: member.role_id || "none",
      role_effective_from: member.role_effective_from || null
    });
  };

  const handleClearPhoto = () => {
    setEditForm({ ...editForm, profile_photo_url: "" });
  };

  const handleSaveEdit = async () => {
    // Validate email uniqueness
    const emailExists = teamMembers.some(
      m => m.id !== editingMember.id && m.email.toLowerCase() === editForm.email.toLowerCase()
    );

    if (emailExists) {
      toast.error('This email is already in use by another member');
      return;
    }

    if (!editForm.first_name || !editForm.last_name || !editForm.email) {
      toast.error('First name, last name, and email are required');
      return;
    }

    const newRoleId = editForm.role_id === "none" ? null : editForm.role_id;
    const roleChanged = (newRoleId || null) !== (editingMember.role_id || null);
    const selectedRole = newRoleId ? roles.find(r => r.id === newRoleId) : null;

    // When assigning a role that requires an Effective From date, enforce it.
    let effectiveFrom = editForm.role_effective_from || null;
    if (newRoleId && selectedRole?.requires_effective_from_date) {
      if (!effectiveFrom) {
        toast.error('Please select an Effective From date for this role');
        return;
      }
    } else {
      // Roles that don't require a date should not carry one.
      effectiveFrom = null;
    }

    // Client-side capacity pre-check (per-organisation) when the role changes to
    // a capacity-limited role. The server enforces this too.
    if (roleChanged && newRoleId && selectedRole?.max_members != null) {
      const orgId = editingMember.organization_id || memberInfo?.organization_id;
      if (orgId) {
        try {
          const resp = await fetch(`/api/public/role/${newRoleId}/capacity?orgId=${encodeURIComponent(orgId)}`);
          if (resp.ok) {
            const cap = await resp.json();
            if (cap && cap.hasCapacity === false) {
              toast.error(`The "${selectedRole.name}" role is full (${cap.currentCount ?? selectedRole.max_members}/${cap.maxMembers ?? selectedRole.max_members}) for this organisation.`);
              return;
            }
          }
        } catch (err) {
          // Network error: let the server-side check be the source of truth.
          console.error('Role capacity pre-check failed:', err);
        }
      }
    }

    const data = {
      first_name: editForm.first_name,
      last_name: editForm.last_name,
      job_title: editForm.job_title,
      email: editForm.email,
      profile_photo_url: editForm.profile_photo_url,
      linkedin_url: editForm.linkedin_url
    };

    if (roleChanged || effectiveFrom !== (editingMember.role_effective_from || null)) {
      data.role_id = newRoleId;
      data.role_effective_from = effectiveFrom;
    }

    updateMemberMutation.mutate({
      memberId: editingMember.id,
      data
    });
  };

  const handleSendInvite = () => {
    if (!inviteEmail) {
      toast.error('Please enter an email address');
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      toast.error('Please enter a valid email address');
      return;
    }

    const inviteDomain = inviteEmail.split('@')[1].toLowerCase();

    // Validate domain match against organization's verified domains (from preference_field/organization_preference_value)
    if (!orgVerifiedDomains.includes(inviteDomain)) {
      const domainList = orgVerifiedDomains.map(d => `@${d}`).join(', ');
      toast.error(`Email domain must be one of: ${domainList}`);
      return;
    }

    // Check if member already exists
    const existingMember = teamMembers.find(m => m.email.toLowerCase() === inviteEmail.toLowerCase());
    if (existingMember) {
      toast.error('A team member with this email already exists');
      return;
    }

    const finalBody = inviteBody.replace(/\{\{invitee_email\}\}/gi, inviteEmail);
    sendInviteMutation.mutate({ 
      email: inviteEmail, 
      subject: inviteSubject, 
      body: finalBody 
    });
  };

  // Get organization's verified domains for display (must be before early returns)
  const orgVerifiedDomains = useMemo(() => {
    // Use verified_domains from the organization_preference_value table (fetched via API)
    const apiDomains = orgDomainsData?.verified_domains || [];
    if (apiDomains.length > 0) {
      return apiDomains.map(d => d.toLowerCase());
    }
    // Fallback to user's domain if no org domains configured
    if (memberInfo?.email) {
      return [memberInfo.email.split('@')[1].toLowerCase()];
    }
    return [];
  }, [orgDomainsData, memberInfo]);

  const primaryDomain = orgVerifiedDomains[0] || '';

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
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <Users className="w-8 h-8 text-blue-600" />
                  <div>
                    <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                      Team Directory
                    </h1>
                    <p className="text-slate-600">
                      {organizationInfo?.name && `${organizationInfo.name} - `}
                      {filteredMembers.length} {filteredMembers.length === 1 ? 'member' : 'members'}
                    </p>
                  </div>
                </div>
                {!isFeatureExcluded('element_TeamInviteMember') && (
                  <Button
                    onClick={() => setShowInviteDialog(true)}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    <UserPlus className="w-4 h-4 mr-2" />
                    Invite Member
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Sign Up Link Card - only show if template is configured and user can invite members */}
          {signupLink && !isFeatureExcluded('element_TeamInviteMember') && (
            <Card className="mb-6 border-blue-200 bg-blue-50/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0">
                    <Link className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 mb-1">Team Sign Up Link</p>
                    <p className="text-sm text-slate-600 truncate" title={signupLink}>
                      {signupLink}
                    </p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={handleCopySignupLink}
                        className="flex-shrink-0"
                        data-testid="button-copy-signup-link"
                      >
                        {signupLinkCopied ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{signupLinkCopied ? 'Copied!' : 'Copy link'}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Org Guest Access Card */}
          {tenantGuestAccess?.enabled && !isFeatureExcluded('element_TeamLoginAccessToggle') && (
            <Card className="mb-6 border-slate-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserCheck className="w-5 h-5" />
                  Guest Access
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4 py-2">
                  <div>
                    <Label htmlFor="org_guest_access_enabled" className="text-base font-medium cursor-pointer">
                      Allow guests to join this organisation
                    </Label>
                    <p className="text-sm text-slate-500 mt-0.5">
                      When enabled, anyone signing up via the guest sign-up link can be added
                      to this organisation, even if their email domain isn't on your verified list.
                    </p>
                  </div>
                  <Switch
                    id="org_guest_access_enabled"
                    checked={orgGuestForm.enabled}
                    onCheckedChange={(checked) => persistOrgGuestAccess({ ...orgGuestForm, enabled: checked })}
                    disabled={updateOrgGuestAccessMutation.isPending}
                    data-testid="toggle-org-guest-access-enabled"
                  />
                </div>

                {orgGuestForm.enabled && (
                  <div className="space-y-3 border-t border-slate-100 pt-4">
                    <Label className="text-sm font-medium text-slate-700">
                      Default access period for new guests
                    </Label>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={orgGuestForm.unlimited ? '' : orgGuestForm.period_days}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            setOrgGuestForm(prev => ({
                              ...prev,
                              period_days: Number.isFinite(val) && val > 0 ? val : 1,
                            }));
                          }}
                          onBlur={() => {
                            if (!orgGuestForm.unlimited) {
                              persistOrgGuestAccess(orgGuestForm);
                            }
                          }}
                          disabled={orgGuestForm.unlimited || updateOrgGuestAccessMutation.isPending}
                          className="w-28"
                          data-testid="input-org-guest-default-days"
                        />
                        <span className="text-sm text-slate-600">days</span>
                      </div>
                      <label className="flex items-center gap-2 p-2 rounded-md hover-elevate cursor-pointer">
                        <Checkbox
                          checked={orgGuestForm.unlimited}
                          onCheckedChange={(checked) => {
                            persistOrgGuestAccess({ ...orgGuestForm, unlimited: !!checked });
                          }}
                          disabled={updateOrgGuestAccessMutation.isPending}
                          data-testid="checkbox-org-guest-unlimited"
                        />
                        <span className="text-sm text-slate-700 inline-flex items-center gap-1">
                          <InfinityIcon className="w-4 h-4 text-slate-500" />
                          Unlimited (Permanent)
                        </span>
                      </label>
                    </div>
                    <p className="text-xs text-slate-500">
                      Pre-filled from the tenant default
                      ({tenantGuestAccess?.unlimited
                        ? 'Unlimited'
                        : `${tenantGuestAccess?.default_period_days || 30} days`}).
                      Override it here for this organisation only.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Search and Filter Card */}
          <Card className="mb-6 border-slate-200">
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-4 items-center">
                <div className="flex-1 relative w-full">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search by name, email, or job title..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                    data-testid="input-team-search"
                  />
                </div>
                {rolesInUse.length > 0 && (
                  <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
                    <SelectTrigger className="w-full md:w-[200px]" data-testid="select-role-filter">
                      <Shield className="w-4 h-4 mr-2 text-slate-400 flex-shrink-0" />
                      <SelectValue placeholder="All Roles" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" data-testid="select-role-all">All Roles</SelectItem>
                      {rolesInUse.map(role => (
                        <SelectItem key={role.id} value={role.id} data-testid={`select-role-${role.id}`}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!isFeatureExcluded('membership.team.view-inactive-accounts') && (
                  <div className="flex items-center gap-3">
                    <Label htmlFor="show-disabled" className="text-sm text-slate-700 whitespace-nowrap cursor-pointer">
                      Show inactive accounts
                    </Label>
                    <Switch
                      id="show-disabled"
                      checked={showDisabled}
                      onCheckedChange={setShowDisabled}
                    />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Members Grid */}
          {paginatedMembers.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="p-12 text-center">
                <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No members found</h3>
                <p className="text-slate-600">
                  {searchQuery || showDisabled ? 'Try adjusting your search criteria or filters' : 'No team members available'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginatedMembers.map(member => {
                  const stats = memberStats[member.id] || {};
                  const role = roles.find(r => r.id === member.role_id);
                  const loginEnabled = member.login_enabled ?? true;
                  const guestStatus = getGuestStatus(member);
                  // Guest adjust controls are gated only by the admin
                  // permission (same as login-access management), not by
                  // the tenant's display preference for the login toggle.
                  const canManageGuestAccess = !isFeatureExcluded('element_TeamLoginAccessToggle');

                  const canEditMember = !isFeatureExcluded('element_TeamEditMember');
                  
                  return (
                    <Card 
                      key={member.id} 
                      className={`border-slate-200 transition-shadow ${canEditMember ? 'hover:shadow-lg cursor-pointer' : ''}`}
                      onClick={canEditMember ? () => handleEditClick(member) : undefined}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start gap-3">
                          {/* Profile Picture */}
                          {showProfilePhoto && (
                            <div className="flex-shrink-0">
                              {member.profile_photo_url ? (
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
                          )}

                          {/* Name and Role */}
                          <div className="flex-1 min-w-0">
                            <CardTitle className="text-base mb-1">
                              {member.first_name} {member.last_name}
                            </CardTitle>
                            {(showRoleBadge && role) || guestStatus ? (
                              <div className="flex items-center gap-1 mb-1 flex-wrap">
                                {showRoleBadge && role && (
                                  <RoleBadge
                                    role={role}
                                    data-testid={`badge-role-${member.id}`}
                                  />
                                )}
                                {guestStatus && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-warning/10 text-warning inline-flex items-center gap-1"
                                    data-testid={`badge-guest-${member.id}`}
                                  >
                                    <UserCheck className="w-3 h-3" />
                                    Guest
                                  </Badge>
                                )}
                              </div>
                            ) : null}
                            {showJobTitle && member.job_title && (
                              <p className="text-xs text-slate-600 line-clamp-1">{member.job_title}</p>
                            )}
                          </div>

                          {canEditMember && (
                            <Edit className="w-4 h-4 text-slate-400" data-testid={`icon-edit-member-${member.id}`} />
                          )}
                        </div>
                      </CardHeader>

                      <CardContent className="space-y-3" onClick={(e) => e.stopPropagation()}>
                        {guestStatus && (
                          <GuestAccessControl
                            member={member}
                            canManage={canManageGuestAccess}
                            layout="inline-row"
                          />
                        )}
                        {/* Render content sections in configured order */}
                        {orderedSections.filter(s => !['profile_photo', 'name_role'].includes(s)).map(sectionId => {
                          switch (sectionId) {
                            case 'email':
                              return showEmail ? (
                                <div key="email" className="flex items-start gap-2">
                                  <Mail className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                                  <span className="text-sm text-slate-700 break-all">{member.email}</span>
                                </div>
                              ) : null;
                            case 'last_activity':
                              return showLastActivity && member.last_activity ? (
                                <div key="last_activity" className="flex items-center gap-2">
                                  <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                  <span className="text-xs text-slate-600">
                                    Last active {formatDistanceToNow(new Date(member.last_activity), { addSuffix: true })}
                                  </span>
                                </div>
                              ) : null;
                            case 'login_toggle':
                              return showLoginToggle && !isFeatureExcluded('element_TeamLoginAccessToggle') ? (
                                <div key="login_toggle" className="flex items-center justify-between pt-2 pb-2 border-y border-slate-200">
                                  <span className="text-sm font-medium text-slate-700">Login Access</span>
                                  <div className="flex items-center gap-2">
                                    <span className={`text-xs ${loginEnabled ? 'text-green-600' : 'text-slate-500'}`}>
                                      {loginEnabled ? 'Active' : 'Inactive'}
                                    </span>
                                    <Switch
                                      checked={loginEnabled}
                                      onCheckedChange={(checked) => handleToggleLogin(member, checked)}
                                      disabled={toggleLoginMutation.isPending}
                                    />
                                  </div>
                                </div>
                              ) : null;
                            case 'events_count':
                              return showEventsCount ? (
                                <div key="events_count" className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Calendar className="w-4 h-4 text-green-600" />
                                    <span className="text-sm text-slate-600">Events</span>
                                  </div>
                                  <Badge variant="secondary">{stats.eventsAttended || 0}</Badge>
                                </div>
                              ) : null;
                            case 'articles_count':
                              return showArticlesCount ? (
                                <div key="articles_count" className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-purple-600" />
                                    <span className="text-sm text-slate-600">Articles</span>
                                  </div>
                                  <Badge variant="secondary">{stats.publishedArticles || 0}</Badge>
                                </div>
                              ) : null;
                            case 'awards':
                              return showAwards && stats.totalAwards > 0 ? (
                                <div key="awards" className="pt-3 border-t border-slate-200">
                                  <div className="flex items-center gap-2 mb-3">
                                    <Trophy className="w-4 h-4 text-warning" />
                                    <span className="text-xs font-semibold text-slate-700">
                                      Awards ({stats.totalAwards})
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    {stats.onlineAwards.slice(0, 4).map(award => {
                                      const classification = award.classification_id ? awardClassifications.find(c => c.id === award.classification_id) : null;
                                      return (
                                        <Tooltip key={`online-${award.id}`}>
                                          <TooltipTrigger asChild>
                                            <div className="flex flex-col items-center p-2 bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg border border-warning/30 cursor-help relative">
                                              {classification && (
                                                <Badge variant="secondary" className="absolute -top-1 -right-1 text-[8px] px-1 py-0 scale-75">
                                                  {classification.name}
                                                </Badge>
                                              )}
                                              {award.image_url ? (
                                                <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain mb-1" />
                                              ) : (
                                                <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center mb-1">
                                                  <Trophy className="w-4 h-4 text-white" />
                                                </div>
                                              )}
                                              <span className="text-[10px] font-medium text-slate-900 text-center line-clamp-1">{award.name}</span>
                                            </div>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            <p className="font-semibold">{award.name}</p>
                                            {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                                          </TooltipContent>
                                        </Tooltip>
                                      );
                                    })}
                                    {stats.offlineAwards.slice(0, Math.max(0, 4 - stats.onlineAwards.length)).map((award, idx) => {
                                      const classification = award.classification_id ? awardClassifications.find(c => c.id === award.classification_id) : null;
                                      return (
                                        <Tooltip key={`offline-${award.id}-${idx}`}>
                                          <TooltipTrigger asChild>
                                            <div className="flex flex-col items-center p-2 bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg border border-purple-200 cursor-help relative">
                                              {classification && (
                                                <Badge variant="secondary" className="absolute -top-1 -right-1 text-[8px] px-1 py-0 scale-75">
                                                  {classification.name}
                                                </Badge>
                                              )}
                                              {award.sublevel?.image_url ? (
                                                <img src={award.sublevel.image_url} alt={award.sublevel.name} className="w-8 h-8 object-contain mb-1" />
                                              ) : award.image_url ? (
                                                <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain mb-1" />
                                              ) : (
                                                <div className="w-8 h-8 bg-gradient-to-br from-purple-400 to-purple-600 rounded-full flex items-center justify-center mb-1">
                                                  <Trophy className="w-4 h-4 text-white" />
                                                </div>
                                              )}
                                              <span className="text-[10px] font-medium text-slate-900 text-center line-clamp-1">{award.name}</span>
                                              {award.sublevel && (
                                                <Badge className="mt-0.5 bg-purple-600 text-white text-[8px] px-1 py-0">{award.sublevel.name}</Badge>
                                              )}
                                            </div>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            <p className="font-semibold">{award.name}</p>
                                            {award.sublevel && <p className="text-xs text-purple-400 mt-1">Level: {award.sublevel.name}</p>}
                                            {award.period_text && <p className="text-xs text-slate-400 mt-1">{award.period_text}</p>}
                                            {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                                          </TooltipContent>
                                        </Tooltip>
                                      );
                                    })}
                                    {stats.totalAwards > 4 && (
                                      <div className="flex items-center justify-center p-2 bg-slate-100 rounded-lg border border-slate-200">
                                        <span className="text-xs font-medium text-slate-600">+{stats.totalAwards - 4} more</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ) : null;
                            default:
                              return null;
                          }
                        })}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-6 flex justify-center items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  
                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                      <Button
                        key={page}
                        variant={currentPage === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrentPage(page)}
                        className="w-9"
                      >
                        {page}
                      </Button>
                    ))}
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
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit Member Dialog */}
      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Member</DialogTitle>
            <DialogDescription>
              Update member information. Email must be unique.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Profile Photo */}
            <div className="space-y-2">
              <Label>Profile Photo</Label>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border-2 border-slate-200">
                  {editForm.profile_photo_url ? (
                    <img src={editForm.profile_photo_url} alt="Profile" className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-8 h-8 text-slate-400" />
                  )}
                </div>
                {editForm.profile_photo_url && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleClearPhoto}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Remove Photo
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="first_name">First Name *</Label>
              <Input
                id="first_name"
                value={editForm.first_name}
                onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                placeholder="First name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="last_name">Last Name *</Label>
              <Input
                id="last_name"
                value={editForm.last_name}
                onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                placeholder="Last name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="job_title">Job Title</Label>
              <Input
                id="job_title"
                value={editForm.job_title}
                onChange={(e) => setEditForm({ ...editForm, job_title: e.target.value })}
                placeholder="Job title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                placeholder="email@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkedin_url">LinkedIn URL</Label>
              <Input
                id="linkedin_url"
                type="url"
                value={editForm.linkedin_url}
                onChange={(e) => setEditForm({ ...editForm, linkedin_url: e.target.value })}
                placeholder="https://www.linkedin.com/in/username"
              />
            </div>

            {!isFeatureExcluded('element_TeamEditMember') && (
              <div className="space-y-2">
                <Label htmlFor="role_id">Role</Label>
                <Select
                  value={editForm.role_id}
                  onValueChange={(value) => {
                    const nextRole = value === "none" ? null : roles.find(r => r.id === value);
                    setEditForm({
                      ...editForm,
                      role_id: value,
                      // Clear any stale effective-from when switching to a role
                      // that doesn't require one (or to no role).
                      role_effective_from: nextRole?.requires_effective_from_date ? editForm.role_effective_from : null
                    });
                  }}
                >
                  <SelectTrigger id="role_id" data-testid="select-edit-member-role">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      <span className="text-slate-500">No Role</span>
                    </SelectItem>
                    {roles
                      .filter((role) => !role.is_tenant_admin || role.id === editForm.role_id)
                      .map((role) => (
                      <SelectItem key={role.id} value={role.id} data-testid={`option-role-${role.id}`}>
                        <div className="flex items-center gap-2">
                          <Shield className="w-3 h-3" />
                          {role.name}
                          {role.is_default && (
                            <span className="text-xs text-green-600">(Default)</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {editForm.role_id !== "none" && roles.find(r => r.id === editForm.role_id)?.requires_effective_from_date && (
                  <div className="space-y-1 pt-1">
                    <Label className="text-xs text-slate-600">Effective From Date *</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-start text-left font-normal"
                          data-testid="button-role-effective-from"
                        >
                          <Calendar className="mr-2 h-4 w-4" />
                          {editForm.role_effective_from ? (
                            format(new Date(editForm.role_effective_from), 'dd MMM yyyy')
                          ) : (
                            <span className="text-slate-500">Pick a date</span>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <CalendarPicker
                          mode="single"
                          selected={editForm.role_effective_from ? new Date(editForm.role_effective_from) : undefined}
                          onSelect={(d) => setEditForm({ ...editForm, role_effective_from: d ? format(d, 'yyyy-MM-dd') : null })}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveEdit}
              disabled={updateMemberMutation.isPending}
            >
              {updateMemberMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite Member Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Invite Team Member</DialogTitle>
            <DialogDescription>
              Send an invitation to a new team member. You can customize the email before sending.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite_email">Recipient Email Address *</Label>
              <Input
                id="invite_email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={`user@${primaryDomain}`}
                data-testid="input-invite-email"
              />
              <p className="text-xs text-slate-500">
                {orgVerifiedDomains.length > 1 
                  ? `Allowed domains: ${orgVerifiedDomains.map(d => `@${d}`).join(', ')}`
                  : `Email domain must match: @${primaryDomain}`
                }
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="invite_subject">Email Subject</Label>
              <Input
                id="invite_subject"
                type="text"
                value={inviteSubject}
                onChange={(e) => setInviteSubject(e.target.value)}
                placeholder="Enter email subject"
                data-testid="input-invite-subject"
              />
            </div>

            <div className="space-y-2">
              <Label>Email Body</Label>
              <p className="text-xs text-slate-500 mb-2">
                Available placeholders: {"{{invitee_email}}"}, {"{{inviter_name}}"}, {"{{organization_name}}"}, {"{{invite_link}}"}
              </p>
              <div className="border rounded-md">
                <ReactQuill
                  theme="snow"
                  value={inviteBody}
                  onChange={setInviteBody}
                  className="min-h-[200px]"
                  modules={{
                    toolbar: [
                      [{ 'header': [1, 2, 3, false] }],
                      ['bold', 'italic', 'underline'],
                      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                      ['link'],
                      ['clean']
                    ]
                  }}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSendInvite}
              disabled={sendInviteMutation.isPending || !inviteEmail}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-send-invite"
            >
              {sendInviteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4 mr-2" />
                  Send Invitation
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
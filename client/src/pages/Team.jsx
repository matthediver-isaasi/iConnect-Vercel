import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, User, Mail, FileText, Trophy, Search, Users, Shield, Calendar, Clock, Edit, X, ChevronLeft, ChevronRight, UserPlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { sendTeamMemberInvite } from "@/api/functions";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

export default function TeamPage({ hasBanner }) {
  const { memberInfo, organizationInfo, isFeatureExcluded } = useMemberAccess();

  const [searchQuery, setSearchQuery] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(9);
  const [editingMember, setEditingMember] = useState(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubject, setInviteSubject] = useState("");
  const [inviteBody, setInviteBody] = useState("");
  const [editForm, setEditForm] = useState({ first_name: "", last_name: "", job_title: "", email: "", profile_photo_url: "", linkedin_url: "" });
  const queryClient = useQueryClient();

  const { data: inviteTemplateSetting } = useQuery({
    queryKey: ['team-invite-template-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'team_invite_email_template') || null;
    }
  });

  const inviteTemplateId = useMemo(() => {
    if (inviteTemplateSetting?.setting_value) {
      try {
        const parsed = JSON.parse(inviteTemplateSetting.setting_value);
        return parsed.template_id || null;
      } catch {
        return null;
      }
    }
    return null;
  }, [inviteTemplateSetting]);

  const { data: inviteTemplate } = useQuery({
    queryKey: ['email-template', inviteTemplateId],
    queryFn: async () => {
      if (!inviteTemplateId) return null;
      const templates = await base44.entities.EmailTemplate.list();
      return templates.find(t => t.id === inviteTemplateId) || null;
    },
    enabled: !!inviteTemplateId
  });

  useEffect(() => {
    if (showInviteDialog && inviteTemplate) {
      const inviterName = memberInfo ? `${memberInfo.first_name} ${memberInfo.last_name}` : '';
      const orgName = organizationInfo?.name || '';
      
      let subject = inviteTemplate.subject || 'You have been invited to join our team';
      let body = inviteTemplate.body || '';
      
      subject = subject.replace(/\{\{inviter_name\}\}/gi, inviterName);
      subject = subject.replace(/\{\{organization_name\}\}/gi, orgName);
      
      body = body.replace(/\{\{inviter_name\}\}/gi, inviterName);
      body = body.replace(/\{\{organization_name\}\}/gi, orgName);
      
      setInviteSubject(subject);
      setInviteBody(body);
    } else if (showInviteDialog && !inviteTemplate) {
      const inviterName = memberInfo ? `${memberInfo.first_name} ${memberInfo.last_name}` : '';
      const orgName = organizationInfo?.name || '';
      setInviteSubject(`You're invited to join ${orgName || 'our team'}`);
      setInviteBody(`<p>Hi,</p><p>${inviterName} has invited you to join ${orgName || 'our team'}.</p><p>Click the link below to accept the invitation and set up your account.</p>`);
    }
  }, [showInviteDialog, inviteTemplate, memberInfo, organizationInfo]);

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
    queryFn: async () => {
      if (!memberInfo?.organization_id) return { verified_domains: [] };
      const response = await fetch(`/api/public/organisation/${memberInfo.organization_id}/domains`);
      if (!response.ok) return { verified_domains: [] };
      return response.json();
    },
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
      toast.error('Failed to update member');
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
        emailBody: body
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

  // Filter members based on search and showDisabled toggle
  const filteredMembers = useMemo(() => {
    let filtered = teamMembers;
    
    // Filter by disabled accounts
    if (!showDisabled) {
      filtered = filtered.filter(member => member.login_enabled !== false);
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
  }, [teamMembers, searchQuery, showDisabled]);

  // Pagination
  const totalPages = Math.ceil(filteredMembers.length / itemsPerPage);
  const paginatedMembers = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredMembers.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredMembers, currentPage, itemsPerPage]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, showDisabled]);

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
      linkedin_url: member.linkedin_url || ""
    });
  };

  const handleClearPhoto = () => {
    setEditForm({ ...editForm, profile_photo_url: "" });
  };

  const handleSaveEdit = () => {
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

    updateMemberMutation.mutate({
      memberId: editingMember.id,
      data: {
        first_name: editForm.first_name,
        last_name: editForm.last_name,
        job_title: editForm.job_title,
        email: editForm.email,
        profile_photo_url: editForm.profile_photo_url,
        linkedin_url: editForm.linkedin_url
      }
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
                  />
                </div>
                {!isFeatureExcluded('element_ShowDisabledAccounts') && (
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
                            {showRoleBadge && role && (
                              <div className="flex items-center gap-1 mb-1">
                                <Badge 
                                  variant="secondary" 
                                  className="bg-blue-100 text-blue-700"
                                >
                                  {role.name}
                                </Badge>
                              </div>
                            )}
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
                                    <Trophy className="w-4 h-4 text-amber-600" />
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
                                            <div className="flex flex-col items-center p-2 bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg border border-amber-200 cursor-help relative">
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
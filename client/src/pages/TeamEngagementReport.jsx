import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown, User, Trophy, Calendar, FileText, Briefcase, Users, Clock, UserX } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ENGAGEMENT_TYPES = {
  eventsAttended: { label: "Events Attended", icon: Calendar, color: "text-green-600", bgColor: "bg-green-50" },
  articlesPublished: { label: "Articles Published", icon: FileText, color: "text-purple-600", bgColor: "bg-purple-50" },
  jobsPosted: { label: "Jobs Posted", icon: Briefcase, color: "text-blue-600", bgColor: "bg-blue-50" },
  engagementAwards: { label: "Engagement Awards", icon: Trophy, color: "text-rose-600", bgColor: "bg-rose-50" },
  totalAwards: { label: "Awards", icon: Trophy, color: "text-warning", bgColor: "bg-warning/10" },
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return format(new Date(dateStr), 'dd MMM yyyy');
  } catch {
    return '';
  }
}

export default function TeamEngagementReportPage() {
  const { memberInfo, organizationInfo } = useMemberAccess();

  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState("totalScore");
  const [sortDirection, setSortDirection] = useState("desc");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [detailModal, setDetailModal] = useState(null);

  const { data: teamMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['team-members-report', memberInfo?.organization_id],
    queryFn: async () => {
      if (!memberInfo?.organization_id) return [];
      return base44.entities.Member.filter({ organization_id: memberInfo.organization_id });
    },
    enabled: !!memberInfo?.organization_id
  });

  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles-report'],
    queryFn: () => base44.entities.BlogPost.list()
  });

  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings-report'],
    queryFn: () => base44.entities.Booking.list()
  });

  const { data: allJobPostings = [] } = useQuery({
    queryKey: ['all-job-postings-report'],
    queryFn: () => base44.entities.JobPosting.list()
  });

  const { data: allEvents = [] } = useQuery({
    queryKey: ['all-events-report'],
    queryFn: () => base44.entities.Event.list()
  });

  const { data: awards = [] } = useQuery({
    queryKey: ['awards-report'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active);
    }
  });

  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments-report'],
    queryFn: () => base44.entities.OfflineAwardAssignment.list()
  });

  const { data: engagementAssignments = [] } = useQuery({
    queryKey: ['engagement-assignments-report'],
    queryFn: () => base44.entities.EngagementAwardAssignment.list()
  });

  const { data: offlineAwardDefs = [] } = useQuery({
    queryKey: ['offline-award-defs-report'],
    queryFn: () => base44.entities.OfflineAward.list()
  });

  const { data: engagementAwardDefs = [] } = useQuery({
    queryKey: ['engagement-award-defs-report'],
    queryFn: () => base44.entities.EngagementAward.list()
  });

  const eventsById = useMemo(() => {
    const map = {};
    allEvents.forEach(e => { map[e.id] = e; });
    return map;
  }, [allEvents]);

  const engagementData = useMemo(() => {
    const membersToProcess = includeInactive 
      ? teamMembers 
      : teamMembers.filter(m => m.login_enabled !== false);

    return membersToProcess.map(member => {
      const openingBalances = member.engagement_opening_balances || {};
      const obEvents = openingBalances.eventsAttended || 0;
      const obArticles = openingBalances.articlesPublished || 0;
      const obJobs = openingBalances.jobsPosted || 0;
      const obAwards = openingBalances.awards || 0;
      const obEngagement = openingBalances.engagementAwards || 0;

      const memberBookings = allBookings.filter(
        b => b.member_id === member.id && b.status === 'confirmed'
      );
      const uniqueEventIds = [...new Set(memberBookings.map(b => b.event_id).filter(Boolean))];
      const uniqueEventBookings = uniqueEventIds.map(eventId => {
        const bookingsForEvent = memberBookings.filter(b => b.event_id === eventId);
        return { eventId, tickets: bookingsForEvent.length, booking: bookingsForEvent[0] };
      });
      const memberArticles = allArticles.filter(
        a => a.author_id === member.id && a.status === 'published'
      );
      const memberJobs = allJobPostings.filter(
        j => j.posted_by_member_id === member.id
      );

      const eventsAttended = uniqueEventIds.length + obEvents;
      const articlesPublished = memberArticles.length + obArticles;
      const jobsPosted = memberJobs.length + obJobs;

      const earnedOnlineAwards = awards.filter(award => {
        const stat = award.award_type === 'events_attended' ? eventsAttended :
                     award.award_type === 'articles_published' ? articlesPublished :
                     award.award_type === 'jobs_posted' ? jobsPosted : 0;
        return stat >= award.threshold;
      });

      const memberOfflineAssignments = offlineAssignments.filter(a => a.member_id === member.id);
      const memberEngagementAssignments = engagementAssignments.filter(a => a.member_id === member.id);

      const totalAwards = earnedOnlineAwards.length + memberOfflineAssignments.length + obAwards;
      const engagementAwardsTotal = memberEngagementAssignments.length + obEngagement;
      
      const totalScore = eventsAttended + articlesPublished + jobsPosted + totalAwards + engagementAwardsTotal;

      return {
        id: member.id,
        name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown',
        email: member.email,
        profilePhoto: member.profile_photo_url,
        isActive: member.login_enabled !== false,
        eventsAttended,
        articlesPublished,
        jobsPosted,
        engagementAwards: engagementAwardsTotal,
        totalAwards,
        totalScore,
        lastActivity: member.last_activity ? new Date(member.last_activity).getTime() : 0,
        details: {
          eventsAttended: { items: uniqueEventBookings, openingBalance: obEvents },
          articlesPublished: { items: memberArticles, openingBalance: obArticles },
          jobsPosted: { items: memberJobs, openingBalance: obJobs },
          engagementAwards: { items: memberEngagementAssignments, openingBalance: obEngagement },
          totalAwards: { onlineAwards: earnedOnlineAwards, offlineAwards: memberOfflineAssignments, openingBalance: obAwards },
        }
      };
    });
  }, [teamMembers, allArticles, allBookings, allJobPostings, awards, offlineAssignments, engagementAssignments, includeInactive]);

  const filteredAndSortedData = useMemo(() => {
    let filtered = engagementData;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(m => 
        m.name.toLowerCase().includes(query) || 
        m.email.toLowerCase().includes(query)
      );
    }

    filtered.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      
      if (sortField === 'name') {
        return sortDirection === 'asc' 
          ? aVal.localeCompare(bVal) 
          : bVal.localeCompare(aVal);
      }
      
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return filtered;
  }, [engagementData, searchQuery, sortField, sortDirection]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleBadgeClick = (memberId, type) => {
    setDetailModal({ memberId, type });
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-4 h-4 text-slate-400" />;
    return sortDirection === 'asc' 
      ? <ArrowUp className="w-4 h-4 text-blue-600" />
      : <ArrowDown className="w-4 h-4 text-blue-600" />;
  };

  const selectedMember = detailModal ? engagementData.find(m => m.id === detailModal.memberId) : null;
  const selectedType = detailModal?.type;
  const typeConfig = selectedType ? ENGAGEMENT_TYPES[selectedType] : null;

  const renderDetailItems = () => {
    if (!selectedMember || !selectedType) return null;
    const detail = selectedMember.details[selectedType];
    if (!detail) return null;

    if (selectedType === 'eventsAttended') {
      return (
        <div className="space-y-2">
          {detail.items.map((item, idx) => {
            const event = eventsById[item.eventId];
            const eventName = event?.title || item.booking?.event_name || 'Event';
            const eventDate = event?.start_date || item.booking?.created_date || item.booking?.created_at;
            return (
              <div key={item.eventId || idx} className="flex items-center gap-3 p-3 rounded-lg bg-green-50 dark:bg-green-950/20">
                <Calendar className="w-4 h-4 text-green-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{eventName}</div>
                  <div className="text-xs text-slate-500">
                    {eventDate ? formatDate(eventDate) : ''}
                    {item.tickets > 1 ? `${eventDate ? ' — ' : ''}${item.tickets} tickets` : ''}
                  </div>
                </div>
              </div>
            );
          })}
          {detail.openingBalance > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-300 dark:border-slate-600">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">Opening balance: {detail.openingBalance}</div>
            </div>
          )}
          {detail.items.length === 0 && detail.openingBalance === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">No events attended</div>
          )}
        </div>
      );
    }

    if (selectedType === 'articlesPublished') {
      return (
        <div className="space-y-2">
          {detail.items.map((article, idx) => (
            <div key={article.id || idx} className="flex items-center gap-3 p-3 rounded-lg bg-purple-50 dark:bg-purple-950/20">
              <FileText className="w-4 h-4 text-purple-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{article.title || 'Untitled'}</div>
                {(article.published_date || article.created_date) && (
                  <div className="text-xs text-slate-500">{formatDate(article.published_date || article.created_date)}</div>
                )}
              </div>
            </div>
          ))}
          {detail.openingBalance > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-300 dark:border-slate-600">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">Opening balance: {detail.openingBalance}</div>
            </div>
          )}
          {detail.items.length === 0 && detail.openingBalance === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">No articles published</div>
          )}
        </div>
      );
    }

    if (selectedType === 'jobsPosted') {
      return (
        <div className="space-y-2">
          {detail.items.map((job, idx) => (
            <div key={job.id || idx} className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/20">
              <Briefcase className="w-4 h-4 text-blue-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{job.title || 'Untitled'}</div>
                {(job.created_date || job.created_at) && (
                  <div className="text-xs text-slate-500">{formatDate(job.created_date || job.created_at)}</div>
                )}
              </div>
            </div>
          ))}
          {detail.openingBalance > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-300 dark:border-slate-600">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">Opening balance: {detail.openingBalance}</div>
            </div>
          )}
          {detail.items.length === 0 && detail.openingBalance === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">No jobs posted</div>
          )}
        </div>
      );
    }

    if (selectedType === 'engagementAwards') {
      return (
        <div className="space-y-2">
          {detail.items.map((assignment, idx) => {
            const award = engagementAwardDefs.find(a => a.id === assignment.engagement_award_id);
            return (
              <div key={assignment.id || idx} className="flex items-center gap-3 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20">
                <Trophy className="w-4 h-4 text-rose-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{award?.name || 'Engagement Award'}</div>
                  {assignment.assigned_date && <div className="text-xs text-slate-500">{formatDate(assignment.assigned_date)}</div>}
                </div>
              </div>
            );
          })}
          {detail.openingBalance > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-300 dark:border-slate-600">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">Opening balance: {detail.openingBalance}</div>
            </div>
          )}
          {detail.items.length === 0 && detail.openingBalance === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">No engagement awards</div>
          )}
        </div>
      );
    }

    if (selectedType === 'totalAwards') {
      return (
        <div className="space-y-2">
          {detail.onlineAwards.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Online Awards (threshold met)</div>
              {detail.onlineAwards.map((award, idx) => (
                <div key={award.id || idx} className="flex items-center gap-3 p-3 rounded-lg bg-warning/10 dark:bg-warning/20 mb-2">
                  <Trophy className="w-4 h-4 text-warning shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{award.name || 'Award'}</div>
                    <div className="text-xs text-slate-500">
                      Earned automatically — {award.award_type === 'events_attended' ? 'Events attended' :
                       award.award_type === 'articles_published' ? 'Articles published' :
                       award.award_type === 'jobs_posted' ? 'Jobs posted' : award.award_type} reached {award.threshold}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {detail.offlineAwards.length > 0 && (
            <div className="mb-3">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Offline Awards (assigned)</div>
              {detail.offlineAwards.map((assignment, idx) => {
                const award = offlineAwardDefs.find(a => a.id === assignment.offline_award_id);
                return (
                  <div key={assignment.id || idx} className="flex items-center gap-3 p-3 rounded-lg bg-warning/10 dark:bg-warning/20 mb-2">
                    <Trophy className="w-4 h-4 text-warning shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{award?.name || 'Offline Award'}</div>
                      {assignment.assigned_date && <div className="text-xs text-slate-500">{formatDate(assignment.assigned_date)}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {detail.openingBalance > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-300 dark:border-slate-600">
              <Clock className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">Opening balance: {detail.openingBalance}</div>
            </div>
          )}
          {detail.onlineAwards.length === 0 && detail.offlineAwards.length === 0 && detail.openingBalance === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">No awards earned</div>
          )}
        </div>
      );
    }

    return null;
  };

  const isLoading = membersLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-blue-600" />
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                Team Engagement Report
              </h1>
              <p className="text-slate-600">
                {organizationInfo?.name && `${organizationInfo.name} - `}
                {filteredAndSortedData.length} {filteredAndSortedData.length === 1 ? 'member' : 'members'}
              </p>
            </div>
          </div>
        </div>

        <Card className="mb-6 border-slate-200">
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by name or email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-members"
                />
              </div>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg border border-slate-200">
                <Switch
                  id="include-inactive"
                  checked={includeInactive}
                  onCheckedChange={setIncludeInactive}
                  data-testid="switch-include-inactive"
                />
                <Label htmlFor="include-inactive" className="text-sm text-slate-600 cursor-pointer flex items-center gap-2">
                  <UserX className="w-4 h-4" />
                  Include inactive members
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {filteredAndSortedData.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No members found</h3>
              <p className="text-slate-600">Try adjusting your search criteria</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-slate-200">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th 
                        className="text-left p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('name')}
                      >
                        <div className="flex items-center gap-2">
                          Member
                          <SortIcon field="name" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('eventsAttended')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <Calendar className="w-4 h-4 text-green-600" />
                          Events
                          <SortIcon field="eventsAttended" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('articlesPublished')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <FileText className="w-4 h-4 text-purple-600" />
                          Articles
                          <SortIcon field="articlesPublished" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('jobsPosted')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <Briefcase className="w-4 h-4 text-blue-600" />
                          Jobs
                          <SortIcon field="jobsPosted" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('engagementAwards')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <Trophy className="w-4 h-4 text-rose-600" />
                          Engagement
                          <SortIcon field="engagementAwards" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('totalAwards')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <Trophy className="w-4 h-4 text-warning" />
                          Awards
                          <SortIcon field="totalAwards" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('totalScore')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          Total Score
                          <SortIcon field="totalScore" />
                        </div>
                      </th>
                      <th 
                        className="text-center p-4 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-100"
                        onClick={() => handleSort('lastActivity')}
                      >
                        <div className="flex items-center justify-center gap-2">
                          <Clock className="w-4 h-4 text-slate-600" />
                          Last Active
                          <SortIcon field="lastActivity" />
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredAndSortedData.map((member) => (
                      <tr key={member.id} className="hover:bg-slate-50">
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              {member.profilePhoto ? (
                                <img 
                                  src={member.profilePhoto} 
                                  alt={member.name}
                                  className={`w-10 h-10 rounded-full object-cover border ${member.isActive ? 'border-slate-200' : 'border-slate-300 opacity-60'}`}
                                />
                              ) : (
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${member.isActive ? 'bg-slate-200' : 'bg-slate-300 opacity-60'}`}>
                                  <User className="w-5 h-5 text-slate-400" />
                                </div>
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`font-medium ${member.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{member.name}</span>
                                {!member.isActive && (
                                  <Badge variant="secondary" className="bg-slate-200 text-slate-600 text-xs">
                                    Inactive
                                  </Badge>
                                )}
                              </div>
                              <div className="text-xs text-slate-500">{member.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="p-4 text-center">
                          <Badge
                            variant="secondary"
                            className="bg-green-100 text-green-700 cursor-pointer"
                            onClick={() => handleBadgeClick(member.id, 'eventsAttended')}
                            data-testid={`badge-events-${member.id}`}
                          >
                            {member.eventsAttended}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge
                            variant="secondary"
                            className="bg-purple-100 text-purple-700 cursor-pointer"
                            onClick={() => handleBadgeClick(member.id, 'articlesPublished')}
                            data-testid={`badge-articles-${member.id}`}
                          >
                            {member.articlesPublished}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge
                            variant="secondary"
                            className="bg-blue-100 text-blue-700 cursor-pointer"
                            onClick={() => handleBadgeClick(member.id, 'jobsPosted')}
                            data-testid={`badge-jobs-${member.id}`}
                          >
                            {member.jobsPosted}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge
                            variant="secondary"
                            className="bg-rose-100 text-rose-700 cursor-pointer"
                            onClick={() => handleBadgeClick(member.id, 'engagementAwards')}
                            data-testid={`badge-engagement-${member.id}`}
                          >
                            {member.engagementAwards}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge
                            variant="secondary"
                            className="bg-warning/10 text-warning cursor-pointer"
                            onClick={() => handleBadgeClick(member.id, 'totalAwards')}
                            data-testid={`badge-awards-${member.id}`}
                          >
                            {member.totalAwards}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge className="bg-slate-900 text-white">
                            {member.totalScore}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          {member.lastActivity ? (
                            <span className="text-sm text-slate-600">
                              {formatDistanceToNow(new Date(member.lastActivity), { addSuffix: true })}
                            </span>
                          ) : (
                            <span className="text-sm text-slate-400">Never</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!detailModal} onOpenChange={(open) => !open && setDetailModal(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="dialog-engagement-detail">
          <DialogHeader>
            {typeConfig && (
              <div className="flex items-center gap-2">
                <typeConfig.icon className={`w-5 h-5 ${typeConfig.color}`} />
                <DialogTitle className="text-lg">
                  {selectedMember?.name} — {typeConfig.label}
                </DialogTitle>
              </div>
            )}
            {selectedMember && selectedType && (
              <div className="text-sm text-slate-500 mt-1">
                Total: {selectedMember[selectedType]}
              </div>
            )}
          </DialogHeader>
          <div className="overflow-y-auto flex-1 pr-1">
            {renderDetailItems()}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

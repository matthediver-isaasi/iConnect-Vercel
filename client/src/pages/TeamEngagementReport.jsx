import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown, User, Trophy, Calendar, FileText, Briefcase, Users, Clock, UserX } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function TeamEngagementReportPage() {
  const { memberInfo, organizationInfo } = useMemberAccess();

  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState("totalScore");
  const [sortDirection, setSortDirection] = useState("desc");
  const [includeInactive, setIncludeInactive] = useState(false);

  // Fetch members from the same organization directly via server-side filter
  const { data: teamMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['team-members-report', memberInfo?.organization_id],
    queryFn: async () => {
      if (!memberInfo?.organization_id) return [];
      // Use server-side filter to only fetch members from this organization
      return base44.entities.Member.filter({ organization_id: memberInfo.organization_id });
    },
    enabled: !!memberInfo?.organization_id
  });

  // Fetch all articles
  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles-report'],
    queryFn: () => base44.entities.BlogPost.list()
  });

  // Fetch all bookings
  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings-report'],
    queryFn: () => base44.entities.Booking.list()
  });

  // Fetch all job postings
  const { data: allJobPostings = [] } = useQuery({
    queryKey: ['all-job-postings-report'],
    queryFn: () => base44.entities.JobPosting.list()
  });

  // Fetch online awards
  const { data: awards = [] } = useQuery({
    queryKey: ['awards-report'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active);
    }
  });

  // Fetch offline award assignments
  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments-report'],
    queryFn: () => base44.entities.OfflineAwardAssignment.list()
  });

  // Fetch engagement award assignments
  const { data: engagementAssignments = [] } = useQuery({
    queryKey: ['engagement-assignments-report'],
    queryFn: () => base44.entities.EngagementAwardAssignment.list()
  });

  // Calculate engagement data for all members
  const engagementData = useMemo(() => {
    // Filter based on includeInactive toggle
    const membersToProcess = includeInactive 
      ? teamMembers 
      : teamMembers.filter(m => m.login_enabled !== false);

    return membersToProcess.map(member => {
      // Get opening balances from member record
      const openingBalances = member.engagement_opening_balances || {};
      const obEvents = openingBalances.eventsAttended || 0;
      const obArticles = openingBalances.articlesPublished || 0;
      const obJobs = openingBalances.jobsPosted || 0;
      const obAwards = openingBalances.awards || 0;
      const obEngagement = openingBalances.engagementAwards || 0;

      // Calculate current activity metrics
      const currentEventsAttended = allBookings.filter(
        b => b.member_id === member.id && b.status === 'confirmed'
      ).length;

      const currentArticlesPublished = allArticles.filter(
        a => a.author_id === member.id && a.status === 'published'
      ).length;

      const currentJobsPosted = allJobPostings.filter(
        j => j.posted_by_member_id === member.id
      ).length;

      // Add opening balances to get total metrics
      const eventsAttended = currentEventsAttended + obEvents;
      const articlesPublished = currentArticlesPublished + obArticles;
      const jobsPosted = currentJobsPosted + obJobs;

      // Calculate online awards (based on total metrics including opening balances)
      const earnedOnlineAwards = awards.filter(award => {
        const stat = award.award_type === 'events_attended' ? eventsAttended :
                     award.award_type === 'articles_published' ? articlesPublished :
                     award.award_type === 'jobs_posted' ? jobsPosted : 0;
        return stat >= award.threshold;
      }).length;

      // Calculate offline awards
      const earnedOfflineAwards = offlineAssignments.filter(a => a.member_id === member.id).length;

      // Calculate engagement awards
      const earnedEngagementAwards = engagementAssignments.filter(a => a.member_id === member.id).length;

      // Add opening balances to awards
      const totalAwards = earnedOnlineAwards + earnedOfflineAwards + obAwards;
      const engagementAwardsTotal = earnedEngagementAwards + obEngagement;
      
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
        lastActivity: member.last_activity ? new Date(member.last_activity).getTime() : 0
      };
    });
  }, [teamMembers, allArticles, allBookings, allJobPostings, awards, offlineAssignments, engagementAssignments, includeInactive]);

  // Filter and sort
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

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ArrowUpDown className="w-4 h-4 text-slate-400" />;
    return sortDirection === 'asc' 
      ? <ArrowUp className="w-4 h-4 text-blue-600" />
      : <ArrowDown className="w-4 h-4 text-blue-600" />;
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
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

        {/* Search and Filters */}
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

        {/* Table */}
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
                          <Trophy className="w-4 h-4 text-amber-600" />
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
                          <Badge variant="secondary" className="bg-green-100 text-green-700">
                            {member.eventsAttended}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge variant="secondary" className="bg-purple-100 text-purple-700">
                            {member.articlesPublished}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                            {member.jobsPosted}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge variant="secondary" className="bg-rose-100 text-rose-700">
                            {member.engagementAwards}
                          </Badge>
                        </td>
                        <td className="p-4 text-center">
                          <Badge variant="secondary" className="bg-amber-100 text-amber-700">
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
    </div>
  );
}
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Search, Download, Building2, Users, Activity,
  ChevronLeft, ChevronRight, Trophy, TrendingUp,
  TrendingDown, Minus, ChevronDown, ChevronUp, User
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatDistanceToNow } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function OrganisationEngagementReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedOrg, setExpandedOrg] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_OrganisationEngagementReport')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['engagement-report', weekOffset],
    queryFn: async () => {
      const url = `/api/reports/engagement-report?weekOffset=${weekOffset}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch report data');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const organizations = reportData?.organizations || [];
  const summary = reportData?.summary || {};
  const week = reportData?.week || {};

  const filteredOrgs = useMemo(() => {
    if (!searchQuery) return organizations;
    const q = searchQuery.toLowerCase();
    return organizations.filter(org =>
      org.organizationName.toLowerCase().includes(q) ||
      org.members.some(m =>
        m.name.toLowerCase().includes(q) ||
        (m.email || '').toLowerCase().includes(q)
      )
    );
  }, [organizations, searchQuery]);

  const handleExportCSV = () => {
    if (filteredOrgs.length === 0) return;

    const headers = [
      'Rank',
      'Organisation',
      'Total Members',
      'Active Members (This Week)',
      'Engagement Rate %',
      'Trend',
      'Trend Change',
      'Member Name',
      'Member Email',
      'Last Activity',
      'Active This Week'
    ];

    const rows = [];
    for (const org of filteredOrgs) {
      for (let i = 0; i < org.members.length; i++) {
        const m = org.members[i];
        const isFirst = i === 0;
        rows.push([
          isFirst ? org.rank : '',
          isFirst ? org.organizationName : '',
          isFirst ? org.totalMembers : '',
          isFirst ? org.activeMembers : '',
          isFirst ? org.engagementRate : '',
          isFirst ? org.trend : '',
          isFirst ? (org.trendDiff > 0 ? `+${org.trendDiff}` : org.trendDiff) : '',
          m.name,
          m.email || '',
          m.lastActivity ? format(parseISO(m.lastActivity), 'yyyy-MM-dd HH:mm') : 'Never',
          m.isActiveThisWeek ? 'Yes' : 'No'
        ]);
      }
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `engagement_report_${week.start || 'unknown'}_${week.end || 'unknown'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const toggleExpand = (orgId) => {
    setExpandedOrg(expandedOrg === orgId ? null : orgId);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="loading-access">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Organisation Engagement Report</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Weekly activity rankings based on member engagement
          </p>
        </div>
        {filteredOrgs.length > 0 && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExportCSV}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWeekOffset(w => w + 1)}
              data-testid="button-prev-week"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Previous Week
            </Button>
            <div className="text-center">
              <p className="text-sm font-medium" data-testid="text-week-label">{week.label || 'Loading...'}</p>
              {weekOffset === 0 && (
                <p className="text-xs text-muted-foreground">Current week</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={weekOffset <= 0}
              onClick={() => setWeekOffset(w => Math.max(0, w - 1))}
              data-testid="button-next-week"
            >
              Next Week
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center h-32" data-testid="loading-data">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Active Organisations</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-active-orgs">{summary.totalOrgsWithActivity || 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">of {summary.totalOrganizations || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Active Members</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-active-members">{summary.totalActiveMembers || 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">of {summary.totalMembers || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Engagement Rate</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-engagement-rate">{summary.overallEngagementRate || 0}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Trophy className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Top Organisation</span>
                </div>
                <p className="text-sm font-bold truncate" data-testid="text-top-org" title={summary.topOrganization || 'None'}>
                  {summary.topOrganization || 'No activity'}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-4">
              <CardTitle className="text-base">
                Organisation Rankings
                {filteredOrgs.length > 0 && (
                  <span className="text-muted-foreground font-normal text-sm ml-2">
                    ({filteredOrgs.length} organisation{filteredOrgs.length !== 1 ? 's' : ''})
                  </span>
                )}
              </CardTitle>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search organisations or members..."
                  className="pl-8 w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="input-search"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filteredOrgs.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground" data-testid="text-no-data">
                  {searchQuery ? 'No organisations match your search' : 'No engagement data for this week'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredOrgs.map((org) => {
                    const isExpanded = expandedOrg === org.organizationId;
                    const activeThisWeek = org.members.filter(m => m.isActiveThisWeek);

                    return (
                      <div key={org.organizationId} className="border rounded-md" data-testid={`card-org-${org.organizationId}`}>
                        <button
                          className="w-full text-left px-4 py-3 flex items-center gap-3 hover-elevate"
                          onClick={() => toggleExpand(org.organizationId)}
                          data-testid={`button-expand-${org.organizationId}`}
                        >
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted text-sm font-bold shrink-0">
                            {org.rank}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium truncate">{org.organizationName}</span>
                              {org.rank === 1 && org.activeMembers > 0 && (
                                <Badge variant="default" className="text-[10px] px-1.5 py-0">Top</Badge>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-4 shrink-0">
                            <div className="text-center hidden sm:block">
                              <p className="text-xs text-muted-foreground">Members</p>
                              <p className="text-sm font-medium">{org.activeMembers}/{org.totalMembers}</p>
                            </div>

                            <div className="text-center hidden md:block">
                              <p className="text-xs text-muted-foreground">Rate</p>
                              <p className="text-sm font-medium">{org.engagementRate}%</p>
                            </div>

                            <div className="text-center hidden md:block w-16">
                              <p className="text-xs text-muted-foreground">Trend</p>
                              <div className="flex items-center justify-center gap-1">
                                {org.trend === 'up' && (
                                  <>
                                    <TrendingUp className="w-3.5 h-3.5 text-green-600" />
                                    <span className="text-xs text-green-600">+{org.trendDiff}</span>
                                  </>
                                )}
                                {org.trend === 'down' && (
                                  <>
                                    <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                                    <span className="text-xs text-red-500">{org.trendDiff}</span>
                                  </>
                                )}
                                {org.trend === 'stable' && (
                                  <Minus className="w-3.5 h-3.5 text-muted-foreground" />
                                )}
                              </div>
                            </div>

                            {isExpanded
                              ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                              : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            }
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="border-t px-4 py-3">
                            <div className="flex items-center gap-3 mb-3 sm:hidden">
                              <span className="text-xs text-muted-foreground">Active: {org.activeMembers}/{org.totalMembers}</span>
                              <span className="text-xs text-muted-foreground">Rate: {org.engagementRate}%</span>
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                Trend:
                                {org.trend === 'up' && <TrendingUp className="w-3 h-3 text-green-600" />}
                                {org.trend === 'down' && <TrendingDown className="w-3 h-3 text-red-500" />}
                                {org.trend === 'stable' && <Minus className="w-3 h-3" />}
                              </span>
                            </div>

                            {activeThisWeek.length > 0 && (
                              <div className="mb-3">
                                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Active this week ({activeThisWeek.length})</p>
                                <div className="space-y-1.5">
                                  {activeThisWeek.map(m => (
                                    <div key={m.id} className="flex items-center gap-3 py-1.5" data-testid={`row-member-${m.id}`}>
                                      <Avatar className="w-7 h-7">
                                        <AvatarImage src={m.profilePhoto} alt={m.name} />
                                        <AvatarFallback className="text-[10px]">
                                          {m.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                                        </AvatarFallback>
                                      </Avatar>
                                      <div className="flex-1 min-w-0">
                                        <span className="text-sm font-medium">{m.name}</span>
                                        <span className="text-xs text-muted-foreground ml-2 hidden sm:inline">{m.email}</span>
                                      </div>
                                      <span className="text-xs text-muted-foreground shrink-0">
                                        {m.lastActivity ? formatDistanceToNow(parseISO(m.lastActivity), { addSuffix: true }) : 'Unknown'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {org.members.filter(m => !m.isActiveThisWeek).length > 0 && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                                  Inactive this week ({org.members.filter(m => !m.isActiveThisWeek).length})
                                </p>
                                <div className="space-y-1.5">
                                  {org.members.filter(m => !m.isActiveThisWeek).map(m => (
                                    <div key={m.id} className="flex items-center gap-3 py-1.5 opacity-60" data-testid={`row-member-inactive-${m.id}`}>
                                      <Avatar className="w-7 h-7">
                                        <AvatarImage src={m.profilePhoto} alt={m.name} />
                                        <AvatarFallback className="text-[10px]">
                                          {m.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                                        </AvatarFallback>
                                      </Avatar>
                                      <div className="flex-1 min-w-0">
                                        <span className="text-sm">{m.name}</span>
                                        <span className="text-xs text-muted-foreground ml-2 hidden sm:inline">{m.email}</span>
                                      </div>
                                      <span className="text-xs text-muted-foreground shrink-0">
                                        {m.lastActivity ? formatDistanceToNow(parseISO(m.lastActivity), { addSuffix: true }) : 'Never'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Download, Building2, Users, Activity,
  ChevronLeft, ChevronRight, Trophy, TrendingUp,
  TrendingDown, Minus, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  format, parseISO, formatDistanceToNow,
  startOfWeek, endOfWeek, addWeeks,
  startOfMonth, endOfMonth, addMonths,
  startOfQuarter, endOfQuarter, addQuarters,
  startOfYear,
} from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const PRESET_OPTIONS = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'ytd', label: 'This Year-to-date' },
  { value: 'custom', label: 'Custom date range' },
];

const PRESET_NOUN = {
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  ytd: 'year-to-date',
  custom: 'range',
};

function fmtIso(d) {
  return format(d, 'yyyy-MM-dd');
}

function getCurrentRangeForPreset(preset) {
  const now = new Date();
  switch (preset) {
    case 'month':
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case 'quarter':
      return { start: startOfQuarter(now), end: endOfQuarter(now) };
    case 'ytd':
      return { start: startOfYear(now), end: now };
    case 'week':
    default:
      return {
        start: startOfWeek(now, { weekStartsOn: 1 }),
        end: endOfWeek(now, { weekStartsOn: 1 }),
      };
  }
}

function shiftRange(preset, currentStart, direction) {
  switch (preset) {
    case 'month': {
      const next = addMonths(currentStart, direction);
      return { start: startOfMonth(next), end: endOfMonth(next) };
    }
    case 'quarter': {
      const next = addQuarters(currentStart, direction);
      return { start: startOfQuarter(next), end: endOfQuarter(next) };
    }
    case 'week':
    default: {
      const next = addWeeks(currentStart, direction);
      return {
        start: startOfWeek(next, { weekStartsOn: 1 }),
        end: endOfWeek(next, { weekStartsOn: 1 }),
      };
    }
  }
}

export default function OrganisationEngagementReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [preset, setPreset] = useState('week');
  const initialWeek = getCurrentRangeForPreset('week');
  const [rangeStart, setRangeStart] = useState(initialWeek.start);
  const [rangeEnd, setRangeEnd] = useState(initialWeek.end);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
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

  const supportsArrows = preset === 'week' || preset === 'month' || preset === 'quarter';

  const isCurrentPeriod = useMemo(() => {
    if (preset === 'custom') return false;
    const current = getCurrentRangeForPreset(preset);
    return fmtIso(rangeStart) === fmtIso(current.start) && fmtIso(rangeEnd) === fmtIso(current.end);
  }, [preset, rangeStart, rangeEnd]);

  const queryEnabled = preset !== 'custom' || (!!customStart && !!customEnd && customStart <= customEnd);

  const queryStart = preset === 'custom' ? customStart : fmtIso(rangeStart);
  const queryEnd = preset === 'custom' ? customEnd : fmtIso(rangeEnd);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['engagement-report', queryStart, queryEnd],
    queryFn: async () => {
      const url = `/api/reports/engagement-report?startDate=${encodeURIComponent(queryStart)}&endDate=${encodeURIComponent(queryEnd)}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch report data');
      }
      return response.json();
    },
    enabled: queryEnabled && accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const organizations = reportData?.organizations || [];
  const summary = reportData?.summary || {};
  const period = reportData?.period || reportData?.week || {};

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

  const handlePresetChange = (value) => {
    setPreset(value);
    setExpandedOrg(null);
    if (value === 'custom') {
      const fallbackStart = customStart || fmtIso(rangeStart);
      const fallbackEnd = customEnd || fmtIso(rangeEnd);
      setCustomStart(fallbackStart);
      setCustomEnd(fallbackEnd);
    } else {
      const next = getCurrentRangeForPreset(value);
      setRangeStart(next.start);
      setRangeEnd(next.end);
    }
  };

  const handleStep = (direction) => {
    if (!supportsArrows) return;
    const next = shiftRange(preset, rangeStart, direction);
    setRangeStart(next.start);
    setRangeEnd(next.end);
  };

  const canStepNext = useMemo(() => {
    if (!supportsArrows) return false;
    const current = getCurrentRangeForPreset(preset);
    return rangeStart < current.start;
  }, [supportsArrows, preset, rangeStart]);

  const handleExportCSV = () => {
    if (filteredOrgs.length === 0) return;

    const headers = [
      'Rank',
      'Organisation',
      'Total Members',
      'Active Members (Selected Period)',
      'Engagement Rate %',
      'Trend',
      'Trend Change',
      'Member Name',
      'Member Email',
      'Last Activity',
      'Active In Period'
    ];

    const rows = [];
    for (const org of filteredOrgs) {
      for (let i = 0; i < org.members.length; i++) {
        const m = org.members[i];
        const isFirst = i === 0;
        const isActiveInPeriod = m.isActiveThisPeriod ?? m.isActiveThisWeek;
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
          isActiveInPeriod ? 'Yes' : 'No'
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
    link.download = `engagement_report_${period.start || 'unknown'}_${period.end || 'unknown'}.csv`;
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

  const presetLabel = PRESET_OPTIONS.find(p => p.value === preset)?.label || '';
  const periodNoun = PRESET_NOUN[preset] || 'period';
  const stepNoun = preset === 'month' ? 'Month' : preset === 'quarter' ? 'Quarter' : 'Week';

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Organisation Engagement Report</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Activity rankings based on member engagement
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
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={preset} onValueChange={handlePresetChange}>
                  <SelectTrigger className="w-[200px]" data-testid="select-date-preset">
                    <SelectValue placeholder="Select range" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESET_OPTIONS.map(opt => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        data-testid={`option-preset-${opt.value}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {preset === 'custom' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Input
                      type="date"
                      value={customStart}
                      max={customEnd || undefined}
                      onChange={(e) => setCustomStart(e.target.value)}
                      className="w-[160px]"
                      data-testid="input-custom-start"
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input
                      type="date"
                      value={customEnd}
                      min={customStart || undefined}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      className="w-[160px]"
                      data-testid="input-custom-end"
                    />
                  </div>
                )}
              </div>

              {supportsArrows && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleStep(-1)}
                    data-testid="button-prev-period"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous {stepNoun}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canStepNext}
                    onClick={() => handleStep(1)}
                    data-testid="button-next-period"
                  >
                    Next {stepNoun}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-center gap-2 flex-wrap text-center">
              <p className="text-sm font-medium" data-testid="text-period-label">
                {queryEnabled
                  ? (period.label || 'Loading...')
                  : 'Pick a start and end date'}
              </p>
              {isCurrentPeriod && queryEnabled && (
                <Badge variant="secondary" data-testid="badge-current-period">
                  Current {periodNoun}
                </Badge>
              )}
              {!isCurrentPeriod && queryEnabled && preset !== 'custom' && (
                <span className="text-xs text-muted-foreground">{presetLabel}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center h-32" data-testid="loading-data">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && queryEnabled && (
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
                  {searchQuery ? 'No organisations match your search' : 'No engagement data for the selected period'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredOrgs.map((org) => {
                    const isExpanded = expandedOrg === org.organizationId;
                    const activeInPeriod = org.members.filter(m => m.isActiveThisPeriod ?? m.isActiveThisWeek);
                    const inactiveInPeriod = org.members.filter(m => !(m.isActiveThisPeriod ?? m.isActiveThisWeek));

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

                            {activeInPeriod.length > 0 && (
                              <div className="mb-3">
                                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Active in this period ({activeInPeriod.length})</p>
                                <div className="space-y-1.5">
                                  {activeInPeriod.map(m => (
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

                            {inactiveInPeriod.length > 0 && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                                  Inactive in this period ({inactiveInPeriod.length})
                                </p>
                                <div className="space-y-1.5">
                                  {inactiveInPeriod.map(m => (
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

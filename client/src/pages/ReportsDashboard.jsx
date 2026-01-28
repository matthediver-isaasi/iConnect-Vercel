import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Users,
  GripVertical,
  Settings2,
  TrendingUp,
  TrendingDown,
  BarChart3,
  RefreshCw,
  Loader2,
  Eye,
  EyeOff,
  LayoutDashboard,
  Activity,
  FileText,
  BookOpen,
  Building2
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from "recharts";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const STORAGE_KEY_PREFIX = 'reports_dashboard_';

const DEFAULT_REPORT_CARDS = [
  { id: 'members', title: 'Members', visible: true, order: 0 },
  { id: 'activity', title: 'Activity', visible: true, order: 1 },
  { id: 'article-views', title: 'Article Views', visible: true, order: 2 },
  { id: 'org-types', title: 'Organization Types', visible: true, order: 3 },
  { id: 'new-orgs', title: 'New Organizations', visible: true, order: 4 },
  { id: 'members-by-org-type', title: 'Members by Org Type', visible: true, order: 5 }
];

const ORG_TYPE_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--primary))'
];

const PERIOD_OPTIONS = [
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' }
];

const DEMO_MEMBERS_DATA = {
  totalMembers: 1247,
  activeMembers: 892,
  periodStats: {
    week: { current: 23, previous: 18, change: 28, changeDirection: 'up', isAllTime: false },
    month: { current: 87, previous: 72, change: 21, changeDirection: 'up', isAllTime: false },
    quarter: { current: 234, previous: 198, change: 18, changeDirection: 'up', isAllTime: false },
    year: { current: 567, previous: 423, change: 34, changeDirection: 'up', isAllTime: false },
    all: { current: 1247, previous: null, change: null, changeDirection: null, isAllTime: true }
  },
  acquisitionByPeriod: {
    week: [
      { label: 'Mon', count: 3 }, { label: 'Tue', count: 5 }, { label: 'Wed', count: 4 },
      { label: 'Thu', count: 6 }, { label: 'Fri', count: 3 }, { label: 'Sat', count: 1 }, { label: 'Sun', count: 1 }
    ],
    month: [
      { label: 'Week 1', count: 18 }, { label: 'Week 2', count: 24 },
      { label: 'Week 3', count: 21 }, { label: 'Week 4', count: 24 }
    ],
    quarter: [
      { label: 'Jan', count: 67 }, { label: 'Feb', count: 78 }, { label: 'Mar', count: 89 }
    ],
    year: [
      { label: 'Q1', count: 134 }, { label: 'Q2', count: 156 },
      { label: 'Q3', count: 142 }, { label: 'Q4', count: 135 }
    ],
    all: [
      { label: '2021', count: 234 }, { label: '2022', count: 312 },
      { label: '2023', count: 389 }, { label: '2024', count: 312 }
    ]
  }
};

const DEMO_ACTIVITY_DATA = {
  totalLogins: 4523,
  uniqueUsers: 847,
  averageSessionMinutes: 12,
  todayLogins: 156,
  periodStats: {
    week: { current: 892, previous: 756, change: 18, changeDirection: 'up', isAllTime: false },
    month: { current: 3456, previous: 2987, change: 16, changeDirection: 'up', isAllTime: false },
    quarter: { current: 9234, previous: 8456, change: 9, changeDirection: 'up', isAllTime: false },
    year: { current: 34567, previous: 28934, change: 19, changeDirection: 'up', isAllTime: false },
    all: { current: 78234, previous: null, change: null, changeDirection: null, isAllTime: true }
  },
  activityByPeriod: {
    week: [
      { label: 'Mon', count: 134 }, { label: 'Tue', count: 156 }, { label: 'Wed', count: 178 },
      { label: 'Thu', count: 145 }, { label: 'Fri', count: 123 }, { label: 'Sat', count: 78 }, { label: 'Sun', count: 78 }
    ],
    month: [
      { label: 'Week 1', count: 789 }, { label: 'Week 2', count: 892 },
      { label: 'Week 3', count: 867 }, { label: 'Week 4', count: 908 }
    ],
    quarter: [
      { label: 'Jan', count: 2890 }, { label: 'Feb', count: 3123 }, { label: 'Mar', count: 3221 }
    ],
    year: [
      { label: 'Q1', count: 8234 }, { label: 'Q2', count: 9123 },
      { label: 'Q3', count: 8567 }, { label: 'Q4', count: 8643 }
    ],
    all: [
      { label: '2021', count: 18234 }, { label: '2022', count: 23456 },
      { label: '2023', count: 28934 }, { label: '2024', count: 7610 }
    ]
  }
};

const DEMO_ARTICLE_VIEWS_DATA = {
  totalViews: 12847,
  uniqueArticles: 234,
  uniqueViewers: 567,
  viewsToday: 89,
  periodStats: {
    week: { current: 456, previous: 389, change: 17, changeDirection: 'up', isAllTime: false },
    month: { current: 1823, previous: 1567, change: 16, changeDirection: 'up', isAllTime: false },
    quarter: { current: 4567, previous: 3987, change: 15, changeDirection: 'up', isAllTime: false },
    year: { current: 12847, previous: 9876, change: 30, changeDirection: 'up', isAllTime: false },
    all: { current: 12847, previous: null, change: null, changeDirection: null, isAllTime: true }
  },
  viewsByPeriod: {
    week: [
      { label: 'Mon', count: 67 }, { label: 'Tue', count: 78 }, { label: 'Wed', count: 89 },
      { label: 'Thu', count: 72 }, { label: 'Fri', count: 65 }, { label: 'Sat', count: 43 }, { label: 'Sun', count: 42 }
    ],
    month: [
      { label: 'Week 1', count: 423 }, { label: 'Week 2', count: 478 },
      { label: 'Week 3', count: 456 }, { label: 'Week 4', count: 466 }
    ],
    quarter: [
      { label: 'Jan', count: 1456 }, { label: 'Feb', count: 1567 }, { label: 'Mar', count: 1544 }
    ],
    year: [
      { label: 'Q1', count: 2890 }, { label: 'Q2', count: 3234 },
      { label: 'Q3', count: 3456 }, { label: 'Q4', count: 3267 }
    ],
    all: [
      { label: '2022', count: 3456 }, { label: '2023', count: 4567 }, { label: '2024', count: 4824 }
    ]
  }
};

const DEMO_ORG_TYPE_DATA = {
  fieldName: 'org_type',
  availableFields: [
    { name: 'org_type', label: 'Organization Type', fieldType: 'select', id: 'demo-field-1' }
  ],
  categories: ['ESO', 'SO', 'Partner'],
  summaryCards: [
    { name: 'ESO', total: 127 },
    { name: 'SO', total: 89 },
    { name: 'Partner', total: 45 }
  ],
  yearlyChartData: [
    { year: '2021', ESO: 23, SO: 18, Partner: 8 },
    { year: '2022', ESO: 34, SO: 24, Partner: 12 },
    { year: '2023', ESO: 42, SO: 28, Partner: 15 },
    { year: '2024', ESO: 28, SO: 19, Partner: 10 }
  ],
  currentYear: 2024,
  currentYearMonthlyData: [
    { month: 'Jan', ESO: 8, SO: 5, Partner: 3 },
    { month: 'Feb', ESO: 6, SO: 4, Partner: 2 },
    { month: 'Mar', ESO: 7, SO: 6, Partner: 2 },
    { month: 'Apr', ESO: 3, SO: 2, Partner: 1 },
    { month: 'May', ESO: 2, SO: 1, Partner: 1 },
    { month: 'Jun', ESO: 1, SO: 1, Partner: 0 },
    { month: 'Jul', ESO: 1, SO: 0, Partner: 1 },
    { month: 'Aug', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Sep', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Oct', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Nov', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Dec', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearQuarterlyData: [
    { quarter: 'Q1', ESO: 21, SO: 15, Partner: 7 },
    { quarter: 'Q2', ESO: 6, SO: 4, Partner: 2 },
    { quarter: 'Q3', ESO: 1, SO: 0, Partner: 1 },
    { quarter: 'Q4', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearWeeklyData: [
    { day: 'Mon', ESO: 2, SO: 1, Partner: 0 },
    { day: 'Tue', ESO: 1, SO: 0, Partner: 1 },
    { day: 'Wed', ESO: 0, SO: 1, Partner: 0 },
    { day: 'Thu', ESO: 1, SO: 0, Partner: 0 },
    { day: 'Fri', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Sat', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Sun', ESO: 0, SO: 0, Partner: 0 }
  ],
  allTimeData: [
    { period: 'All Time', ESO: 127, SO: 89, Partner: 45 }
  ],
  totalOrganizations: 261
};

const DEMO_NEW_ORGS_DATA = {
  fieldName: 'org_type',
  availableFields: [
    { name: 'org_type', label: 'Organization Type', fieldType: 'select', id: 'demo-field-1' }
  ],
  categories: ['ESO', 'SO', 'Partner'],
  summaryCards: [
    { name: 'ESO', thisYear: 28, thisMonth: 3, thisWeek: 1, allTime: 127 },
    { name: 'SO', thisYear: 19, thisMonth: 2, thisWeek: 0, allTime: 89 },
    { name: 'Partner', thisYear: 10, thisMonth: 1, thisWeek: 1, allTime: 45 }
  ],
  yearlyChartData: [
    { year: '2021', ESO: 23, SO: 18, Partner: 8 },
    { year: '2022', ESO: 34, SO: 24, Partner: 12 },
    { year: '2023', ESO: 42, SO: 28, Partner: 15 },
    { year: '2024', ESO: 28, SO: 19, Partner: 10 }
  ],
  currentYear: 2024,
  currentYearMonthlyData: [
    { month: 'Jan', ESO: 8, SO: 5, Partner: 3 },
    { month: 'Feb', ESO: 6, SO: 4, Partner: 2 },
    { month: 'Mar', ESO: 7, SO: 6, Partner: 2 },
    { month: 'Apr', ESO: 3, SO: 2, Partner: 1 },
    { month: 'May', ESO: 2, SO: 1, Partner: 1 },
    { month: 'Jun', ESO: 1, SO: 1, Partner: 0 },
    { month: 'Jul', ESO: 1, SO: 0, Partner: 1 },
    { month: 'Aug', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Sep', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Oct', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Nov', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Dec', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearQuarterlyData: [
    { quarter: 'Q1', ESO: 21, SO: 15, Partner: 7 },
    { quarter: 'Q2', ESO: 6, SO: 4, Partner: 2 },
    { quarter: 'Q3', ESO: 1, SO: 0, Partner: 1 },
    { quarter: 'Q4', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearWeeklyData: [
    { day: 'Mon', ESO: 1, SO: 0, Partner: 0 },
    { day: 'Tue', ESO: 0, SO: 0, Partner: 1 },
    { day: 'Wed', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Thu', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Fri', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Sat', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Sun', ESO: 0, SO: 0, Partner: 0 }
  ],
  allTimeData: [
    { period: 'All Time', ESO: 127, SO: 89, Partner: 45 }
  ],
  totalNewThisYear: 57,
  totalNewThisMonth: 6,
  totalNewThisWeek: 2,
  totalAllTime: 261
};

const DEMO_MEMBER_ORG_TYPE_DATA = {
  fieldName: 'org_type',
  availableFields: [
    { name: 'org_type', label: 'Organization Type', fieldType: 'select', id: 'demo-field-1' }
  ],
  categories: ['ESO', 'SO', 'Partner'],
  summaryCards: [
    { name: 'ESO', total: 892 },
    { name: 'SO', total: 534 },
    { name: 'Partner', total: 178 }
  ],
  yearlyChartData: [
    { year: '2021', ESO: 156, SO: 89, Partner: 34 },
    { year: '2022', ESO: 234, SO: 145, Partner: 56 },
    { year: '2023', ESO: 312, SO: 178, Partner: 52 },
    { year: '2024', ESO: 190, SO: 122, Partner: 36 }
  ],
  currentYear: 2024,
  currentYearMonthlyData: [
    { month: 'Jan', ESO: 45, SO: 28, Partner: 12 },
    { month: 'Feb', ESO: 38, SO: 24, Partner: 8 },
    { month: 'Mar', ESO: 52, SO: 32, Partner: 10 },
    { month: 'Apr', ESO: 28, SO: 18, Partner: 4 },
    { month: 'May', ESO: 18, SO: 12, Partner: 2 },
    { month: 'Jun', ESO: 9, SO: 8, Partner: 0 },
    { month: 'Jul', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Aug', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Sep', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Oct', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Nov', ESO: 0, SO: 0, Partner: 0 },
    { month: 'Dec', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearQuarterlyData: [
    { quarter: 'Q1', ESO: 135, SO: 84, Partner: 30 },
    { quarter: 'Q2', ESO: 55, SO: 38, Partner: 6 },
    { quarter: 'Q3', ESO: 0, SO: 0, Partner: 0 },
    { quarter: 'Q4', ESO: 0, SO: 0, Partner: 0 }
  ],
  currentYearWeeklyData: [
    { day: 'Mon', ESO: 8, SO: 5, Partner: 2 },
    { day: 'Tue', ESO: 6, SO: 4, Partner: 1 },
    { day: 'Wed', ESO: 4, SO: 3, Partner: 1 },
    { day: 'Thu', ESO: 5, SO: 2, Partner: 0 },
    { day: 'Fri', ESO: 3, SO: 1, Partner: 0 },
    { day: 'Sat', ESO: 0, SO: 0, Partner: 0 },
    { day: 'Sun', ESO: 0, SO: 0, Partner: 0 }
  ],
  allTimeData: [
    { period: 'All Time', ESO: 892, SO: 534, Partner: 178 }
  ],
  totalMembers: 1604
};

function MembersReportCard({ period, onPeriodChange, demoMode }) {
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/member-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/member-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_MEMBERS_DATA : apiStats;
  const periodData = stats?.periodStats?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && !periodData?.isAllTime;
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-error">
        <p className="text-muted-foreground" data-testid="text-error-message">Failed to load member statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={period} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-40" data-testid="select-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value} data-testid={`select-period-${opt.value}`}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-stats"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4" data-testid="container-stats-grid">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-total-members">Total Members</p>
          <p className="text-3xl font-bold" data-testid="text-total-members">{stats?.totalMembers?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-active-members">Active Members</p>
          <p className="text-3xl font-bold text-green-600" data-testid="text-active-members">{stats?.activeMembers?.toLocaleString() || 0}</p>
        </div>
      </div>

      {hasValidComparison && periodData && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-period-comparison">
          <div className={`p-2 rounded-full ${isPositive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            {isPositive ? (
              <TrendingUp className="w-5 h-5 text-green-600" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-600" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium" data-testid="text-period-comparison">
              <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
                {isPositive ? '+' : ''}{changePercent}%
              </span>
              {' '}vs previous {period}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="text-period-details">
              {periodData.current} new members (was {periodData.previous})
            </p>
          </div>
        </div>
      )}

      {stats?.acquisitionByPeriod?.[period]?.length > 0 && (
        <div className="space-y-3" data-testid="container-acquisition-chart">
          <p className="text-sm font-medium text-muted-foreground" data-testid="text-chart-title">
            Member Acquisition ({period === 'all' ? 'All Time' : `This ${period.charAt(0).toUpperCase() + period.slice(1)}`})
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.acquisitionByPeriod[period]}>
                <defs>
                  <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="label" 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--primary))"
                  fillOpacity={1}
                  fill="url(#colorCount)"
                  name="New Members"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityReportCard({ period, onPeriodChange, demoMode }) {
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/activity-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/activity-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_ACTIVITY_DATA : apiStats;
  const periodData = stats?.periodStats?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && !periodData?.isAllTime;
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-activity-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-activity-error">
        <p className="text-muted-foreground" data-testid="text-activity-error-message">Failed to load activity statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-activity-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={period} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-40" data-testid="select-activity-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value} data-testid={`select-activity-period-${opt.value}`}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-activity"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="container-activity-stats-grid">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-active-today">Active Today</p>
          <p className="text-2xl font-bold text-green-600" data-testid="text-active-today">{stats?.activeToday?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-active-week">This Week</p>
          <p className="text-2xl font-bold" data-testid="text-active-week">{stats?.activeThisWeek?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-active-month">This Month</p>
          <p className="text-2xl font-bold" data-testid="text-active-month">{stats?.activeThisMonth?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-inactive">Inactive (90+ days)</p>
          <p className="text-2xl font-bold text-muted-foreground" data-testid="text-inactive">{stats?.inactiveCount?.toLocaleString() || 0}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-engagement-rate">
        <div className="p-2 rounded-full bg-primary/10">
          <Activity className="w-5 h-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium" data-testid="text-engagement-rate">
            <span className="text-primary text-lg font-bold">{stats?.engagementRate || 0}%</span>
            {' '}Monthly Engagement Rate
          </p>
          <p className="text-xs text-muted-foreground" data-testid="text-engagement-details">
            {stats?.activeThisMonth?.toLocaleString() || 0} of {stats?.totalMembers?.toLocaleString() || 0} members active this month
          </p>
        </div>
      </div>

      {hasValidComparison && periodData && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-activity-comparison">
          <div className={`p-2 rounded-full ${isPositive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            {isPositive ? (
              <TrendingUp className="w-5 h-5 text-green-600" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-600" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium" data-testid="text-activity-comparison">
              <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
                {isPositive ? '+' : ''}{changePercent}%
              </span>
              {' '}vs previous {period}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="text-activity-details">
              {periodData.current} active members (was {periodData.previous})
            </p>
          </div>
        </div>
      )}

      {stats?.activityByPeriod?.[period]?.length > 0 && (
        <div className="space-y-3" data-testid="container-activity-chart">
          <p className="text-sm font-medium text-muted-foreground" data-testid="text-activity-chart-title">
            Member Activity ({period === 'all' ? 'All Time' : `This ${period.charAt(0).toUpperCase() + period.slice(1)}`})
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.activityByPeriod[period]}>
                <defs>
                  <linearGradient id="colorActivity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="label" 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--chart-2))"
                  fillOpacity={1}
                  fill="url(#colorActivity)"
                  name="Active Members"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function ArticleViewsReportCard({ period, onPeriodChange, demoMode }) {
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/article-views-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/article-views-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_ARTICLE_VIEWS_DATA : apiStats;
  const periodData = stats?.periodStats?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && !periodData?.isAllTime;
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-article-views-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-article-views-error">
        <p className="text-muted-foreground" data-testid="text-article-views-error-message">Failed to load article view statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-article-views-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={period} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-40" data-testid="select-article-views-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value} data-testid={`select-article-views-period-${opt.value}`}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-article-views"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="container-article-views-stats-grid">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-total-views">Total Views</p>
          <p className="text-2xl font-bold" data-testid="text-total-views">{stats?.totalViews?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-unique-articles">Unique Articles</p>
          <p className="text-2xl font-bold" data-testid="text-unique-articles">{stats?.uniqueArticles?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-unique-viewers">Unique Viewers</p>
          <p className="text-2xl font-bold" data-testid="text-unique-viewers">{stats?.uniqueViewers?.toLocaleString() || 0}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-views-today">Today</p>
          <p className="text-2xl font-bold text-green-600" data-testid="text-views-today">{stats?.viewsToday?.toLocaleString() || 0}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-views-summary">
        <div className="p-2 rounded-full bg-primary/10">
          <BookOpen className="w-5 h-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium" data-testid="text-views-summary">
            <span className="text-primary text-lg font-bold">{stats?.viewsThisWeek?.toLocaleString() || 0}</span>
            {' '}views this week
          </p>
          <p className="text-xs text-muted-foreground" data-testid="text-views-month">
            {stats?.viewsThisMonth?.toLocaleString() || 0} views this month
          </p>
        </div>
      </div>

      {hasValidComparison && periodData && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-article-views-comparison">
          <div className={`p-2 rounded-full ${isPositive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            {isPositive ? (
              <TrendingUp className="w-5 h-5 text-green-600" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-600" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium" data-testid="text-article-views-comparison">
              <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
                {isPositive ? '+' : ''}{changePercent}%
              </span>
              {' '}vs previous {period}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="text-article-views-details">
              {periodData.current} views (was {periodData.previous})
            </p>
          </div>
        </div>
      )}

      {stats?.topArticles?.length > 0 && (
        <div className="space-y-3" data-testid="container-top-articles">
          <p className="text-sm font-medium text-muted-foreground" data-testid="text-top-articles-title">Most Viewed (Recent)</p>
          <div className="space-y-2">
            {stats.topArticles.map((article, idx) => (
              <div key={article.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/30" data-testid={`row-top-article-${idx}`}>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-sm font-medium text-muted-foreground w-5">{idx + 1}.</span>
                  <span className="text-sm truncate" data-testid={`text-article-title-${idx}`}>{article.title}</span>
                </div>
                <Badge variant="secondary" data-testid={`badge-article-views-${idx}`}>
                  {article.views} views
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats?.viewsByPeriod?.[period]?.length > 0 && (
        <div className="space-y-3" data-testid="container-views-chart">
          <p className="text-sm font-medium text-muted-foreground" data-testid="text-views-chart-title">
            Article Views ({period === 'all' ? 'All Time' : `This ${period.charAt(0).toUpperCase() + period.slice(1)}`})
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.viewsByPeriod[period]}>
                <defs>
                  <linearGradient id="colorViews" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-3))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--chart-3))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="label" 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--chart-3))"
                  fillOpacity={1}
                  fill="url(#colorViews)"
                  name="Article Views"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function OrgTypeReportCard({ 
  selectedField, 
  onFieldChange, 
  viewMode, 
  onViewModeChange, 
  chartType = 'bar',
  onChartTypeChange,
  demoMode,
  aggregation = [],
  onAggregationChange,
  aggregationLabel = 'Total Schools',
  onAggregationLabelChange
}) {
  const [aggregationOpen, setAggregationOpen] = useState(false);
  
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/org-type-stats', selectedField],
    queryFn: () => apiRequest('GET', `/api/reports/org-type-stats?fieldName=${encodeURIComponent(selectedField)}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_ORG_TYPE_DATA : apiStats;

  const rawCategories = stats?.categories || [];
  const rawSummaryCards = stats?.summaryCards || [];
  const rawYearlyChartData = stats?.yearlyChartData || [];
  const rawCurrentYearMonthlyData = stats?.currentYearMonthlyData || [];
  const rawCurrentYearQuarterlyData = stats?.currentYearQuarterlyData || [];
  const rawCurrentYearWeeklyData = stats?.currentYearWeeklyData || [];
  const rawAllTimeData = stats?.allTimeData || [];
  const availableFields = stats?.availableFields || [];
  const currentYear = stats?.currentYear || new Date().getFullYear();

  const applyAggregation = useMemo(() => {
    if (aggregation.length < 2) {
      return {
        categories: rawCategories,
        summaryCards: rawSummaryCards,
        yearlyChartData: rawYearlyChartData,
        currentYearMonthlyData: rawCurrentYearMonthlyData,
        currentYearQuarterlyData: rawCurrentYearQuarterlyData,
        currentYearWeeklyData: rawCurrentYearWeeklyData,
        allTimeData: rawAllTimeData
      };
    }

    const aggregatedCategories = [...rawCategories, aggregationLabel];

    const aggregatedTotal = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + card.total, 0);
    const aggregatedSummaryCards = [...rawSummaryCards, { name: aggregationLabel, total: aggregatedTotal }];

    const aggregateChartData = (data, keyField) => {
      return data.map(row => {
        const newRow = { [keyField]: row[keyField] };
        rawCategories.forEach(cat => {
          newRow[cat] = row[cat] || 0;
        });
        newRow[aggregationLabel] = aggregation.reduce((sum, cat) => sum + (row[cat] || 0), 0);
        return newRow;
      });
    };

    return {
      categories: aggregatedCategories,
      summaryCards: aggregatedSummaryCards,
      yearlyChartData: aggregateChartData(rawYearlyChartData, 'year'),
      currentYearMonthlyData: aggregateChartData(rawCurrentYearMonthlyData, 'month'),
      currentYearQuarterlyData: aggregateChartData(rawCurrentYearQuarterlyData, 'quarter'),
      currentYearWeeklyData: aggregateChartData(rawCurrentYearWeeklyData, 'day'),
      allTimeData: aggregateChartData(rawAllTimeData, 'period')
    };
  }, [rawCategories, rawSummaryCards, rawYearlyChartData, rawCurrentYearMonthlyData, rawCurrentYearQuarterlyData, rawCurrentYearWeeklyData, rawAllTimeData, aggregation, aggregationLabel]);

  const { categories, summaryCards, yearlyChartData, currentYearMonthlyData, currentYearQuarterlyData, currentYearWeeklyData, allTimeData } = applyAggregation;

  const toggleAggregation = (category) => {
    if (aggregation.includes(category)) {
      onAggregationChange(aggregation.filter(c => c !== category));
    } else {
      onAggregationChange([...aggregation, category]);
    }
  };

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-org-type-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-org-type-error">
        <p className="text-muted-foreground" data-testid="text-org-type-error-message">Failed to load organization statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-org-type-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const getChartDataAndKey = () => {
    switch (viewMode) {
      case 'weekly': return { data: currentYearWeeklyData, key: 'day' };
      case 'monthly': return { data: currentYearMonthlyData, key: 'month' };
      case 'quarterly': return { data: currentYearQuarterlyData, key: 'quarter' };
      case 'yearly': return { data: yearlyChartData, key: 'year' };
      case 'all': return { data: allTimeData, key: 'period' };
      default: return { data: currentYearMonthlyData, key: 'month' };
    }
  };
  const { data: currentChartData, key: xAxisKey } = getChartDataAndKey();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedField} onValueChange={onFieldChange}>
            <SelectTrigger className="w-48" data-testid="select-org-field">
              <SelectValue placeholder="Select field..." />
            </SelectTrigger>
            <SelectContent>
              {availableFields.length > 0 ? (
                availableFields.map(field => (
                  <SelectItem key={field.name} value={field.name} data-testid={`select-org-field-${field.name}`}>
                    {field.label}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="org_type">Organization Type</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Select value={viewMode} onValueChange={onViewModeChange}>
            <SelectTrigger className="w-32" data-testid="select-org-view-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={chartType} onValueChange={onChartTypeChange}>
            <SelectTrigger className="w-28" data-testid="select-org-chart-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bar">Bar Chart</SelectItem>
              <SelectItem value="line">Line Chart</SelectItem>
            </SelectContent>
          </Select>
          <Popover open={aggregationOpen} onOpenChange={setAggregationOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-aggregation-settings">
                <Building2 className="w-4 h-4 mr-2" />
                Aggregate
                {aggregation.length >= 2 && (
                  <Badge variant="secondary" className="ml-2">{aggregation.length}</Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="start" data-testid="popover-aggregation">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-1">Combine Categories</h4>
                  <p className="text-xs text-muted-foreground">Select 2+ categories to aggregate into a single group</p>
                </div>
                <div className="space-y-2">
                  {rawCategories.map(category => (
                    <div key={category} className="flex items-center gap-2">
                      <Checkbox
                        id={`agg-${category}`}
                        checked={aggregation.includes(category)}
                        onCheckedChange={() => toggleAggregation(category)}
                        data-testid={`checkbox-aggregate-${category}`}
                      />
                      <Label htmlFor={`agg-${category}`} className="text-sm cursor-pointer">
                        {category}
                      </Label>
                    </div>
                  ))}
                </div>
                {aggregation.length >= 2 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label htmlFor="agg-label" className="text-sm">Group Label</Label>
                      <Input
                        id="agg-label"
                        value={aggregationLabel}
                        onChange={(e) => onAggregationLabelChange(e.target.value)}
                        placeholder="e.g., Total Schools"
                        data-testid="input-aggregation-label"
                      />
                    </div>
                  </>
                )}
                {aggregation.length >= 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => onAggregationChange([])}
                    data-testid="button-clear-aggregation"
                  >
                    Clear Aggregation
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-org-type"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="container-org-type-summary">
        {summaryCards.map((card, index) => (
          <Card 
            key={card.name} 
            className={`p-4 ${aggregation.length >= 2 && card.name === aggregationLabel ? 'ring-2 ring-primary/50' : ''}`}
            data-testid={`card-org-type-${card.name}`}
          >
            <div className="flex items-start gap-3">
              <div 
                className="w-1 h-12 rounded-full shrink-0" 
                style={{ backgroundColor: ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length] }}
              />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">{card.name}</p>
                <p className="text-3xl font-bold">{card.total.toLocaleString()}</p>
              </div>
            </div>
          </Card>
        ))}
        <Card className="p-4 bg-muted/50" data-testid="card-org-total">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Total Organizations</p>
            <p className="text-3xl font-bold">{stats?.totalOrganizations?.toLocaleString() || 0}</p>
          </div>
        </Card>
      </div>

      {currentChartData.length > 0 && (
        <div className="space-y-4" data-testid="container-org-type-chart">
          <h4 className="text-sm font-medium text-muted-foreground">
            Organizations by Type ({viewMode === 'weekly' ? 'This Week' : viewMode === 'monthly' ? 'Monthly' : viewMode === 'quarterly' ? 'Quarterly' : viewMode === 'yearly' ? 'By Year' : 'All Time'})
          </h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'line' ? (
                <LineChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Line
                      key={category}
                      type="monotone"
                      dataKey={category}
                      stroke={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      name={category}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Bar
                      key={category}
                      dataKey={category}
                      fill={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      name={category}
                    />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function NewOrgsReportCard({ 
  selectedField, 
  onFieldChange, 
  viewMode, 
  onViewModeChange, 
  chartType = 'bar',
  onChartTypeChange,
  demoMode,
  aggregation = [],
  onAggregationChange,
  aggregationLabel = 'Total Schools',
  onAggregationLabelChange
}) {
  const [aggregationOpen, setAggregationOpen] = useState(false);
  
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/new-org-stats', selectedField],
    queryFn: () => apiRequest('GET', `/api/reports/new-org-stats?fieldName=${encodeURIComponent(selectedField)}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_NEW_ORGS_DATA : apiStats;

  const rawCategories = stats?.categories || [];
  const rawSummaryCards = stats?.summaryCards || [];
  const rawYearlyChartData = stats?.yearlyChartData || [];
  const rawCurrentYearMonthlyData = stats?.currentYearMonthlyData || [];
  const rawCurrentYearQuarterlyData = stats?.currentYearQuarterlyData || [];
  const rawCurrentYearWeeklyData = stats?.currentYearWeeklyData || [];
  const rawAllTimeData = stats?.allTimeData || [];
  const availableFields = stats?.availableFields || [];
  const currentYear = stats?.currentYear || new Date().getFullYear();

  const applyAggregation = useMemo(() => {
    if (aggregation.length < 2) {
      return {
        categories: rawCategories,
        summaryCards: rawSummaryCards,
        yearlyChartData: rawYearlyChartData,
        currentYearMonthlyData: rawCurrentYearMonthlyData,
        currentYearQuarterlyData: rawCurrentYearQuarterlyData,
        currentYearWeeklyData: rawCurrentYearWeeklyData,
        allTimeData: rawAllTimeData
      };
    }

    const aggregatedCategories = [...rawCategories, aggregationLabel];

    const aggregatedThisYear = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + (card.thisYear || 0), 0);
    const aggregatedThisMonth = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + (card.thisMonth || 0), 0);
    const aggregatedThisWeek = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + (card.thisWeek || 0), 0);
    const aggregatedAllTime = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + (card.allTime || 0), 0);
    const aggregatedSummaryCards = [...rawSummaryCards, { name: aggregationLabel, thisYear: aggregatedThisYear, thisMonth: aggregatedThisMonth, thisWeek: aggregatedThisWeek, allTime: aggregatedAllTime }];

    const aggregateChartData = (data, keyField) => {
      return data.map(row => {
        const newRow = { [keyField]: row[keyField] };
        rawCategories.forEach(cat => {
          newRow[cat] = row[cat] || 0;
        });
        newRow[aggregationLabel] = aggregation.reduce((sum, cat) => sum + (row[cat] || 0), 0);
        return newRow;
      });
    };

    return {
      categories: aggregatedCategories,
      summaryCards: aggregatedSummaryCards,
      yearlyChartData: aggregateChartData(rawYearlyChartData, 'year'),
      currentYearMonthlyData: aggregateChartData(rawCurrentYearMonthlyData, 'month'),
      currentYearQuarterlyData: aggregateChartData(rawCurrentYearQuarterlyData, 'quarter'),
      currentYearWeeklyData: aggregateChartData(rawCurrentYearWeeklyData, 'day'),
      allTimeData: aggregateChartData(rawAllTimeData, 'period')
    };
  }, [rawCategories, rawSummaryCards, rawYearlyChartData, rawCurrentYearMonthlyData, rawCurrentYearQuarterlyData, rawCurrentYearWeeklyData, rawAllTimeData, aggregation, aggregationLabel]);

  const { categories, summaryCards, yearlyChartData, currentYearMonthlyData, currentYearQuarterlyData, currentYearWeeklyData, allTimeData } = applyAggregation;

  const toggleAggregation = (category) => {
    if (aggregation.includes(category)) {
      onAggregationChange(aggregation.filter(c => c !== category));
    } else {
      onAggregationChange([...aggregation, category]);
    }
  };

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-new-orgs-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-new-orgs-error">
        <p className="text-muted-foreground" data-testid="text-new-orgs-error-message">Failed to load new organization statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-new-orgs-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const getChartDataAndKey = () => {
    switch (viewMode) {
      case 'weekly': return { data: currentYearWeeklyData, key: 'day' };
      case 'monthly': return { data: currentYearMonthlyData, key: 'month' };
      case 'quarterly': return { data: currentYearQuarterlyData, key: 'quarter' };
      case 'yearly': return { data: yearlyChartData, key: 'year' };
      case 'all': return { data: allTimeData, key: 'period' };
      default: return { data: currentYearMonthlyData, key: 'month' };
    }
  };
  const { data: currentChartData, key: xAxisKey } = getChartDataAndKey();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedField} onValueChange={onFieldChange}>
            <SelectTrigger className="w-48" data-testid="select-new-orgs-field">
              <SelectValue placeholder="Select field..." />
            </SelectTrigger>
            <SelectContent>
              {availableFields.length > 0 ? (
                availableFields.map(field => (
                  <SelectItem key={field.name} value={field.name} data-testid={`select-new-orgs-field-${field.name}`}>
                    {field.label}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="org_type">Organization Type</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Select value={viewMode} onValueChange={onViewModeChange}>
            <SelectTrigger className="w-32" data-testid="select-new-orgs-view-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={chartType} onValueChange={onChartTypeChange}>
            <SelectTrigger className="w-28" data-testid="select-new-orgs-chart-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bar">Bar Chart</SelectItem>
              <SelectItem value="line">Line Chart</SelectItem>
            </SelectContent>
          </Select>
          <Popover open={aggregationOpen} onOpenChange={setAggregationOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-new-orgs-aggregation-settings">
                <Building2 className="w-4 h-4 mr-2" />
                Aggregate
                {aggregation.length >= 2 && (
                  <Badge variant="secondary" className="ml-2">{aggregation.length}</Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="start" data-testid="popover-new-orgs-aggregation">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-1">Combine Categories</h4>
                  <p className="text-xs text-muted-foreground">Select 2+ categories to aggregate into a single group</p>
                </div>
                <div className="space-y-2">
                  {rawCategories.map(category => (
                    <div key={category} className="flex items-center gap-2">
                      <Checkbox
                        id={`new-orgs-agg-${category}`}
                        checked={aggregation.includes(category)}
                        onCheckedChange={() => toggleAggregation(category)}
                        data-testid={`checkbox-new-orgs-aggregate-${category}`}
                      />
                      <Label htmlFor={`new-orgs-agg-${category}`} className="text-sm cursor-pointer">
                        {category}
                      </Label>
                    </div>
                  ))}
                </div>
                {aggregation.length >= 2 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label htmlFor="new-orgs-agg-label" className="text-sm">Group Label</Label>
                      <Input
                        id="new-orgs-agg-label"
                        value={aggregationLabel}
                        onChange={(e) => onAggregationLabelChange(e.target.value)}
                        placeholder="e.g., Total Schools"
                        data-testid="input-new-orgs-aggregation-label"
                      />
                    </div>
                  </>
                )}
                {aggregation.length >= 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => onAggregationChange([])}
                    data-testid="button-new-orgs-clear-aggregation"
                  >
                    Clear Aggregation
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-new-orgs"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="container-new-orgs-summary">
        {summaryCards.map((card, index) => (
          <Card 
            key={card.name} 
            className={`p-4 ${aggregation.length >= 2 && card.name === aggregationLabel ? 'ring-2 ring-primary/50' : ''}`}
            data-testid={`card-new-orgs-${card.name}`}
          >
            <div className="flex items-start gap-3">
              <div 
                className="w-1 h-12 rounded-full shrink-0" 
                style={{ backgroundColor: ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length] }}
              />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">{card.name}</p>
                <p className="text-2xl font-bold">{(card.thisYear || 0).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">This month: {(card.thisMonth || 0).toLocaleString()}</p>
              </div>
            </div>
          </Card>
        ))}
        <Card className="p-4 bg-muted/50" data-testid="card-new-orgs-total">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Total New This Year</p>
            <p className="text-2xl font-bold">{stats?.totalNewThisYear?.toLocaleString() || 0}</p>
            <p className="text-xs text-muted-foreground">This month: {stats?.totalNewThisMonth?.toLocaleString() || 0}</p>
          </div>
        </Card>
      </div>

      {currentChartData.length > 0 && (
        <div className="space-y-4" data-testid="container-new-orgs-chart">
          <h4 className="text-sm font-medium text-muted-foreground">
            New Organizations ({viewMode === 'weekly' ? 'This Week' : viewMode === 'monthly' ? 'Monthly' : viewMode === 'quarterly' ? 'Quarterly' : viewMode === 'yearly' ? 'By Year' : 'All Time'})
          </h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'line' ? (
                <LineChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Line
                      key={category}
                      type="monotone"
                      dataKey={category}
                      stroke={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      name={category}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Bar
                      key={category}
                      dataKey={category}
                      fill={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      name={category}
                    />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function MemberOrgTypeReportCard({ 
  selectedField, 
  onFieldChange, 
  viewMode, 
  onViewModeChange, 
  chartType = 'bar',
  onChartTypeChange,
  demoMode,
  aggregation = [],
  onAggregationChange,
  aggregationLabel = 'Total Schools',
  onAggregationLabelChange
}) {
  const [aggregationOpen, setAggregationOpen] = useState(false);
  
  const { data: apiStats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/member-org-type-stats', selectedField],
    queryFn: () => apiRequest('GET', `/api/reports/member-org-type-stats?fieldName=${encodeURIComponent(selectedField)}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const stats = demoMode ? DEMO_MEMBER_ORG_TYPE_DATA : apiStats;

  const rawCategories = stats?.categories || [];
  const rawSummaryCards = stats?.summaryCards || [];
  const rawYearlyChartData = stats?.yearlyChartData || [];
  const rawCurrentYearMonthlyData = stats?.currentYearMonthlyData || [];
  const rawCurrentYearQuarterlyData = stats?.currentYearQuarterlyData || [];
  const rawCurrentYearWeeklyData = stats?.currentYearWeeklyData || [];
  const rawAllTimeData = stats?.allTimeData || [];
  const availableFields = stats?.availableFields || [];
  const currentYear = stats?.currentYear || new Date().getFullYear();

  const applyAggregation = useMemo(() => {
    if (aggregation.length < 2) {
      return {
        categories: rawCategories,
        summaryCards: rawSummaryCards,
        yearlyChartData: rawYearlyChartData,
        currentYearMonthlyData: rawCurrentYearMonthlyData,
        currentYearQuarterlyData: rawCurrentYearQuarterlyData,
        currentYearWeeklyData: rawCurrentYearWeeklyData,
        allTimeData: rawAllTimeData
      };
    }

    const aggregatedCategories = [...rawCategories, aggregationLabel];

    const aggregatedTotal = rawSummaryCards
      .filter(card => aggregation.includes(card.name))
      .reduce((sum, card) => sum + card.total, 0);
    const aggregatedSummaryCards = [...rawSummaryCards, { name: aggregationLabel, total: aggregatedTotal }];

    const aggregateChartData = (data, keyField) => {
      return data.map(row => {
        const newRow = { [keyField]: row[keyField] };
        rawCategories.forEach(cat => {
          newRow[cat] = row[cat] || 0;
        });
        newRow[aggregationLabel] = aggregation.reduce((sum, cat) => sum + (row[cat] || 0), 0);
        return newRow;
      });
    };

    return {
      categories: aggregatedCategories,
      summaryCards: aggregatedSummaryCards,
      yearlyChartData: aggregateChartData(rawYearlyChartData, 'year'),
      currentYearMonthlyData: aggregateChartData(rawCurrentYearMonthlyData, 'month'),
      currentYearQuarterlyData: aggregateChartData(rawCurrentYearQuarterlyData, 'quarter'),
      currentYearWeeklyData: aggregateChartData(rawCurrentYearWeeklyData, 'day'),
      allTimeData: aggregateChartData(rawAllTimeData, 'period')
    };
  }, [rawCategories, rawSummaryCards, rawYearlyChartData, rawCurrentYearMonthlyData, rawCurrentYearQuarterlyData, rawCurrentYearWeeklyData, rawAllTimeData, aggregation, aggregationLabel]);

  const { categories, summaryCards, yearlyChartData, currentYearMonthlyData, currentYearQuarterlyData, currentYearWeeklyData, allTimeData } = applyAggregation;

  const toggleAggregation = (category) => {
    if (aggregation.includes(category)) {
      onAggregationChange(aggregation.filter(c => c !== category));
    } else {
      onAggregationChange([...aggregation, category]);
    }
  };

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-member-org-type-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-member-org-type-error">
        <p className="text-muted-foreground" data-testid="text-member-org-type-error-message">Failed to load member statistics</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-member-org-type-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const getChartDataAndKey = () => {
    switch (viewMode) {
      case 'weekly': return { data: currentYearWeeklyData, key: 'day' };
      case 'monthly': return { data: currentYearMonthlyData, key: 'month' };
      case 'quarterly': return { data: currentYearQuarterlyData, key: 'quarter' };
      case 'yearly': return { data: yearlyChartData, key: 'year' };
      case 'all': return { data: allTimeData, key: 'period' };
      default: return { data: currentYearMonthlyData, key: 'month' };
    }
  };
  const { data: currentChartData, key: xAxisKey } = getChartDataAndKey();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedField} onValueChange={onFieldChange}>
            <SelectTrigger className="w-48" data-testid="select-member-org-type-field">
              <SelectValue placeholder="Select field..." />
            </SelectTrigger>
            <SelectContent>
              {availableFields.length > 0 ? (
                availableFields.map(field => (
                  <SelectItem key={field.name} value={field.name} data-testid={`select-member-org-type-field-${field.name}`}>
                    {field.label}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="org_type">Organization Type</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Select value={viewMode} onValueChange={onViewModeChange}>
            <SelectTrigger className="w-32" data-testid="select-member-org-type-view-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={chartType} onValueChange={onChartTypeChange}>
            <SelectTrigger className="w-28" data-testid="select-member-org-type-chart-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bar">Bar Chart</SelectItem>
              <SelectItem value="line">Line Chart</SelectItem>
            </SelectContent>
          </Select>
          <Popover open={aggregationOpen} onOpenChange={setAggregationOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-member-org-type-aggregation-settings">
                <Building2 className="w-4 h-4 mr-2" />
                Aggregate
                {aggregation.length >= 2 && (
                  <Badge variant="secondary" className="ml-2">{aggregation.length}</Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="start" data-testid="popover-member-org-type-aggregation">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-1">Combine Categories</h4>
                  <p className="text-xs text-muted-foreground">Select 2+ categories to aggregate into a single group</p>
                </div>
                <div className="space-y-2">
                  {rawCategories.map(category => (
                    <div key={category} className="flex items-center gap-2">
                      <Checkbox
                        id={`member-org-type-agg-${category}`}
                        checked={aggregation.includes(category)}
                        onCheckedChange={() => toggleAggregation(category)}
                        data-testid={`checkbox-member-org-type-aggregate-${category}`}
                      />
                      <Label htmlFor={`member-org-type-agg-${category}`} className="text-sm cursor-pointer">
                        {category}
                      </Label>
                    </div>
                  ))}
                </div>
                {aggregation.length >= 2 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label htmlFor="member-org-type-agg-label" className="text-sm">Group Label</Label>
                      <Input
                        id="member-org-type-agg-label"
                        value={aggregationLabel}
                        onChange={(e) => onAggregationLabelChange(e.target.value)}
                        placeholder="e.g., Total Schools"
                        data-testid="input-member-org-type-aggregation-label"
                      />
                    </div>
                  </>
                )}
                {aggregation.length >= 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => onAggregationChange([])}
                    data-testid="button-member-org-type-clear-aggregation"
                  >
                    Clear Aggregation
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {!demoMode && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-member-org-type"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="container-member-org-type-summary">
        {summaryCards.map((card, index) => (
          <Card 
            key={card.name} 
            className={`p-4 ${aggregation.length >= 2 && card.name === aggregationLabel ? 'ring-2 ring-primary/50' : ''}`}
            data-testid={`card-member-org-type-${card.name}`}
          >
            <div className="flex items-start gap-3">
              <div 
                className="w-1 h-12 rounded-full shrink-0" 
                style={{ backgroundColor: ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length] }}
              />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">{card.name}</p>
                <p className="text-2xl font-bold">{(card.total || 0).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">members</p>
              </div>
            </div>
          </Card>
        ))}
        <Card className="p-4 bg-muted/50" data-testid="card-member-org-type-total">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Total Members</p>
            <p className="text-2xl font-bold">{stats?.totalMembers?.toLocaleString() || 0}</p>
          </div>
        </Card>
      </div>

      {currentChartData.length > 0 && (
        <div className="space-y-4" data-testid="container-member-org-type-chart">
          <h4 className="text-sm font-medium text-muted-foreground">
            Members by Type ({viewMode === 'weekly' ? 'This Week' : viewMode === 'monthly' ? 'Monthly' : viewMode === 'quarterly' ? 'Quarterly' : viewMode === 'yearly' ? 'By Year' : 'All Time'})
          </h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'line' ? (
                <LineChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Line
                      key={category}
                      type="monotone"
                      dataKey={category}
                      stroke={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      name={category}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={currentChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey={xAxisKey} tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Legend />
                  {categories.map((category, index) => (
                    <Bar
                      key={category}
                      dataKey={category}
                      fill={ORG_TYPE_COLORS[index % ORG_TYPE_COLORS.length]}
                      name={category}
                    />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportsDashboard() {
  const { memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { tenantSlug } = useTenantBranding() || {};
  const [accessChecked, setAccessChecked] = useState(false);
  const [reportCards, setReportCards] = useState(DEFAULT_REPORT_CARDS);
  const [membersPeriod, setMembersPeriod] = useState('month');
  const [activityPeriod, setActivityPeriod] = useState('month');
  const [articleViewsPeriod, setArticleViewsPeriod] = useState('month');
  const [orgTypeField, setOrgTypeField] = useState('org_type');
  const [orgTypeViewMode, setOrgTypeViewMode] = useState('monthly');
  const [orgTypeChartType, setOrgTypeChartType] = useState('bar');
  const [orgTypeAggregation, setOrgTypeAggregation] = useState([]);
  const [orgTypeAggregationLabel, setOrgTypeAggregationLabel] = useState('Total Schools');
  const [newOrgsField, setNewOrgsField] = useState('org_type');
  const [newOrgsViewMode, setNewOrgsViewMode] = useState('monthly');
  const [newOrgsChartType, setNewOrgsChartType] = useState('bar');
  const [newOrgsAggregation, setNewOrgsAggregation] = useState([]);
  const [newOrgsAggregationLabel, setNewOrgsAggregationLabel] = useState('Total Schools');
  const [memberOrgTypeField, setMemberOrgTypeField] = useState('org_type');
  const [memberOrgTypeViewMode, setMemberOrgTypeViewMode] = useState('monthly');
  const [memberOrgTypeChartType, setMemberOrgTypeChartType] = useState('bar');
  const [memberOrgTypeAggregation, setMemberOrgTypeAggregation] = useState([]);
  const [memberOrgTypeAggregationLabel, setMemberOrgTypeAggregationLabel] = useState('Total Schools');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  const storageKey = useMemo(() => 
    `${STORAGE_KEY_PREFIX}${tenantSlug || 'default'}_${memberInfo?.id || 'guest'}`,
    [tenantSlug, memberInfo?.id]
  );

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_ReportsDashboard')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  useEffect(() => {
    if (memberInfo?.id && tenantSlug !== undefined) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.reportCards) {
            // Merge saved cards with defaults to include any new cards
            const savedCardIds = new Set(parsed.reportCards.map(c => c.id));
            const mergedCards = [...parsed.reportCards];
            
            // Add any new default cards that aren't in saved settings
            DEFAULT_REPORT_CARDS.forEach(defaultCard => {
              if (!savedCardIds.has(defaultCard.id)) {
                mergedCards.push({
                  ...defaultCard,
                  order: mergedCards.length
                });
              }
            });
            
            setReportCards(mergedCards);
          }
          if (parsed.membersPeriod) setMembersPeriod(parsed.membersPeriod);
          if (parsed.activityPeriod) setActivityPeriod(parsed.activityPeriod);
          if (parsed.articleViewsPeriod) setArticleViewsPeriod(parsed.articleViewsPeriod);
          if (parsed.orgTypeField) setOrgTypeField(parsed.orgTypeField);
          if (parsed.orgTypeViewMode) setOrgTypeViewMode(parsed.orgTypeViewMode);
        }
      } catch (e) {
        console.error('Error loading dashboard preferences:', e);
      }
    }
  }, [storageKey, memberInfo?.id, tenantSlug]);

  useEffect(() => {
    if (memberInfo?.id && tenantSlug !== undefined) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          reportCards,
          membersPeriod,
          activityPeriod,
          articleViewsPeriod,
          orgTypeField,
          orgTypeViewMode
        }));
      } catch (e) {
        console.error('Error saving dashboard preferences:', e);
      }
    }
  }, [reportCards, membersPeriod, activityPeriod, articleViewsPeriod, orgTypeField, orgTypeViewMode, storageKey, memberInfo?.id, tenantSlug]);

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const items = Array.from(reportCards);
    const [reordered] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reordered);

    const updatedItems = items.map((item, index) => ({
      ...item,
      order: index
    }));

    setReportCards(updatedItems);
  };

  const toggleCardVisibility = (cardId) => {
    setReportCards(prev =>
      prev.map(card =>
        card.id === cardId ? { ...card, visible: !card.visible } : card
      )
    );
  };

  const visibleCards = useMemo(() => 
    reportCards
      .filter(card => card.visible)
      .sort((a, b) => a.order - b.order),
    [reportCards]
  );

  const renderCardContent = (cardId) => {
    switch (cardId) {
      case 'members':
        return (
          <MembersReportCard
            period={membersPeriod}
            onPeriodChange={setMembersPeriod}
            demoMode={demoMode}
          />
        );
      case 'activity':
        return (
          <ActivityReportCard
            period={activityPeriod}
            onPeriodChange={setActivityPeriod}
            demoMode={demoMode}
          />
        );
      case 'article-views':
        return (
          <ArticleViewsReportCard
            period={articleViewsPeriod}
            onPeriodChange={setArticleViewsPeriod}
            demoMode={demoMode}
          />
        );
      case 'org-types':
        return (
          <OrgTypeReportCard
            selectedField={orgTypeField}
            onFieldChange={setOrgTypeField}
            viewMode={orgTypeViewMode}
            onViewModeChange={setOrgTypeViewMode}
            chartType={orgTypeChartType}
            onChartTypeChange={setOrgTypeChartType}
            demoMode={demoMode}
            aggregation={orgTypeAggregation}
            onAggregationChange={setOrgTypeAggregation}
            aggregationLabel={orgTypeAggregationLabel}
            onAggregationLabelChange={setOrgTypeAggregationLabel}
          />
        );
      case 'new-orgs':
        return (
          <NewOrgsReportCard
            selectedField={newOrgsField}
            onFieldChange={setNewOrgsField}
            viewMode={newOrgsViewMode}
            onViewModeChange={setNewOrgsViewMode}
            chartType={newOrgsChartType}
            onChartTypeChange={setNewOrgsChartType}
            demoMode={demoMode}
            aggregation={newOrgsAggregation}
            onAggregationChange={setNewOrgsAggregation}
            aggregationLabel={newOrgsAggregationLabel}
            onAggregationLabelChange={setNewOrgsAggregationLabel}
          />
        );
      case 'members-by-org-type':
        return (
          <MemberOrgTypeReportCard
            selectedField={memberOrgTypeField}
            onFieldChange={setMemberOrgTypeField}
            viewMode={memberOrgTypeViewMode}
            onViewModeChange={setMemberOrgTypeViewMode}
            chartType={memberOrgTypeChartType}
            onChartTypeChange={setMemberOrgTypeChartType}
            demoMode={demoMode}
            aggregation={memberOrgTypeAggregation}
            onAggregationChange={setMemberOrgTypeAggregation}
            aggregationLabel={memberOrgTypeAggregationLabel}
            onAggregationLabelChange={setMemberOrgTypeAggregationLabel}
          />
        );
      default:
        return null;
    }
  };

  const getCardIcon = (cardId) => {
    switch (cardId) {
      case 'members':
        return <Users className="w-5 h-5" />;
      case 'activity':
        return <Activity className="w-5 h-5" />;
      case 'article-views':
        return <FileText className="w-5 h-5" />;
      case 'org-types':
        return <Building2 className="w-5 h-5" />;
      case 'new-orgs':
        return <TrendingUp className="w-5 h-5" />;
      case 'members-by-org-type':
        return <Users className="w-5 h-5" />;
      default:
        return <BarChart3 className="w-5 h-5" />;
    }
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <LayoutDashboard className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Reports Dashboard</h1>
              <p className="text-sm text-muted-foreground">Monitor key metrics and insights</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="demo-mode"
                checked={demoMode}
                onCheckedChange={setDemoMode}
                data-testid="switch-demo-mode"
              />
              <Label htmlFor="demo-mode" className="text-sm cursor-pointer">
                Demo Data
              </Label>
            </div>
            <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" data-testid="button-dashboard-settings">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Customize
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-80" align="end" data-testid="popover-dashboard-settings">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-1" data-testid="text-settings-title">Report Cards</h4>
                  <p className="text-sm text-muted-foreground">Toggle which reports to display</p>
                </div>
                <Separator />
                <div className="space-y-3">
                  {reportCards.map(card => (
                    <div key={card.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getCardIcon(card.id)}
                        <Label htmlFor={`toggle-${card.id}`} className="cursor-pointer">
                          {card.title}
                        </Label>
                      </div>
                      <Switch
                        id={`toggle-${card.id}`}
                        checked={card.visible}
                        onCheckedChange={() => toggleCardVisibility(card.id)}
                        data-testid={`switch-toggle-${card.id}`}
                      />
                    </div>
                  ))}
                </div>
                {reportCards.length === 1 && (
                  <p className="text-xs text-muted-foreground italic">
                    More report cards coming soon...
                  </p>
                )}
              </div>
            </PopoverContent>
          </Popover>
          </div>
        </div>

        {visibleCards.length === 0 ? (
          <Card data-testid="card-empty-state">
            <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="p-4 rounded-full bg-muted">
                <EyeOff className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center">
                <h3 className="font-medium" data-testid="text-empty-title">No reports visible</h3>
                <p className="text-sm text-muted-foreground" data-testid="text-empty-description">
                  Click "Customize" to enable report cards
                </p>
              </div>
              <Button variant="outline" onClick={() => setSettingsOpen(true)} data-testid="button-show-reports">
                <Eye className="w-4 h-4 mr-2" />
                Show Reports
              </Button>
            </CardContent>
          </Card>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="reports">
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="space-y-6"
                >
                  {visibleCards.map((card, index) => (
                    <Draggable key={card.id} draggableId={card.id} index={index}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={`${snapshot.isDragging ? 'z-50' : ''}`}
                        >
                          <Card className={`transition-shadow ${snapshot.isDragging ? 'shadow-lg ring-2 ring-primary/20' : ''}`}>
                            <CardHeader className="flex flex-row items-center gap-3 pb-2">
                              <div
                                {...provided.dragHandleProps}
                                className="cursor-grab active:cursor-grabbing p-1 -ml-1 hover:bg-muted rounded"
                                data-testid={`drag-handle-${card.id}`}
                              >
                                <GripVertical className="w-5 h-5 text-muted-foreground" />
                              </div>
                              <div className="flex items-center gap-2 flex-1">
                                {getCardIcon(card.id)}
                                <CardTitle className="text-lg">{card.title}</CardTitle>
                              </div>
                            </CardHeader>
                            <CardContent>
                              {renderCardContent(card.id)}
                            </CardContent>
                          </Card>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>
    </div>
  );
}

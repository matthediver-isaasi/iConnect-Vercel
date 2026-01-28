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
import { Progress } from "@/components/ui/progress";
import {
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
  Filter,
  Clock,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from "recharts";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const STORAGE_KEY_PREFIX = 'dd_reports_dashboard_';

const DEFAULT_REPORT_CARDS = [
  { id: 'application-funnel', title: 'Application Funnel', visible: true, order: 0 },
  { id: 'verification', title: 'Verification', visible: true, order: 1 }
];

const PERIOD_OPTIONS = [
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' }
];

const DEMO_FUNNEL_DATA = {
  totalApplications: 847,
  stageBreakdown: [
    { id: 'new', label: 'New', color: '#3B82F6', count: 312, percentage: 37 },
    { id: 'in-review', label: 'In Review', color: '#F59E0B', count: 198, percentage: 23 },
    { id: 'verified', label: 'Verified', color: '#10B981', count: 142, percentage: 17 },
    { id: 'dd-meet-attended', label: 'DD Meet Attended', color: '#8B5CF6', count: 89, percentage: 11 },
    { id: 'held', label: 'Held', color: '#6366F1', count: 52, percentage: 6 },
    { id: 'approved', label: 'Approved', color: '#22C55E', count: 28, percentage: 3 },
    { id: 'rejected', label: 'Rejected', color: '#EF4444', count: 18, percentage: 2 },
    { id: 'incomplete', label: 'Incomplete', color: '#9CA3AF', count: 8, percentage: 1 }
  ],
  conversionRates: [
    { fromStageId: 'new', toStageId: 'in-review', fromStage: 'New', toStage: 'In Review', fromCount: 312, toCount: 198, rate: 63 },
    { fromStageId: 'in-review', toStageId: 'verified', fromStage: 'In Review', toStage: 'Verified', fromCount: 198, toCount: 142, rate: 72 },
    { fromStageId: 'verified', toStageId: 'dd-meet-attended', fromStage: 'Verified', toStage: 'DD Meet Attended', fromCount: 142, toCount: 89, rate: 63 },
    { fromStageId: 'dd-meet-attended', toStageId: 'held', fromStage: 'DD Meet Attended', toStage: 'Held', fromCount: 89, toCount: 52, rate: 58 },
    { fromStageId: 'held', toStageId: 'approved', fromStage: 'Held', toStage: 'Approved', fromCount: 52, toCount: 28, rate: 54 }
  ],
  dropOffAnalysis: [
    { stageId: 'new', stageLabel: 'New', entered: 312, exited: 198, currentlyAt: 114, dropOffRate: 37 },
    { stageId: 'in-review', stageLabel: 'In Review', entered: 198, exited: 142, currentlyAt: 56, dropOffRate: 28 },
    { stageId: 'verified', stageLabel: 'Verified', entered: 142, exited: 89, currentlyAt: 53, dropOffRate: 37 },
    { stageId: 'dd-meet-attended', stageLabel: 'DD Meet Attended', entered: 89, exited: 52, currentlyAt: 37, dropOffRate: 42 },
    { stageId: 'held', stageLabel: 'Held', entered: 52, exited: 28, currentlyAt: 24, dropOffRate: 46 },
    { stageId: 'approved', stageLabel: 'Approved', entered: 28, exited: 0, currentlyAt: 28, dropOffRate: 0 }
  ],
  averageTimePerStage: [
    { stageId: 'new', stageLabel: 'New', color: '#3B82F6', averageDays: 2, averageHours: 48, sampleSize: 198 },
    { stageId: 'in-review', stageLabel: 'In Review', color: '#F59E0B', averageDays: 5, averageHours: 120, sampleSize: 142 },
    { stageId: 'verified', stageLabel: 'Verified', color: '#10B981', averageDays: 3, averageHours: 72, sampleSize: 89 },
    { stageId: 'dd-meet-attended', stageLabel: 'DD Meet Attended', color: '#8B5CF6', averageDays: 7, averageHours: 168, sampleSize: 52 },
    { stageId: 'held', stageLabel: 'Held', color: '#6366F1', averageDays: 14, averageHours: 336, sampleSize: 28 }
  ],
  periodStats: {
    week: { current: 47, previous: 38, change: 24, changeDirection: 'up', isAllTime: false },
    month: { current: 189, previous: 156, change: 21, changeDirection: 'up', isAllTime: false },
    quarter: { current: 512, previous: 478, change: 7, changeDirection: 'up', isAllTime: false },
    year: { current: 847, previous: 623, change: 36, changeDirection: 'up', isAllTime: false },
    all: { current: 847, previous: null, change: null, changeDirection: null, isAllTime: true }
  }
};

const DEMO_VERIFICATION_DATA = {
  totalVerified: 142,
  averageTurnaroundDays: 4.2,
  averageTurnaroundHours: 101,
  outstandingVerifications: 56,
  verifiedThisPeriod: {
    week: { current: 12, previous: 9, change: 33, changeDirection: 'up' },
    month: { current: 48, previous: 41, change: 17, changeDirection: 'up' },
    quarter: { current: 112, previous: 98, change: 14, changeDirection: 'up' },
    year: { current: 142, previous: 108, change: 31, changeDirection: 'up' },
    all: { current: 142, previous: null, change: null, changeDirection: null }
  },
  turnaroundBreakdown: [
    { range: '0-2 days', count: 42, percentage: 30 },
    { range: '3-5 days', count: 58, percentage: 41 },
    { range: '6-10 days', count: 28, percentage: 20 },
    { range: '11+ days', count: 14, percentage: 9 }
  ],
  outstandingByAge: [
    { range: '0-2 days', count: 18, percentage: 32 },
    { range: '3-5 days', count: 22, percentage: 39 },
    { range: '6-10 days', count: 12, percentage: 22 },
    { range: '11+ days', count: 4, percentage: 7 }
  ]
};

function ApplicationFunnelReportCard({ period, onPeriodChange, demoMode }) {
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/application-funnel-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/application-funnel-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_FUNNEL_DATA : stats;
  const periodData = effectiveStats?.periodStats?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && !periodData?.isAllTime;
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-funnel-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-funnel-error">
        <p className="text-muted-foreground" data-testid="text-funnel-error-message">Failed to load application funnel data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-funnel-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const stageBreakdown = effectiveStats?.stageBreakdown || [];
  const conversionRates = effectiveStats?.conversionRates || [];
  const dropOffAnalysis = effectiveStats?.dropOffAnalysis || [];
  const averageTimePerStage = effectiveStats?.averageTimePerStage || [];
  const totalApplications = effectiveStats?.totalApplications || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={period} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-40" data-testid="select-funnel-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value} data-testid={`select-funnel-period-${opt.value}`}>
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
            data-testid="button-refresh-funnel"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="container-funnel-stats-grid">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-total-applications">Total Applications</p>
          <p className="text-3xl font-bold" data-testid="text-total-applications">{totalApplications.toLocaleString()}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-stages-count">Workflow Stages</p>
          <p className="text-3xl font-bold" data-testid="text-stages-count">{stageBreakdown.length}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-avg-conversion">Avg. Conversion</p>
          <p className="text-3xl font-bold text-green-600" data-testid="text-avg-conversion">
            {conversionRates.length > 0 
              ? `${Math.round(conversionRates.reduce((a, b) => a + b.rate, 0) / conversionRates.length)}%`
              : '--'}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground" data-testid="label-period-applications">This Period</p>
          <p className="text-3xl font-bold" data-testid="text-period-applications">
            {periodData?.current?.toLocaleString() || 0}
          </p>
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
              {periodData.current} new applications (was {periodData.previous})
            </p>
          </div>
        </div>
      )}

      {stageBreakdown.length > 0 && (
        <div className="space-y-4" data-testid="container-stage-breakdown">
          <h4 className="text-sm font-medium text-muted-foreground">Applications by Stage</h4>
          <div className="space-y-3">
            {stageBreakdown.map((stage, idx) => (
              <div key={stage.id} className="space-y-1" data-testid={`row-stage-${stage.id}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-3 h-3 rounded-full" 
                      style={{ backgroundColor: stage.color }}
                    />
                    <span className="text-sm font-medium">{stage.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" data-testid={`badge-stage-count-${stage.id}`}>
                      {stage.count}
                    </Badge>
                    <span className="text-xs text-muted-foreground w-12 text-right">
                      {stage.percentage}%
                    </span>
                  </div>
                </div>
                <Progress 
                  value={stage.percentage} 
                  className="h-2"
                  style={{ 
                    '--progress-background': stage.color 
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {conversionRates.length > 0 && (
        <div className="space-y-4" data-testid="container-conversion-rates">
          <h4 className="text-sm font-medium text-muted-foreground">Stage-to-Stage Conversion Rates</h4>
          <div className="space-y-2">
            {conversionRates.map((conv, idx) => (
              <div 
                key={`${conv.fromStageId}-${conv.toStageId}`} 
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/30"
                data-testid={`row-conversion-${idx}`}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm truncate">{conv.fromStage}</span>
                  <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm truncate">{conv.toStage}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {conv.toCount} / {conv.fromCount}
                  </span>
                  <Badge 
                    variant={conv.rate >= 70 ? 'default' : conv.rate >= 40 ? 'secondary' : 'outline'}
                    className={conv.rate >= 70 ? 'bg-green-600' : conv.rate >= 40 ? '' : 'border-orange-500 text-orange-600'}
                    data-testid={`badge-conversion-rate-${idx}`}
                  >
                    {conv.rate}%
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {dropOffAnalysis.length > 0 && (
        <div className="space-y-4" data-testid="container-dropoff-analysis">
          <h4 className="text-sm font-medium text-muted-foreground">Drop-off Analysis</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dropOffAnalysis} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis 
                  dataKey="stageLabel" 
                  type="category" 
                  tick={{ fontSize: 11 }}
                  width={100}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value, name) => {
                    const labels = {
                      entered: 'Entered Stage',
                      exited: 'Moved Forward',
                      currentlyAt: 'Currently Here'
                    };
                    return [value, labels[name] || name];
                  }}
                />
                <Bar dataKey="entered" fill="hsl(var(--primary))" name="entered" />
                <Bar dataKey="currentlyAt" fill="hsl(var(--chart-2))" name="currentlyAt" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {dropOffAnalysis.filter(d => d.dropOffRate > 30).slice(0, 4).map((stage, idx) => (
              <div 
                key={stage.stageId}
                className="p-2 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800"
                data-testid={`card-high-dropoff-${idx}`}
              >
                <div className="flex items-center gap-1 mb-1">
                  <AlertTriangle className="w-3 h-3 text-orange-600" />
                  <span className="text-xs font-medium text-orange-700 dark:text-orange-400">High Drop-off</span>
                </div>
                <p className="text-sm font-medium truncate">{stage.stageLabel}</p>
                <p className="text-xs text-muted-foreground">{stage.dropOffRate}% don't proceed</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {averageTimePerStage.length > 0 && (
        <div className="space-y-4" data-testid="container-time-per-stage">
          <h4 className="text-sm font-medium text-muted-foreground">Average Time per Stage</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {averageTimePerStage.map((stage, idx) => (
              <div 
                key={stage.stageId}
                className="p-3 rounded-lg bg-muted/30"
                data-testid={`card-time-stage-${idx}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div 
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: stage.color }}
                  />
                  <span className="text-sm font-medium truncate">{stage.stageLabel}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <span className="text-lg font-bold">
                    {stage.averageDays >= 1 
                      ? `${stage.averageDays}d` 
                      : stage.averageHours >= 1 
                        ? `${Math.round(stage.averageHours)}h`
                        : '--'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Based on {stage.sampleSize} applications
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {stageBreakdown.length > 0 && (
        <div className="space-y-3" data-testid="container-funnel-chart">
          <h4 className="text-sm font-medium text-muted-foreground">Visual Funnel</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stageBreakdown}>
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
                  formatter={(value) => [value, 'Applications']}
                />
                <Bar dataKey="count" name="Applications">
                  {stageBreakdown.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color || 'hsl(var(--primary))'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function VerificationReportCard({ period, onPeriodChange, demoMode }) {
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/verification-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/verification-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_VERIFICATION_DATA : stats;
  const periodData = effectiveStats?.verifiedThisPeriod?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && period !== 'all';
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-verification-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-verification-error">
        <p className="text-muted-foreground" data-testid="text-verification-error-message">Failed to load verification data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-verification-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const totalVerified = effectiveStats?.totalVerified || 0;
  const averageTurnaroundDays = effectiveStats?.averageTurnaroundDays || 0;
  const outstandingVerifications = effectiveStats?.outstandingVerifications || 0;
  const turnaroundBreakdown = effectiveStats?.turnaroundBreakdown || [];
  const outstandingByAge = effectiveStats?.outstandingByAge || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={period} onValueChange={onPeriodChange}>
          <SelectTrigger className="w-40" data-testid="select-verification-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value} data-testid={`select-verification-period-${opt.value}`}>
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
            data-testid="button-refresh-verification"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="container-verification-stats-grid">
        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">Verified</span>
          </div>
          <p className="text-3xl font-bold text-green-700 dark:text-green-300" data-testid="text-total-verified">{totalVerified.toLocaleString()}</p>
          <p className="text-xs text-green-600/70 dark:text-green-400/70 mt-1">Total verified applications</p>
        </div>
        
        <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-5 h-5 text-blue-600" />
            <span className="text-sm font-medium text-blue-700 dark:text-blue-400">Avg. Turnaround</span>
          </div>
          <p className="text-3xl font-bold text-blue-700 dark:text-blue-300" data-testid="text-avg-turnaround">
            {averageTurnaroundDays.toFixed(1)} <span className="text-lg font-normal">days</span>
          </p>
          <p className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-1">From submission to verified</p>
        </div>
        
        <div className="p-4 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5 text-orange-600" />
            <span className="text-sm font-medium text-orange-700 dark:text-orange-400">Outstanding</span>
          </div>
          <p className="text-3xl font-bold text-orange-700 dark:text-orange-300" data-testid="text-outstanding-verifications">{outstandingVerifications.toLocaleString()}</p>
          <p className="text-xs text-orange-600/70 dark:text-orange-400/70 mt-1">Awaiting verification</p>
        </div>
      </div>

      {hasValidComparison && periodData && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-verification-period-comparison">
          <div className={`p-2 rounded-full ${isPositive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            {isPositive ? (
              <TrendingUp className="w-5 h-5 text-green-600" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-600" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium" data-testid="text-verification-period-comparison">
              <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
                {isPositive ? '+' : ''}{changePercent}%
              </span>
              {' '}vs previous {period}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="text-verification-period-details">
              {periodData.current} verified (was {periodData.previous})
            </p>
          </div>
        </div>
      )}

      {turnaroundBreakdown.length > 0 && (
        <div className="space-y-4" data-testid="container-turnaround-breakdown">
          <h4 className="text-sm font-medium text-muted-foreground">Turnaround Time Distribution</h4>
          <div className="space-y-3">
            {turnaroundBreakdown.map((item, idx) => (
              <div key={item.range} className="space-y-1" data-testid={`row-turnaround-${idx}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{item.range}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" data-testid={`badge-turnaround-count-${idx}`}>
                      {item.count}
                    </Badge>
                    <span className="text-xs text-muted-foreground w-12 text-right">
                      {item.percentage}%
                    </span>
                  </div>
                </div>
                <Progress value={item.percentage} className="h-2" />
              </div>
            ))}
          </div>
        </div>
      )}

      {outstandingByAge.length > 0 && outstandingVerifications > 0 && (
        <div className="space-y-4" data-testid="container-outstanding-by-age">
          <h4 className="text-sm font-medium text-muted-foreground">Outstanding Verifications by Age</h4>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={outstandingByAge}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="range" 
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
                  formatter={(value) => [value, 'Pending']}
                />
                <Bar dataKey="count" fill="hsl(var(--chart-3))" name="Pending" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {outstandingByAge.filter(a => a.range === '11+ days' && a.count > 0).length > 0 && (
            <div className="p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800" data-testid="alert-overdue-verifications">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-orange-600" />
                <span className="text-sm font-medium text-orange-700 dark:text-orange-400">
                  {outstandingByAge.find(a => a.range === '11+ days')?.count || 0} verifications pending over 11 days
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DueDiligenceReports() {
  const { memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { tenantSlug } = useTenantBranding() || {};
  const [accessChecked, setAccessChecked] = useState(false);
  const [reportCards, setReportCards] = useState(DEFAULT_REPORT_CARDS);
  const [funnelPeriod, setFunnelPeriod] = useState('month');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  const storageKey = useMemo(() => 
    `${STORAGE_KEY_PREFIX}${tenantSlug || 'default'}_${memberInfo?.id || 'guest'}`,
    [tenantSlug, memberInfo?.id]
  );

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_DueDiligenceReports')) {
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
            const savedCardIds = new Set(parsed.reportCards.map(c => c.id));
            const mergedCards = [...parsed.reportCards];
            
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
          if (parsed.funnelPeriod) setFunnelPeriod(parsed.funnelPeriod);
          if (parsed.demoMode !== undefined) setDemoMode(parsed.demoMode);
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
          funnelPeriod,
          demoMode
        }));
      } catch (e) {
        console.error('Error saving dashboard preferences:', e);
      }
    }
  }, [reportCards, funnelPeriod, demoMode, storageKey, memberInfo?.id, tenantSlug]);

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
      case 'application-funnel':
        return (
          <ApplicationFunnelReportCard
            period={funnelPeriod}
            onPeriodChange={setFunnelPeriod}
            demoMode={demoMode}
          />
        );
      case 'verification':
        return (
          <VerificationReportCard
            period={funnelPeriod}
            onPeriodChange={setFunnelPeriod}
            demoMode={demoMode}
          />
        );
      default:
        return null;
    }
  };

  const getCardIcon = (cardId) => {
    switch (cardId) {
      case 'application-funnel':
        return <Filter className="w-5 h-5" />;
      case 'verification':
        return <CheckCircle2 className="w-5 h-5" />;
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
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <LayoutDashboard className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Due Diligence Reports</h1>
              <p className="text-sm text-muted-foreground">Application funnel analytics and insights</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border" data-testid="container-demo-toggle">
              <Switch
                id="demo-mode"
                checked={demoMode}
                onCheckedChange={setDemoMode}
                data-testid="switch-demo-mode"
              />
              <Label 
                htmlFor="demo-mode" 
                className="text-sm cursor-pointer"
                data-testid="label-demo-mode"
              >
                Demo Data
              </Label>
              {demoMode && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-demo-active">
                  Preview
                </Badge>
              )}
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
                <div className="space-y-3" data-testid="container-settings-cards">
                  {reportCards.map(card => (
                    <div key={card.id} className="flex items-center justify-between" data-testid={`row-settings-${card.id}`}>
                      <div className="flex items-center gap-2">
                        {getCardIcon(card.id)}
                        <Label htmlFor={`toggle-${card.id}`} className="cursor-pointer" data-testid={`label-card-${card.id}`}>
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
              </div>
            </PopoverContent>
          </Popover>
          </div>
        </div>

        {visibleCards.length === 0 ? (
          <Card data-testid="card-no-reports">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <EyeOff className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Reports Visible</h3>
              <p className="text-sm text-muted-foreground text-center mb-4">
                All report cards are hidden. Use the Customize button to show reports.
              </p>
              <Button variant="outline" onClick={() => setSettingsOpen(true)} data-testid="button-show-reports">
                <Eye className="w-4 h-4 mr-2" />
                Show Reports
              </Button>
            </CardContent>
          </Card>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="report-cards">
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
                          className={snapshot.isDragging ? 'opacity-90' : ''}
                        >
                          <Card data-testid={`card-report-${card.id}`}>
                            <CardHeader className="pb-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-3">
                                  <div
                                    {...provided.dragHandleProps}
                                    className="cursor-grab active:cursor-grabbing p-1 -m-1 rounded hover:bg-muted"
                                    data-testid={`drag-handle-${card.id}`}
                                  >
                                    <GripVertical className="w-5 h-5 text-muted-foreground" />
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {getCardIcon(card.id)}
                                    <CardTitle className="text-lg">{card.title}</CardTitle>
                                  </div>
                                </div>
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

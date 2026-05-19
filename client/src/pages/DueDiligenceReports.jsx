import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  AlertCircle,
  Calendar,
  Users,
  Target,
  Gavel,
  ThumbsUp,
  ThumbsDown,
  Pause,
  Download,
  ExternalLink,
  Info
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  FunnelChart,
  Funnel,
  LabelList,
  Cell
} from "recharts";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const STORAGE_KEY_PREFIX = 'dd_reports_dashboard_';

const DEFAULT_REPORT_CARDS = [
  { id: 'application-funnel', title: 'Application Funnel', visible: true, order: 0 },
  { id: 'verification', title: 'Verification', visible: true, order: 1 },
  { id: 'due-diligence', title: 'Due Diligence Meetings', visible: true, order: 2 },
  { id: 'decisions', title: 'Decisions', visible: true, order: 3 }
];

const PERIOD_OPTIONS = [
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom range' }
];

const DEFAULT_SLA = {
  verificationDays: 5,
  ddSchedulingDays: 10,
  decisionDays: 14
};

// ---------- Filter helpers ----------
function buildQueryString(filters) {
  const params = new URLSearchParams();
  if (filters.formId && filters.formId !== 'all') params.set('formId', filters.formId);
  if (filters.period) params.set('period', filters.period);
  if (filters.period === 'custom') {
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function buildDashboardLink(extra) {
  const params = new URLSearchParams();
  Object.entries(extra || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== 'all') params.set(k, String(v));
  });
  const base = createPageUrl('DueDiligenceDashboard');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function downloadCsv(reportType, filters) {
  const params = new URLSearchParams();
  params.set('reportType', reportType);
  if (filters.formId && filters.formId !== 'all') params.set('formId', filters.formId);
  if (filters.period) params.set('period', filters.period);
  if (filters.period === 'custom') {
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
  }
  const url = `/api/reports/export?${params.toString()}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${reportType}-report.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------- Demo data ----------
const DEMO_FUNNEL_DATA = {
  totalApplications: 847,
  allStages: [
    { id: 'new', label: 'New', color: '#3B82F6' },
    { id: 'in-review', label: 'In Review', color: '#F59E0B' },
    { id: 'verified', label: 'Verified', color: '#10B981' },
    { id: 'dd-meet-attended', label: 'DD Meet Attended', color: '#8B5CF6' },
    { id: 'held', label: 'Held', color: '#6366F1' },
    { id: 'approved', label: 'Approved', color: '#22C55E' },
    { id: 'rejected', label: 'Rejected', color: '#EF4444' },
    { id: 'incomplete', label: 'Incomplete', color: '#9CA3AF' }
  ],
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
    all: { current: 847, previous: null, change: null, changeDirection: null, isAllTime: true },
    custom: { current: 189, previous: null, change: null, changeDirection: null, isAllTime: false }
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
    all: { current: 142, previous: null, change: null, changeDirection: null },
    custom: { current: 48, previous: null, change: null, changeDirection: null }
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
  ],
  monthlyTrend: [
    { month: 'Aug', verified: 14, submitted: 22 },
    { month: 'Sep', verified: 19, submitted: 26 },
    { month: 'Oct', verified: 23, submitted: 31 },
    { month: 'Nov', verified: 28, submitted: 38 },
    { month: 'Dec', verified: 31, submitted: 41 },
    { month: 'Jan', verified: 27, submitted: 36 }
  ],
  perDocumentStats: {
    totalDocuments: 412,
    averageTurnaroundDays: 2.3,
    byStatus: [
      { status: 'approved', count: 281, percentage: 68 },
      { status: 'pending', count: 87, percentage: 21 },
      { status: 'rejected', count: 32, percentage: 8 },
      { status: 'aged', count: 12, percentage: 3 }
    ],
    byField: [
      { field: 'proof_of_identity', total: 142, approved: 118, pending: 18, rejected: 6 },
      { field: 'proof_of_address', total: 138, approved: 102, pending: 28, rejected: 8 },
      { field: 'business_registration', total: 84, approved: 38, pending: 32, rejected: 14 },
      { field: 'financial_statements', total: 48, approved: 23, pending: 21, rejected: 4 }
    ]
  },
  reviewerBreakdown: [
    { reviewer: 'alice@example.com', verifiedCount: 38, averageTurnaroundDays: 2.1 },
    { reviewer: 'bob@example.com', verifiedCount: 42, averageTurnaroundDays: 4.6 },
    { reviewer: 'carol@example.com', verifiedCount: 31, averageTurnaroundDays: 3.4 },
    { reviewer: 'dave@example.com', verifiedCount: 18, averageTurnaroundDays: 6.8 }
  ],
  slaBreaches: { thresholdDays: 5, breachedCount: 8 }
};

const DEMO_DD_REPORT_DATA = {
  scheduledMeetings: 112,
  completedMeetings: 89,
  completionRate: 79,
  averageSchedulingDays: 8.5,
  averageSchedulingHours: 204,
  pendingOutcomes: 37,
  outcomes: {
    held: { count: 52, percentage: 58 },
    approved: { count: 28, percentage: 32 },
    rejected: { count: 9, percentage: 10 }
  },
  outcomesByPeriod: {
    week: { scheduled: 14, completed: 11, completionRate: 79, change: 22, changeDirection: 'up' },
    month: { scheduled: 48, completed: 38, completionRate: 79, change: 15, changeDirection: 'up' },
    quarter: { scheduled: 89, completed: 72, completionRate: 81, change: 8, changeDirection: 'up' },
    year: { scheduled: 112, completed: 89, completionRate: 79, change: 24, changeDirection: 'up' },
    all: { scheduled: 112, completed: 89, completionRate: 79, change: null, changeDirection: null },
    custom: { scheduled: 48, completed: 38, completionRate: 79, change: null, changeDirection: null }
  },
  scoreDistribution: [
    { range: '0-25', label: 'Low', color: '#EF4444', count: 8, percentage: 9 },
    { range: '26-50', label: 'Medium-Low', color: '#F59E0B', count: 18, percentage: 20 },
    { range: '51-75', label: 'Medium-High', color: '#84CC16', count: 32, percentage: 36 },
    { range: '76-100', label: 'High', color: '#22C55E', count: 31, percentage: 35 }
  ],
  riskLevelDistribution: [
    { level: 'low', count: 41, percentage: 46, color: '#22C55E' },
    { level: 'medium', count: 28, percentage: 31, color: '#F59E0B' },
    { level: 'high', count: 15, percentage: 17, color: '#EF4444' },
    { level: 'critical', count: 5, percentage: 6, color: '#7F1D1D' }
  ],
  schedulingTimeBreakdown: [
    { range: '0-5 days', count: 24, percentage: 27 },
    { range: '6-10 days', count: 38, percentage: 43 },
    { range: '11-15 days', count: 18, percentage: 20 },
    { range: '16+ days', count: 9, percentage: 10 }
  ],
  monthlyThroughput: [
    { month: 'Aug', scheduled: 16, completed: 12 },
    { month: 'Sep', scheduled: 19, completed: 15 },
    { month: 'Oct', scheduled: 22, completed: 18 },
    { month: 'Nov', scheduled: 24, completed: 19 },
    { month: 'Dec', scheduled: 18, completed: 14 },
    { month: 'Jan', scheduled: 13, completed: 11 }
  ],
  meetingMetrics: {
    totalRequests: 124,
    booked: 96,
    pending: 8,
    expired: 12,
    cancelled: 8,
    noShow: 4,
    rescheduled: 11,
    completed: 89,
    averageLeadTimeHours: 86,
    averageBookingTimeHours: 38,
    verifiedToBookedHours: 42,
    verifiedToBookedSampleSize: 96,
    bookedToHeldHours: 30,
    bookedToHeldSampleSize: 89
  },
  slaBreaches: { thresholdDays: 10, breachedCount: 5 },
  heldDisambiguation: { 'demo-form-1': 'meeting' }
};

const DEMO_DECISIONS_DATA = {
  totalDecisions: 98,
  approved: { count: 28, percentage: 29 },
  declined: { count: 18, percentage: 18 },
  onHold: { count: 52, percentage: 53 },
  decisionsByPeriod: {
    week: {
      approved: { current: 4, previous: 3, change: 33, changeDirection: 'up' },
      declined: { current: 2, previous: 3, change: 33, changeDirection: 'down' },
      onHold: { current: 6, previous: 5, change: 20, changeDirection: 'up' },
      total: { current: 12, previous: 11, change: 9, changeDirection: 'up' }
    },
    month: {
      approved: { current: 12, previous: 10, change: 20, changeDirection: 'up' },
      declined: { current: 7, previous: 8, change: 13, changeDirection: 'down' },
      onHold: { current: 22, previous: 18, change: 22, changeDirection: 'up' },
      total: { current: 41, previous: 36, change: 14, changeDirection: 'up' }
    },
    quarter: {
      approved: { current: 22, previous: 18, change: 22, changeDirection: 'up' },
      declined: { current: 14, previous: 16, change: 13, changeDirection: 'down' },
      onHold: { current: 42, previous: 38, change: 11, changeDirection: 'up' },
      total: { current: 78, previous: 72, change: 8, changeDirection: 'up' }
    },
    year: {
      approved: { current: 28, previous: 21, change: 33, changeDirection: 'up' },
      declined: { current: 18, previous: 22, change: 18, changeDirection: 'down' },
      onHold: { current: 52, previous: 45, change: 16, changeDirection: 'up' },
      total: { current: 98, previous: 88, change: 11, changeDirection: 'up' }
    },
    all: {
      approved: { current: 28, previous: null, change: null, changeDirection: null },
      declined: { current: 18, previous: null, change: null, changeDirection: null },
      onHold: { current: 52, previous: null, change: null, changeDirection: null },
      total: { current: 98, previous: null, change: null, changeDirection: null }
    },
    custom: {
      approved: { current: 12, previous: null, change: null, changeDirection: null },
      declined: { current: 7, previous: null, change: null, changeDirection: null },
      onHold: { current: 22, previous: null, change: null, changeDirection: null },
      total: { current: 41, previous: null, change: null, changeDirection: null }
    }
  },
  monthlyTrend: [
    { month: 'Aug', approved: 2, declined: 1, onHold: 4 },
    { month: 'Sep', approved: 3, declined: 2, onHold: 5 },
    { month: 'Oct', approved: 4, declined: 3, onHold: 6 },
    { month: 'Nov', approved: 5, declined: 4, onHold: 8 },
    { month: 'Dec', approved: 6, declined: 3, onHold: 12 },
    { month: 'Jan', approved: 8, declined: 5, onHold: 17 }
  ],
  averageTimeToDecision: {
    approved: 18.5,
    declined: 12.3,
    onHold: 8.2
  },
  scoreVsOutcome: [
    { outcome: 'approved', label: 'Approved', averageScore: 82.4, count: 28 },
    { outcome: 'declined', label: 'Declined', averageScore: 41.2, count: 18 },
    { outcome: 'onHold', label: 'On Hold', averageScore: 64.7, count: 50 }
  ],
  avgScoreByOutcome: {
    approved: { average: 82.4, count: 28 },
    declined: { average: 41.2, count: 18 },
    onHold: { average: 64.7, count: 50 }
  },
  slaBreaches: { thresholdDays: 14, breachedCount: 6 },
  decisionsByReviewer: [
    { reviewer: 'alice@example.com', approved: 11, declined: 4, onHold: 18, total: 33 },
    { reviewer: 'bob@example.com', approved: 9, declined: 8, onHold: 14, total: 31 },
    { reviewer: 'carol@example.com', approved: 6, declined: 4, onHold: 12, total: 22 },
    { reviewer: 'dave@example.com', approved: 2, declined: 2, onHold: 8, total: 12 }
  ]
};

// ---------- Filter bar ----------
function ReportFilterBar({ filters, onChange, forms, formsLoading }) {
  const updateField = (field, value) => onChange({ ...filters, [field]: value });

  return (
    <Card data-testid="card-report-filters">
      <CardContent className="p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <Label className="text-xs text-muted-foreground" htmlFor="filter-form">Form</Label>
            <Select value={filters.formId} onValueChange={(v) => updateField('formId', v)}>
              <SelectTrigger id="filter-form" data-testid="select-filter-form">
                <SelectValue placeholder={formsLoading ? 'Loading…' : 'All forms'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" data-testid="select-filter-form-all">All forms</SelectItem>
                {(forms || []).map((f) => (
                  <SelectItem key={f.form_id} value={f.form_id} data-testid={`select-filter-form-${f.form_id}`}>
                    {f.form_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[170px]">
            <Label className="text-xs text-muted-foreground" htmlFor="filter-period">Period</Label>
            <Select value={filters.period} onValueChange={(v) => updateField('period', v)}>
              <SelectTrigger id="filter-period" data-testid="select-filter-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} data-testid={`select-filter-period-${opt.value}`}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filters.period === 'custom' && (
            <>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="filter-start-date">Start date</Label>
                <Input
                  id="filter-start-date"
                  type="date"
                  value={filters.startDate || ''}
                  onChange={(e) => updateField('startDate', e.target.value)}
                  data-testid="input-filter-start-date"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground" htmlFor="filter-end-date">End date</Label>
                <Input
                  id="filter-end-date"
                  type="date"
                  value={filters.endDate || ''}
                  onChange={(e) => updateField('endDate', e.target.value)}
                  data-testid="input-filter-end-date"
                />
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- SLA & export header strip used by each card ----------
function CardActionBar({ slaLabel, slaValue, onSlaChange, onExport, onRefresh, isFetching, demoMode, testIdPrefix, dashboardLink }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {slaLabel && (
          <div className="flex items-center gap-2 px-2 py-1 rounded-md border bg-muted/30">
            <Label className="text-xs text-muted-foreground whitespace-nowrap" htmlFor={`${testIdPrefix}-sla-input`}>
              {slaLabel}
            </Label>
            <Input
              id={`${testIdPrefix}-sla-input`}
              type="number"
              min="0"
              value={slaValue}
              onChange={(e) => onSlaChange(parseInt(e.target.value, 10) || 0)}
              className="h-7 w-16"
              data-testid={`input-${testIdPrefix}-sla`}
            />
            <span className="text-xs text-muted-foreground">days</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {dashboardLink && (
          <Button
            variant="ghost"
            size="sm"
            asChild
            data-testid={`link-${testIdPrefix}-dashboard`}
          >
            <a href={dashboardLink}>
              <ExternalLink className="w-3.5 h-3.5 mr-1" />
              Open dashboard
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onExport}
          data-testid={`button-${testIdPrefix}-export`}
        >
          <Download className="w-3.5 h-3.5 mr-1" />
          Export CSV
        </Button>
        {!demoMode && onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={isFetching}
            data-testid={`button-refresh-${testIdPrefix}`}
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- Synopsis cards row ----------
function SynopsisCardsRow({ demoMode, filters, onCardClick }) {
  const qs = buildQueryString(filters);

  const queryOpts = (key, demoVal) => ({
    queryKey: ['/api/reports/' + key, filters],
    queryFn: () => apiRequest('GET', `/api/reports/${key}${qs}`),
    staleTime: 60000,
    enabled: !demoMode
  });

  const { data: funnelStats, isLoading: funnelLoading } = useQuery(queryOpts('application-funnel-stats'));
  const { data: verificationStats, isLoading: verificationLoading } = useQuery(queryOpts('verification-stats'));
  const { data: ddStats, isLoading: ddLoading } = useQuery(queryOpts('due-diligence-stats'));
  const { data: decisionsStats, isLoading: decisionsLoading } = useQuery(queryOpts('decisions-stats'));

  const funnel = demoMode ? DEMO_FUNNEL_DATA : funnelStats;
  const verification = demoMode ? DEMO_VERIFICATION_DATA : verificationStats;
  const dd = demoMode ? DEMO_DD_REPORT_DATA : ddStats;
  const decisions = demoMode ? DEMO_DECISIONS_DATA : decisionsStats;

  const funnelConversion = funnel?.conversionRates?.length > 0
    ? funnel.conversionRates[funnel.conversionRates.length - 1]?.rate || 0
    : 0;

  const cards = [
    {
      id: 'application-funnel',
      title: 'Applications',
      icon: Filter,
      value: funnelLoading && !demoMode ? '—' : (funnel?.totalApplications?.toLocaleString() || '0'),
      subValue: funnelLoading && !demoMode ? 'Loading...' : `${funnelConversion}% to final stage`,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50 dark:bg-blue-900/20',
      borderColor: 'border-blue-200 dark:border-blue-800',
      loading: funnelLoading && !demoMode
    },
    {
      id: 'verification',
      title: 'Verified',
      icon: CheckCircle2,
      value: verificationLoading && !demoMode ? '—' : (verification?.totalVerified?.toLocaleString() || '0'),
      subValue: verificationLoading && !demoMode ? 'Loading...' : `${(verification?.averageTurnaroundDays ?? 0).toFixed(1)} days avg`,
      color: 'text-green-600',
      bgColor: 'bg-green-50 dark:bg-green-900/20',
      borderColor: 'border-green-200 dark:border-green-800',
      loading: verificationLoading && !demoMode
    },
    {
      id: 'due-diligence',
      title: 'DD Meetings',
      icon: Calendar,
      value: ddLoading && !demoMode ? '—' : (dd?.completedMeetings?.toLocaleString() || '0'),
      subValue: ddLoading && !demoMode ? 'Loading...' : `${dd?.completionRate || 0}% completed`,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50 dark:bg-purple-900/20',
      borderColor: 'border-purple-200 dark:border-purple-800',
      loading: ddLoading && !demoMode
    },
    {
      id: 'decisions',
      title: 'Decisions',
      icon: Gavel,
      value: decisionsLoading && !demoMode ? '—' : (decisions?.totalDecisions?.toLocaleString() || '0'),
      subValue: decisionsLoading && !demoMode ? 'Loading...' : `${decisions?.approved?.percentage || 0}% approved`,
      color: 'text-amber-700',
      bgColor: 'bg-amber-50 dark:bg-amber-900/20',
      borderColor: 'border-amber-200 dark:border-amber-800',
      loading: decisionsLoading && !demoMode
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="container-synopsis-cards">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card
            key={card.id}
            className={`cursor-pointer transition-all hover:shadow-md ${card.bgColor} ${card.borderColor}`}
            onClick={() => onCardClick(card.id)}
            data-testid={`synopsis-card-${card.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 flex-1 min-w-0">
                  <p className={`text-xs font-medium ${card.color}`} data-testid={`synopsis-title-${card.id}`}>
                    {card.title}
                  </p>
                  <p className="text-2xl font-bold truncate" data-testid={`synopsis-value-${card.id}`}>
                    {card.value}
                  </p>
                  <p className="text-xs text-muted-foreground truncate" data-testid={`synopsis-subvalue-${card.id}`}>
                    {card.subValue}
                  </p>
                </div>
                <div className={`p-2 rounded-lg ${card.bgColor}`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ---------- Application Funnel ----------
function ApplicationFunnelReportCard({ filters, demoMode }) {
  const qs = buildQueryString(filters);
  const [chartMode, setChartMode] = useState('bar'); // 'bar' | 'funnel'
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/application-funnel-stats', filters],
    queryFn: () => apiRequest('GET', `/api/reports/application-funnel-stats${qs}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_FUNNEL_DATA : stats;
  const period = filters.period;
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

  const dashLink = (statusId) => buildDashboardLink({ formId: filters.formId, status: statusId });

  return (
    <div className="space-y-6">
      <CardActionBar
        onExport={() => downloadCsv('funnel', filters)}
        onRefresh={() => refetch()}
        isFetching={isFetching}
        demoMode={demoMode}
        testIdPrefix="funnel"
        dashboardLink={buildDashboardLink({ formId: filters.formId })}
      />

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
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-muted-foreground">Applications by Stage</h4>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={chartMode === 'bar' ? 'default' : 'outline'}
                onClick={() => setChartMode('bar')}
                data-testid="button-chart-mode-bar"
              >
                Bars
              </Button>
              <Button
                size="sm"
                variant={chartMode === 'funnel' ? 'default' : 'outline'}
                onClick={() => setChartMode('funnel')}
                data-testid="button-chart-mode-funnel"
              >
                Funnel
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            {stageBreakdown.map((stage) => (
              <a
                key={stage.id}
                href={dashLink(stage.id)}
                className="block space-y-1 hover-elevate rounded-md p-1"
                data-testid={`row-stage-${stage.id}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
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
                <Progress value={stage.percentage} className="h-2" />
              </a>
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
                <YAxis dataKey="stageLabel" type="category" tick={{ fontSize: 11 }} width={100} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value, name) => {
                    const labels = { entered: 'Entered Stage', exited: 'Moved Forward', currentlyAt: 'Currently Here' };
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
              <a
                key={stage.stageId}
                href={dashLink(stage.stageId)}
                className="block p-2 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
                data-testid={`card-high-dropoff-${idx}`}
              >
                <div className="flex items-center gap-1 mb-1">
                  <AlertTriangle className="w-3 h-3 text-orange-600" />
                  <span className="text-xs font-medium text-orange-700 dark:text-orange-700">High Drop-off</span>
                </div>
                <p className="text-sm font-medium truncate">{stage.stageLabel}</p>
                <p className="text-xs text-muted-foreground">{stage.dropOffRate}% don't proceed</p>
              </a>
            ))}
          </div>
        </div>
      )}

      {averageTimePerStage.length > 0 && (
        <div className="space-y-4" data-testid="container-time-per-stage">
          <h4 className="text-sm font-medium text-muted-foreground">Average Time per Stage</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {averageTimePerStage.map((stage, idx) => (
              <div key={stage.stageId} className="p-3 rounded-lg bg-muted/30" data-testid={`card-time-stage-${idx}`}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stage.color }} />
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
                <p className="text-xs text-muted-foreground mt-1">Based on {stage.sampleSize} applications</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {stageBreakdown.length > 0 && (
        <div className="space-y-3" data-testid="container-funnel-chart">
          <h4 className="text-sm font-medium text-muted-foreground">
            {chartMode === 'funnel' ? 'Visual Funnel' : 'Visual Bars'}
          </h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {chartMode === 'funnel' ? (
                <FunnelChart>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Funnel dataKey="count" nameKey="label" data={stageBreakdown} isAnimationActive>
                    <LabelList position="right" dataKey="label" stroke="none" />
                    {stageBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color || 'hsl(var(--primary))'} />
                    ))}
                  </Funnel>
                </FunnelChart>
              ) : (
                <BarChart data={stageBreakdown}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" allowDecimals={false} />
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
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Verification ----------
function VerificationReportCard({ filters, demoMode, slaDays, onSlaChange }) {
  const qsBase = buildQueryString(filters);
  const slaDaysNum = Number(slaDays) || 0;
  const qs = qsBase
    ? `${qsBase}&slaDays=${slaDaysNum}`
    : `?slaDays=${slaDaysNum}`;
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/verification-stats', filters, slaDaysNum],
    queryFn: () => apiRequest('GET', `/api/reports/verification-stats${qs}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_VERIFICATION_DATA : stats;
  const period = filters.period;
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
  const monthlyTrend = effectiveStats?.monthlyTrend || [];
  const perDocumentStats = effectiveStats?.perDocumentStats || { byStatus: [], byField: [], averageTurnaroundDays: 0, totalDocuments: 0 };
  const reviewerBreakdown = effectiveStats?.reviewerBreakdown || [];

  const slaBreached = averageTurnaroundDays > slaDays;

  return (
    <div className="space-y-6">
      <CardActionBar
        slaLabel="SLA"
        slaValue={slaDays}
        onSlaChange={onSlaChange}
        onExport={() => downloadCsv('verification', filters)}
        onRefresh={() => refetch()}
        isFetching={isFetching}
        demoMode={demoMode}
        testIdPrefix="verification"
        dashboardLink={buildDashboardLink({ formId: filters.formId, status: 'in-review' })}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="container-verification-stats-grid">
        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">Verified</span>
          </div>
          <p className="text-3xl font-bold text-green-700 dark:text-green-300" data-testid="text-total-verified">{totalVerified.toLocaleString()}</p>
          <p className="text-xs text-green-600/70 dark:text-green-400/70 mt-1">Total verified applications</p>
        </div>

        <div className={`p-4 rounded-lg border ${slaBreached ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Clock className={`w-5 h-5 ${slaBreached ? 'text-orange-600' : 'text-blue-600'}`} />
            <span className={`text-sm font-medium ${slaBreached ? 'text-orange-700 dark:text-orange-700' : 'text-blue-700 dark:text-blue-400'}`}>
              Avg. Turnaround
            </span>
            {slaBreached && <Badge variant="outline" className="border-orange-500 text-orange-600 ml-auto" data-testid="badge-verification-sla-breached">SLA breach</Badge>}
          </div>
          <p className={`text-3xl font-bold ${slaBreached ? 'text-orange-700 dark:text-orange-300' : 'text-blue-700 dark:text-blue-300'}`} data-testid="text-avg-turnaround">
            {averageTurnaroundDays.toFixed(1)} <span className="text-lg font-normal">days</span>
          </p>
          <p className={`text-xs mt-1 ${slaBreached ? 'text-orange-600/70 dark:text-orange-700/70' : 'text-blue-600/70 dark:text-blue-400/70'}`}>
            SLA threshold: {slaDays} days
          </p>
        </div>

        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'in-review', outstandingDays: slaDays })}
          className="block p-4 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
          data-testid="link-outstanding-verifications"
        >
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5 text-orange-600" />
            <span className="text-sm font-medium text-orange-700 dark:text-orange-700">Outstanding</span>
            <ExternalLink className="w-3 h-3 text-orange-600 ml-auto" />
          </div>
          <p className="text-3xl font-bold text-orange-700 dark:text-orange-300" data-testid="text-outstanding-verifications">{outstandingVerifications.toLocaleString()}</p>
          <p className="text-xs text-orange-600/70 dark:text-orange-700/70 mt-1">Awaiting verification</p>
        </a>
      </div>

      {effectiveStats?.slaBreaches && slaDaysNum > 0 && (
        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'in-review', outstandingDays: slaDaysNum })}
          className="flex items-center gap-3 p-4 rounded-md bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
          data-testid="link-verification-sla-breaches"
        >
          <AlertCircle className="w-5 h-5 text-orange-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-orange-700 dark:text-orange-700">
              <span className="text-2xl font-bold mr-2" data-testid="text-verification-sla-breach-count">
                {(effectiveStats.slaBreaches.breachedCount || 0).toLocaleString()}
              </span>
              outstanding longer than {slaDaysNum} days
            </p>
            <p className="text-xs text-orange-600/70 dark:text-orange-700/70">Open in dashboard to review</p>
          </div>
          <ExternalLink className="w-4 h-4 text-orange-600" />
        </a>
      )}

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

      {monthlyTrend.length > 0 && (
        <div className="space-y-3" data-testid="container-verification-monthly-trend">
          <h4 className="text-sm font-medium text-muted-foreground">Monthly Trend (Verified vs Submitted)</h4>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="submitted" stroke="hsl(var(--chart-2))" name="Submitted" strokeWidth={2} />
                <Line type="monotone" dataKey="verified" stroke="hsl(var(--chart-1))" name="Verified" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
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
                    <Badge variant="secondary" data-testid={`badge-turnaround-count-${idx}`}>{item.count}</Badge>
                    <span className="text-xs text-muted-foreground w-12 text-right">{item.percentage}%</span>
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
                <XAxis dataKey="range" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                  formatter={(value) => [value, 'Pending']}
                />
                <Bar dataKey="count" fill="hsl(var(--chart-3))" name="Pending" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {outstandingByAge.filter(a => a.range === '11+ days' && a.count > 0).length > 0 && (
            <a
              href={buildDashboardLink({ formId: filters.formId, status: 'in-review', outstandingDays: 11 })}
              className="block p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
              data-testid="alert-overdue-verifications"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-orange-600" />
                <span className="text-sm font-medium text-orange-700 dark:text-orange-700">
                  {outstandingByAge.find(a => a.range === '11+ days')?.count || 0} verifications pending over 11 days
                </span>
                <ExternalLink className="w-3 h-3 text-orange-600 ml-auto" />
              </div>
            </a>
          )}
        </div>
      )}

      {(perDocumentStats.totalDocuments > 0 || (perDocumentStats.byStatus || []).length > 0) && (
        <div className="space-y-4" data-testid="container-per-document-stats">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Per-Document Stats ({perDocumentStats.totalDocuments} docs · {perDocumentStats.averageTurnaroundDays} day avg)
          </h4>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              {(perDocumentStats.byStatus || []).map((item) => (
                <div key={item.status} className="flex items-center justify-between p-2 rounded bg-muted/30" data-testid={`row-doc-status-${item.status}`}>
                  <span className="text-sm capitalize">{item.status}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{item.count}</Badge>
                    <span className="text-xs text-muted-foreground w-10 text-right">{item.percentage}%</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Top fields by volume</p>
              {(perDocumentStats.byField || []).slice(0, 5).map((field) => (
                <div key={field.field} className="flex items-center justify-between p-2 rounded bg-muted/30" data-testid={`row-doc-field-${field.field}`}>
                  <span className="text-sm truncate">{field.field}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="bg-green-50 dark:bg-green-900/20 border-green-200">{field.approved}</Badge>
                    <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/20 border-amber-200">{field.pending}</Badge>
                    <Badge variant="outline" className="bg-red-50 dark:bg-red-900/20 border-red-200">{field.rejected}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {reviewerBreakdown.length > 0 && (
        <div className="space-y-3" data-testid="container-reviewer-breakdown">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users className="w-4 h-4" />
            Reviewer Performance
          </h4>
          <div className="space-y-2">
            {reviewerBreakdown.slice(0, 8).map((rev) => {
              const breached = rev.averageTurnaroundDays > slaDays;
              return (
                <a
                  key={rev.reviewer}
                  href={buildDashboardLink({ formId: filters.formId, reviewer: rev.reviewer })}
                  className="flex items-center justify-between p-2 rounded-md bg-muted/30 hover-elevate"
                  data-testid={`row-reviewer-${rev.reviewer}`}
                >
                  <span className="text-sm truncate flex-1">{rev.reviewer}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{rev.verifiedCount}</Badge>
                    <Badge
                      variant="outline"
                      className={breached ? 'border-orange-500 text-orange-600' : ''}
                      data-testid={`badge-reviewer-turnaround-${rev.reviewer}`}
                    >
                      {rev.averageTurnaroundDays.toFixed(1)}d
                    </Badge>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Due Diligence Meetings ----------
function DueDiligenceReportCard({ filters, demoMode, slaDays, onSlaChange }) {
  const qsBase = buildQueryString(filters);
  const slaDaysNum = Number(slaDays) || 0;
  const qs = qsBase
    ? `${qsBase}&slaDays=${slaDaysNum}`
    : `?slaDays=${slaDaysNum}`;
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/due-diligence-stats', filters, slaDaysNum],
    queryFn: () => apiRequest('GET', `/api/reports/due-diligence-stats${qs}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_DD_REPORT_DATA : stats;
  const period = filters.period;
  const periodData = effectiveStats?.outcomesByPeriod?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && period !== 'all';
  const isPositive = periodData?.changeDirection === 'up';

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-dd-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-dd-error">
        <p className="text-muted-foreground" data-testid="text-dd-error-message">Failed to load due diligence data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-dd-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const scheduledMeetings = effectiveStats?.scheduledMeetings || 0;
  const completedMeetings = effectiveStats?.completedMeetings || 0;
  const completionRate = effectiveStats?.completionRate || 0;
  const averageSchedulingDays = effectiveStats?.averageSchedulingDays || 0;
  const pendingOutcomes = effectiveStats?.pendingOutcomes || 0;
  const outcomes = effectiveStats?.outcomes || {};
  const scoreDistribution = effectiveStats?.scoreDistribution || [];
  const riskLevelDistribution = effectiveStats?.riskLevelDistribution || [];
  const schedulingTimeBreakdown = effectiveStats?.schedulingTimeBreakdown || [];
  const monthlyThroughput = effectiveStats?.monthlyThroughput || [];
  const meetingMetrics = effectiveStats?.meetingMetrics || null;
  const heldDisambiguation = effectiveStats?.heldDisambiguation || null;
  const heldEntries = heldDisambiguation ? Object.entries(heldDisambiguation) : [];
  const heldDecisionForms = heldEntries.filter(([, v]) => v === 'decision').map(([k]) => k);
  const heldMeetingForms = heldEntries.filter(([, v]) => v === 'meeting').map(([k]) => k);

  const slaBreached = averageSchedulingDays > slaDays;

  return (
    <div className="space-y-6">
      <CardActionBar
        slaLabel="Scheduling SLA"
        slaValue={slaDays}
        onSlaChange={onSlaChange}
        onExport={() => downloadCsv('due-diligence', filters)}
        onRefresh={() => refetch()}
        isFetching={isFetching}
        demoMode={demoMode}
        testIdPrefix="dd"
        dashboardLink={buildDashboardLink({ formId: filters.formId, status: 'verified' })}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4" data-testid="container-dd-stats-grid">
        <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-5 h-5 text-blue-600" />
            <span className="text-sm font-medium text-blue-700 dark:text-blue-400">Scheduled</span>
          </div>
          <p className="text-3xl font-bold text-blue-700 dark:text-blue-300" data-testid="text-scheduled-meetings">{scheduledMeetings.toLocaleString()}</p>
          <p className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-1">Total meetings scheduled</p>
        </div>

        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">Completed</span>
          </div>
          <p className="text-3xl font-bold text-green-700 dark:text-green-300" data-testid="text-completed-meetings">{completedMeetings.toLocaleString()}</p>
          <p className="text-xs text-green-600/70 dark:text-green-400/70 mt-1">DD Meet Attended</p>
        </div>

        <div className="p-4 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
          <div className="flex items-center gap-2 mb-2">
            <Target className="w-5 h-5 text-purple-600" />
            <span className="text-sm font-medium text-purple-700 dark:text-purple-400">Completion Rate</span>
          </div>
          <p className="text-3xl font-bold text-purple-700 dark:text-purple-300" data-testid="text-completion-rate">{completionRate}%</p>
          <p className="text-xs text-purple-600/70 dark:text-purple-400/70 mt-1">Scheduled to attended</p>
        </div>

        <div className={`p-4 rounded-lg border ${slaBreached ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800' : 'bg-muted/30'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Clock className={`w-5 h-5 ${slaBreached ? 'text-orange-600' : 'text-muted-foreground'}`} />
            <span className={`text-sm font-medium ${slaBreached ? 'text-orange-700 dark:text-orange-700' : 'text-muted-foreground'}`}>Avg. Scheduling</span>
            {slaBreached && <Badge variant="outline" className="border-orange-500 text-orange-600 ml-auto" data-testid="badge-dd-sla-breached">SLA breach</Badge>}
          </div>
          <p className={`text-3xl font-bold ${slaBreached ? 'text-orange-700 dark:text-orange-300' : ''}`} data-testid="text-avg-scheduling">
            {averageSchedulingDays.toFixed(1)} <span className="text-lg font-normal">days</span>
          </p>
          <p className={`text-xs mt-1 ${slaBreached ? 'text-orange-600/70 dark:text-orange-700/70' : 'text-muted-foreground'}`}>
            SLA threshold: {slaDays} days
          </p>
        </div>
      </div>

      {heldEntries.length > 0 && (
        <div
          className="flex items-start gap-3 p-3 rounded-md bg-muted/40 border"
          data-testid="container-held-disambiguation"
          title="In this report, 'Held' is treated as a meeting outcome when the form's workflow places it before a final decision; otherwise it is counted as the on-hold decision."
        >
          <Info className="w-4 h-4 mt-0.5 text-muted-foreground" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p data-testid="text-held-disambiguation-summary">
              <strong className="text-foreground">Held mapping:</strong>{' '}
              {heldMeetingForms.length} form(s) treat <em>Held</em> as a <strong>meeting outcome</strong>
              {heldDecisionForms.length > 0 ? `, ${heldDecisionForms.length} treat it as a decision (on-hold).` : '.'}
            </p>
            <p data-testid="text-held-disambiguation-detail">
              When Held is a meeting outcome, it appears under "Pending outcomes" / "Held" tiles below.
              When Held is a decision, it appears in the Decisions card as <em>On Hold</em>.
            </p>
          </div>
        </div>
      )}

      {effectiveStats?.slaBreaches && slaDaysNum > 0 && (
        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'verified', outstandingDays: slaDaysNum })}
          className="flex items-center gap-3 p-4 rounded-md bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
          data-testid="link-dd-sla-breaches"
        >
          <AlertCircle className="w-5 h-5 text-orange-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-orange-700 dark:text-orange-700">
              <span className="text-2xl font-bold mr-2" data-testid="text-dd-sla-breach-count">
                {(effectiveStats.slaBreaches.breachedCount || 0).toLocaleString()}
              </span>
              awaiting meeting longer than {slaDaysNum} days
            </p>
            <p className="text-xs text-orange-600/70 dark:text-orange-700/70">Open in dashboard to review</p>
          </div>
          <ExternalLink className="w-4 h-4 text-orange-600" />
        </a>
      )}

      {hasValidComparison && periodData && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50" data-testid="container-dd-period-comparison">
          <div className={`p-2 rounded-full ${isPositive ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
            {isPositive ? <TrendingUp className="w-5 h-5 text-green-600" /> : <TrendingDown className="w-5 h-5 text-red-600" />}
          </div>
          <div>
            <p className="text-sm font-medium" data-testid="text-dd-period-comparison">
              <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
                {isPositive ? '+' : ''}{changePercent}%
              </span>
              {' '}completion rate vs previous {period}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="text-dd-period-details">
              {periodData.completed} completed of {periodData.scheduled} scheduled ({periodData.completionRate}%)
            </p>
          </div>
        </div>
      )}

      {meetingMetrics && meetingMetrics.totalRequests > 0 && (
        <div className="space-y-3" data-testid="container-meeting-metrics">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Meeting Request Metrics
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            <div className="p-2 rounded bg-muted/30" data-testid="metric-total-requests">
              <p className="text-xs text-muted-foreground">Requests sent</p>
              <p className="text-xl font-bold">{meetingMetrics.totalRequests}</p>
            </div>
            <div className="p-2 rounded bg-blue-50 dark:bg-blue-900/20" data-testid="metric-booked">
              <p className="text-xs text-blue-700 dark:text-blue-400">Booked</p>
              <p className="text-xl font-bold text-blue-700 dark:text-blue-300">{meetingMetrics.booked}</p>
            </div>
            <div className="p-2 rounded bg-amber-50 dark:bg-amber-900/20" data-testid="metric-pending">
              <p className="text-xs text-amber-700 dark:text-amber-700">Pending</p>
              <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{meetingMetrics.pending}</p>
            </div>
            <div className="p-2 rounded bg-red-50 dark:bg-red-900/20" data-testid="metric-cancelled">
              <p className="text-xs text-red-700 dark:text-red-400">Cancelled</p>
              <p className="text-xl font-bold text-red-700 dark:text-red-300">{meetingMetrics.cancelled}</p>
            </div>
            <div className="p-2 rounded bg-orange-50 dark:bg-orange-900/20" data-testid="metric-no-show">
              <p className="text-xs text-orange-700 dark:text-orange-700">No-show</p>
              <p className="text-xl font-bold text-orange-700 dark:text-orange-300">{meetingMetrics.noShow}</p>
            </div>
            <div className="p-2 rounded bg-purple-50 dark:bg-purple-900/20" data-testid="metric-rescheduled">
              <p className="text-xs text-purple-700 dark:text-purple-400">Rescheduled</p>
              <p className="text-xl font-bold text-purple-700 dark:text-purple-300">{meetingMetrics.rescheduled}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {typeof meetingMetrics.verifiedToBookedHours === 'number' && (
              <span data-testid="metric-verified-to-booked" title="Average time from submission entering Verified (history log) to booking creation">
                Verified→Booked: <strong>{meetingMetrics.verifiedToBookedHours}h</strong>
                {meetingMetrics.verifiedToBookedSampleSize ? ` (n=${meetingMetrics.verifiedToBookedSampleSize})` : ''}
              </span>
            )}
            {typeof meetingMetrics.bookedToHeldHours === 'number' && (
              <span data-testid="metric-booked-to-held" title="Average time from booking start (or creation) to submission reaching DD Meet Attended / Held">
                Booked→Held: <strong>{meetingMetrics.bookedToHeldHours}h</strong>
                {meetingMetrics.bookedToHeldSampleSize ? ` (n=${meetingMetrics.bookedToHeldSampleSize})` : ''}
              </span>
            )}
            <span data-testid="metric-lead-time" title="Booking creation -> scheduled meeting time (booking-side)">Avg lead time: <strong>{meetingMetrics.averageLeadTimeHours}h</strong></span>
            <span data-testid="metric-booking-time" title="Request sent -> booking created (booking-side)">Avg time-to-book: <strong>{meetingMetrics.averageBookingTimeHours}h</strong></span>
            <span data-testid="metric-expired">Expired: <strong>{meetingMetrics.expired}</strong></span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4" data-testid="container-outcomes">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users className="w-4 h-4" />
            Meeting Outcomes
          </h4>
          <div className="space-y-3">
            <a
              href={buildDashboardLink({ formId: filters.formId, status: 'held' })}
              className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover-elevate"
              data-testid="row-outcome-held"
            >
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-amber-500" />
                <span className="font-medium">Held</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="badge-outcome-held">{outcomes.held?.count || 0}</Badge>
                <span className="text-sm text-muted-foreground w-12 text-right">{outcomes.held?.percentage || 0}%</span>
              </div>
            </a>
            <a
              href={buildDashboardLink({ formId: filters.formId, status: 'approved' })}
              className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover-elevate"
              data-testid="row-outcome-approved"
            >
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span className="font-medium">Approved</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="badge-outcome-approved">{outcomes.approved?.count || 0}</Badge>
                <span className="text-sm text-muted-foreground w-12 text-right">{outcomes.approved?.percentage || 0}%</span>
              </div>
            </a>
            <a
              href={buildDashboardLink({ formId: filters.formId, status: 'rejected' })}
              className="flex items-center justify-between p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 hover-elevate"
              data-testid="row-outcome-rejected"
            >
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span className="font-medium">Rejected</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="badge-outcome-rejected">{outcomes.rejected?.count || 0}</Badge>
                <span className="text-sm text-muted-foreground w-12 text-right">{outcomes.rejected?.percentage || 0}%</span>
              </div>
            </a>
            {pendingOutcomes > 0 && (
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border" data-testid="row-outcome-pending">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-gray-400" />
                  <span className="font-medium text-muted-foreground">Pending Decision</span>
                </div>
                <Badge variant="outline" data-testid="badge-outcome-pending">{pendingOutcomes}</Badge>
              </div>
            )}
          </div>
        </div>

        {scoreDistribution.length > 0 && (
          <div className="space-y-4" data-testid="container-score-distribution">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Target className="w-4 h-4" />
              Score Distribution
            </h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={scoreDistribution}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                    formatter={(value, name, props) => [value, `Score ${props.payload.range}`]}
                  />
                  <Bar dataKey="count" name="Applicants">
                    {scoreDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {riskLevelDistribution.length > 0 && (
        <div className="space-y-3" data-testid="container-risk-distribution">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Risk Level Distribution
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {riskLevelDistribution.map((r) => (
              <a
                key={r.level}
                href={buildDashboardLink({ formId: filters.formId, riskLevel: r.level })}
                className="block p-3 rounded-lg border hover-elevate"
                style={{ borderColor: r.color }}
                data-testid={`row-risk-${r.level}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium capitalize">{r.level}</span>
                  <Badge variant="outline">{r.count}</Badge>
                </div>
                <Progress value={r.percentage} className="h-2" style={{ '--progress-background': r.color }} />
                <p className="text-xs text-muted-foreground mt-1">{r.percentage}%</p>
              </a>
            ))}
          </div>
        </div>
      )}

      {monthlyThroughput.length > 0 && (
        <div className="space-y-3" data-testid="container-monthly-throughput">
          <h4 className="text-sm font-medium text-muted-foreground">Monthly Throughput</h4>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyThroughput}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="scheduled" fill="hsl(var(--chart-2))" name="Scheduled" />
                <Bar dataKey="completed" fill="hsl(var(--chart-1))" name="Completed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {schedulingTimeBreakdown.length > 0 && (
        <div className="space-y-4" data-testid="container-scheduling-breakdown">
          <h4 className="text-sm font-medium text-muted-foreground">Time to Meeting Attendance</h4>
          <div className="space-y-3">
            {schedulingTimeBreakdown.map((item, idx) => (
              <div key={item.range} className="space-y-1" data-testid={`row-scheduling-${idx}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{item.range}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" data-testid={`badge-scheduling-count-${idx}`}>{item.count}</Badge>
                    <span className="text-xs text-muted-foreground w-12 text-right">{item.percentage}%</span>
                  </div>
                </div>
                <Progress value={item.percentage} className="h-2" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Decisions ----------
function DecisionsReportCard({ filters, demoMode, slaDays, onSlaChange }) {
  const qsBase = buildQueryString(filters);
  const slaDaysNum = Number(slaDays) || 0;
  const qs = qsBase
    ? `${qsBase}&slaDays=${slaDaysNum}`
    : `?slaDays=${slaDaysNum}`;
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/decisions-stats', filters, slaDaysNum],
    queryFn: () => apiRequest('GET', `/api/reports/decisions-stats${qs}`),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    enabled: !demoMode
  });

  const effectiveStats = demoMode ? DEMO_DECISIONS_DATA : stats;
  const period = filters.period;
  const periodData = effectiveStats?.decisionsByPeriod?.[period];
  const hasValidComparison = period !== 'all' && periodData?.total?.change !== null && periodData?.total?.change !== undefined;

  if (!demoMode && isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-decisions-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!demoMode && error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4" data-testid="container-decisions-error">
        <p className="text-muted-foreground" data-testid="text-decisions-error-message">Failed to load decisions data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-decisions-retry">
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const totalDecisions = effectiveStats?.totalDecisions || 0;
  const approved = effectiveStats?.approved || { count: 0, percentage: 0 };
  const declined = effectiveStats?.declined || { count: 0, percentage: 0 };
  const onHold = effectiveStats?.onHold || { count: 0, percentage: 0 };
  const monthlyTrend = effectiveStats?.monthlyTrend || [];
  const averageTimeToDecision = effectiveStats?.averageTimeToDecision || {};
  const scoreVsOutcome = effectiveStats?.scoreVsOutcome || [];
  const decisionsByReviewer = effectiveStats?.decisionsByReviewer || [];
  const slaBreachInfo = effectiveStats?.slaBreaches || null;

  const renderTrendBadge = (data) => {
    if (!data || data.change === null || data.change === undefined) return null;
    const isUp = data.changeDirection === 'up';
    return (
      <div className={`flex items-center gap-1 text-xs ${isUp ? 'text-green-600' : 'text-red-600'}`}>
        {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        <span>{data.change}%</span>
      </div>
    );
  };

  const approvedSlaBreached = (averageTimeToDecision.approved || 0) > slaDays;

  return (
    <div className="space-y-6">
      <CardActionBar
        slaLabel="Decision SLA"
        slaValue={slaDays}
        onSlaChange={onSlaChange}
        onExport={() => downloadCsv('decisions', filters)}
        onRefresh={() => refetch()}
        isFetching={isFetching}
        demoMode={demoMode}
        testIdPrefix="decisions"
        dashboardLink={buildDashboardLink({ formId: filters.formId })}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4" data-testid="container-decisions-stats-grid">
        <div className="p-4 rounded-lg bg-muted/50 border">
          <div className="flex items-center gap-2 mb-2">
            <Gavel className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Total Decisions</span>
          </div>
          <p className="text-3xl font-bold" data-testid="text-total-decisions">{totalDecisions.toLocaleString()}</p>
          {hasValidComparison && periodData?.total && (
            <div className="mt-1">{renderTrendBadge(periodData.total)}</div>
          )}
        </div>

        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'approved' })}
          className="block p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover-elevate"
          data-testid="link-decisions-approved"
        >
          <div className="flex items-center gap-2 mb-2">
            <ThumbsUp className="w-5 h-5 text-green-600" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">Approved</span>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-3xl font-bold text-green-700 dark:text-green-300" data-testid="text-approved-count">{approved.count}</p>
            <span className="text-sm text-green-600/70 dark:text-green-400/70">({approved.percentage}%)</span>
          </div>
          {hasValidComparison && periodData?.approved && (
            <div className="mt-1">{renderTrendBadge(periodData.approved)}</div>
          )}
        </a>

        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'rejected' })}
          className="block p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 hover-elevate"
          data-testid="link-decisions-declined"
        >
          <div className="flex items-center gap-2 mb-2">
            <ThumbsDown className="w-5 h-5 text-red-600" />
            <span className="text-sm font-medium text-red-700 dark:text-red-400">Declined</span>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-3xl font-bold text-red-700 dark:text-red-300" data-testid="text-declined-count">{declined.count}</p>
            <span className="text-sm text-red-600/70 dark:text-red-400/70">({declined.percentage}%)</span>
          </div>
          {hasValidComparison && periodData?.declined && (
            <div className="mt-1">{renderTrendBadge(periodData.declined)}</div>
          )}
        </a>

        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'held' })}
          className="block p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover-elevate"
          data-testid="link-decisions-onhold"
        >
          <div className="flex items-center gap-2 mb-2">
            <Pause className="w-5 h-5 text-amber-700" />
            <span className="text-sm font-medium text-amber-700 dark:text-amber-700">On Hold</span>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-3xl font-bold text-amber-700 dark:text-amber-300" data-testid="text-onhold-count">{onHold.count}</p>
            <span className="text-sm text-amber-700/70 dark:text-amber-700/70">({onHold.percentage}%)</span>
          </div>
          {hasValidComparison && periodData?.onHold && (
            <div className="mt-1">{renderTrendBadge(periodData.onHold)}</div>
          )}
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {monthlyTrend.length > 0 && (
          <div className="space-y-4" data-testid="container-decisions-trend">
            <h4 className="text-sm font-medium text-muted-foreground">Monthly Trend</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="approved" name="Approved" fill="#22C55E" stackId="a" />
                  <Bar dataKey="declined" name="Declined" fill="#EF4444" stackId="a" />
                  <Bar dataKey="onHold" name="On Hold" fill="#F59E0B" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {Object.keys(averageTimeToDecision).length > 0 && (
          <div className="space-y-4" data-testid="container-time-to-decision">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Average Time to Decision (SLA: {slaDays}d)
            </h4>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800" data-testid="row-time-approved">
                <div className="flex items-center gap-2">
                  <ThumbsUp className="w-4 h-4 text-green-600" />
                  <span className="font-medium">Approved</span>
                </div>
                <Badge
                  variant="secondary"
                  className={approvedSlaBreached ? 'border border-orange-500 text-orange-600' : ''}
                  data-testid="badge-time-approved"
                >
                  {(averageTimeToDecision.approved || 0).toFixed(1)} days
                </Badge>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800" data-testid="row-time-declined">
                <div className="flex items-center gap-2">
                  <ThumbsDown className="w-4 h-4 text-red-600" />
                  <span className="font-medium">Declined</span>
                </div>
                <Badge variant="secondary" data-testid="badge-time-declined">
                  {(averageTimeToDecision.declined || 0).toFixed(1)} days
                </Badge>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800" data-testid="row-time-onhold">
                <div className="flex items-center gap-2">
                  <Pause className="w-4 h-4 text-amber-700" />
                  <span className="font-medium">On Hold</span>
                </div>
                <Badge variant="secondary" data-testid="badge-time-onhold">
                  {(averageTimeToDecision.onHold || 0).toFixed(1)} days
                </Badge>
              </div>
            </div>
          </div>
        )}
      </div>

      {slaBreachInfo && slaDaysNum > 0 && (
        <a
          href={buildDashboardLink({ formId: filters.formId, status: 'dd-meet-attended', outstandingDays: slaDaysNum })}
          className="flex items-center gap-3 p-4 rounded-md bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 hover-elevate"
          data-testid="link-decisions-sla-breaches"
        >
          <AlertCircle className="w-5 h-5 text-orange-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-orange-700 dark:text-orange-700">
              <span className="text-2xl font-bold mr-2" data-testid="text-decisions-sla-breach-count">
                {(slaBreachInfo.breachedCount || 0).toLocaleString()}
              </span>
              awaiting a decision longer than {slaDaysNum} days
            </p>
            <p className="text-xs text-orange-600/70 dark:text-orange-700/70">Open in dashboard to review</p>
          </div>
          <ExternalLink className="w-4 h-4 text-orange-600" />
        </a>
      )}

      {scoreVsOutcome.length > 0 && (
        <div className="space-y-3" data-testid="container-score-vs-outcome">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Target className="w-4 h-4" />
            Average DD Score by Outcome
          </h4>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scoreVsOutcome}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}
                  formatter={(value, name, props) => [`${value} (n=${props.payload.count})`, 'Avg score']}
                />
                <Bar dataKey="averageScore" name="Average score">
                  {scoreVsOutcome.map((entry) => (
                    <Cell
                      key={entry.outcome}
                      fill={entry.outcome === 'approved' ? '#22C55E' : entry.outcome === 'declined' ? '#EF4444' : '#F59E0B'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {decisionsByReviewer.length > 0 && (
        <div className="space-y-3" data-testid="container-decisions-by-reviewer">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users className="w-4 h-4" />
            Decisions by Reviewer
          </h4>
          <div className="space-y-2">
            {decisionsByReviewer.slice(0, 8).map((rev) => (
              <a
                key={rev.reviewer}
                href={buildDashboardLink({ formId: filters.formId, reviewer: rev.reviewer })}
                className="flex items-center justify-between p-2 rounded-md bg-muted/30 hover-elevate"
                data-testid={`row-reviewer-decisions-${rev.reviewer}`}
              >
                <span className="text-sm truncate flex-1">{rev.reviewer}</span>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="bg-green-50 dark:bg-green-900/20 border-green-200">{rev.approved}</Badge>
                  <Badge variant="outline" className="bg-red-50 dark:bg-red-900/20 border-red-200">{rev.declined}</Badge>
                  <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/20 border-amber-200">{rev.onHold}</Badge>
                  <Badge variant="secondary">{rev.total}</Badge>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Main page ----------
export default function DueDiligenceReports() {
  const { memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { tenantSlug } = useTenantBranding() || {};
  const [accessChecked, setAccessChecked] = useState(false);
  const [reportCards, setReportCards] = useState(DEFAULT_REPORT_CARDS);
  const [filters, setFilters] = useState({
    formId: 'all',
    period: 'month',
    startDate: '',
    endDate: ''
  });
  const [slaThresholds, setSlaThresholds] = useState(DEFAULT_SLA);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  const { data: forms, isLoading: formsLoading } = useQuery({
    queryKey: ['/api/reports/dd-forms'],
    queryFn: () => apiRequest('GET', '/api/reports/dd-forms'),
    staleTime: 5 * 60 * 1000,
    enabled: !demoMode
  });

  const handleSynopsisCardClick = useCallback((cardId) => {
    const element = document.querySelector(`[data-testid="card-report-${cardId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

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

  // Load preferences
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
                mergedCards.push({ ...defaultCard, order: mergedCards.length });
              }
            });
            setReportCards(mergedCards);
          }
          if (parsed.filters) setFilters((prev) => ({ ...prev, ...parsed.filters }));
          else if (parsed.funnelPeriod) setFilters((prev) => ({ ...prev, period: parsed.funnelPeriod }));
          if (parsed.slaThresholds) setSlaThresholds((prev) => ({ ...prev, ...parsed.slaThresholds }));
          if (parsed.demoMode !== undefined) setDemoMode(parsed.demoMode);
        }
      } catch (e) {
        console.error('Error loading dashboard preferences:', e);
      }
    }
  }, [storageKey, memberInfo?.id, tenantSlug]);

  // Save preferences
  useEffect(() => {
    if (memberInfo?.id && tenantSlug !== undefined) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          reportCards,
          filters,
          slaThresholds,
          demoMode
        }));
      } catch (e) {
        console.error('Error saving dashboard preferences:', e);
      }
    }
  }, [reportCards, filters, slaThresholds, demoMode, storageKey, memberInfo?.id, tenantSlug]);

  const handleDragEnd = (result) => {
    if (!result.destination) return;
    const items = Array.from(reportCards);
    const [reordered] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reordered);
    const updatedItems = items.map((item, index) => ({ ...item, order: index }));
    setReportCards(updatedItems);
  };

  const toggleCardVisibility = (cardId) => {
    setReportCards(prev =>
      prev.map(card => card.id === cardId ? { ...card, visible: !card.visible } : card)
    );
  };

  const visibleCards = useMemo(() =>
    reportCards.filter(card => card.visible).sort((a, b) => a.order - b.order),
    [reportCards]
  );

  const updateSla = (key) => (value) => {
    setSlaThresholds((prev) => ({ ...prev, [key]: value }));
  };

  const renderCardContent = (cardId) => {
    switch (cardId) {
      case 'application-funnel':
        return <ApplicationFunnelReportCard filters={filters} demoMode={demoMode} />;
      case 'verification':
        return (
          <VerificationReportCard
            filters={filters}
            demoMode={demoMode}
            slaDays={slaThresholds.verificationDays}
            onSlaChange={updateSla('verificationDays')}
          />
        );
      case 'due-diligence':
        return (
          <DueDiligenceReportCard
            filters={filters}
            demoMode={demoMode}
            slaDays={slaThresholds.ddSchedulingDays}
            onSlaChange={updateSla('ddSchedulingDays')}
          />
        );
      case 'decisions':
        return (
          <DecisionsReportCard
            filters={filters}
            demoMode={demoMode}
            slaDays={slaThresholds.decisionDays}
            onSlaChange={updateSla('decisionDays')}
          />
        );
      default:
        return null;
    }
  };

  const getCardIcon = (cardId) => {
    switch (cardId) {
      case 'application-funnel': return <Filter className="w-5 h-5" />;
      case 'verification': return <CheckCircle2 className="w-5 h-5" />;
      case 'due-diligence': return <Calendar className="w-5 h-5" />;
      case 'decisions': return <Gavel className="w-5 h-5" />;
      default: return <BarChart3 className="w-5 h-5" />;
    }
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formsListForDemo = demoMode
    ? [{ form_id: 'demo-form-1', form_name: 'Demo: Investor Onboarding' }]
    : (Array.isArray(forms) ? forms : (Array.isArray(forms?.forms) ? forms.forms : []));

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
              <Label htmlFor="demo-mode" className="text-sm cursor-pointer" data-testid="label-demo-mode">
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

        <ReportFilterBar
          filters={filters}
          onChange={setFilters}
          forms={formsListForDemo}
          formsLoading={formsLoading && !demoMode}
        />

        <SynopsisCardsRow demoMode={demoMode} filters={filters} onCardClick={handleSynopsisCardClick} />

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
                <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-6">
                  {visibleCards.map((card, index) => (
                    <Draggable key={card.id} draggableId={card.id} index={index}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={snapshot.isDragging ? 'opacity-90' : ''}
                          data-testid={`card-report-${card.id}`}
                        >
                          <Card>
                            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                              <div className="flex items-center gap-2">
                                <div {...provided.dragHandleProps} className="cursor-grab" data-testid={`drag-handle-${card.id}`}>
                                  <GripVertical className="w-5 h-5 text-muted-foreground" />
                                </div>
                                {getCardIcon(card.id)}
                                <CardTitle data-testid={`title-card-${card.id}`}>{card.title}</CardTitle>
                              </div>
                            </CardHeader>
                            <CardContent>{renderCardContent(card.id)}</CardContent>
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

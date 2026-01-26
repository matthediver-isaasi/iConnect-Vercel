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
  LayoutDashboard
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from "recharts";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const STORAGE_KEY_PREFIX = 'reports_dashboard_';

const DEFAULT_REPORT_CARDS = [
  { id: 'members', title: 'Members', visible: true, order: 0 }
];

const PERIOD_OPTIONS = [
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' }
];

function MembersReportCard({ period, onPeriodChange }) {
  const { data: stats, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['/api/reports/member-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/member-stats'),
    staleTime: 60000,
    refetchOnWindowFocus: false
  });

  const periodData = stats?.periodStats?.[period];
  const changePercent = periodData?.change;
  const hasValidComparison = changePercent !== null && changePercent !== undefined && !periodData?.isAllTime;
  const isPositive = periodData?.changeDirection === 'up';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="container-loading">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-stats"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
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

export default function ReportsDashboard() {
  const { memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { tenantSlug } = useTenantBranding() || {};
  const [accessChecked, setAccessChecked] = useState(false);
  const [reportCards, setReportCards] = useState(DEFAULT_REPORT_CARDS);
  const [membersPeriod, setMembersPeriod] = useState('month');
  const [settingsOpen, setSettingsOpen] = useState(false);

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
          if (parsed.reportCards) setReportCards(parsed.reportCards);
          if (parsed.membersPeriod) setMembersPeriod(parsed.membersPeriod);
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
          membersPeriod
        }));
      } catch (e) {
        console.error('Error saving dashboard preferences:', e);
      }
    }
  }, [reportCards, membersPeriod, storageKey, memberInfo?.id, tenantSlug]);

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

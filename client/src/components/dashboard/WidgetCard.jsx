import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  BAR_CHART_MARGIN,
  getBarHeightProps,
} from "@/components/dashboard/barChartHeight";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Copy,
  Download,
  GripVertical,
  Info,
  MoreVertical,
  PencilLine,
  Trash2,
  Maximize2,
  ArrowUpDown,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import { rowsToCsv, slugifyFilename, downloadCsv } from "@/lib/csvExport";
import {
  dashboardWidgetChartColours,
  resolveDashboardWidgetColour,
} from "@shared/dashboardWidgetPalette.js";

// Note: column-span sizing now lives on the sortable wrapper in
// WidgetGrid, so the wrapper has a real grid box (required for the
// drag transform animation and the floating drag-overlay's measured
// rect). The card itself just fills whatever box its parent provides.

export function formatNumber(value, numberFormat = null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  // Stat/KPI display option: full un-compacted number with locale
  // thousands separators and a fixed number of decimals (0–4). Absent
  // or `compact` mode keeps the legacy compact style below.
  if (numberFormat?.mode === "full") {
    const decimals = Number.isInteger(numberFormat.decimals)
      ? Math.min(Math.max(numberFormat.decimals, 0), 4)
      : 0;
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value);
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return Number(value).toFixed(2);
}

// Widget click-through: sources whose grouped buckets can open a CRM list
// page filtered to the bucket's records.
const DRILL_ROUTES = {
  organization: "/organisations",
  member: "/members",
  // Event Bookings drill to the organisations behind a bucket (both the
  // participation split and booking group-bys return organisation ids).
  event_booking: "/organisations",
};

// Recharts click payload shapes vary: Bar/Pie handlers may receive the row
// itself, or a wrapper carrying the row under `payload` (and the nameKey
// value under `name`). Resolve the bucket key defensively across all three.
function drillKeyFromChartEntry(entry) {
  if (entry?.key != null) return entry.key;
  if (entry?.payload?.key != null) return entry.payload.key;
  if (entry?.name != null) return entry.name;
  return null;
}

const NEXT_WIDTH = { fifth: "third", third: "half", half: "full", full: "fifth" };
const WIDTH_LABEL = { fifth: "1/5", third: "1/3", half: "1/2", full: "Full" };

const NEXT_HEIGHT = { short: "medium", medium: "tall", tall: "xtall", xtall: "xxtall", xxtall: "short" };
const HEIGHT_LABEL = { short: "Short", medium: "Medium", tall: "Tall", xtall: "Extra Tall", xxtall: "Huge" };

const LINE_HEIGHT_CLASS = { short: "h-40 w-full", medium: "h-56 w-full", tall: "h-80 w-full", xtall: "h-[26rem] w-full", xxtall: "h-[32rem] w-full" };
// Pie/donut: outerRadius and innerRadius scale with height so the chart
// fills its container without clipping. Each outerRadius fits comfortably
// inside the corresponding CSS height (outerRadius * 2 < container px).
const PIE_HEIGHT_CONFIG = {
  short:  { className: "h-36 w-full", outerRadius: 55, innerRadius: 32 },
  medium: { className: "h-44 w-full", outerRadius: 72, innerRadius: 44 },
  tall:   { className: "h-60 w-full", outerRadius: 95, innerRadius: 58 },
  xtall:  { className: "h-72 w-full", outerRadius: 110, innerRadius: 68 },
  xxtall: { className: "h-80 w-full", outerRadius: 130, innerRadius: 80 },
};
// List: both min-h (so the card has a deterministic height even with few/no
// rows) and max-h (so a very long list still scrolls rather than overflowing).
const LIST_HEIGHT_CLASS = {
  short:  { min: "min-h-[8rem]",  max: "max-h-48" },
  medium: { min: "min-h-[10rem]", max: "max-h-64" },
  tall:   { min: "min-h-[14rem]", max: "max-h-96" },
  xtall:  { min: "min-h-[18rem]", max: "max-h-[28rem]" },
  xxtall: { min: "min-h-[22rem]", max: "max-h-[36rem]" },
};
// Stat/conversion widgets have minimal content; use min-h so height setting
// produces a visible size difference across all five named values.
// Also reused by EmptyChart so empty states honour the widget's height.
const STAT_HEIGHT_CLASS = {
  short:  "min-h-[8rem]",
  medium: "min-h-[10rem]",
  tall:   "min-h-[14rem]",
  xtall:  "min-h-[18rem]",
  xxtall: "min-h-[22rem]",
};

// Build the rows that drive the CSV export from the already-loaded widget
// payload. Returns an array of row arrays (first row is the header). Chart
// widgets export one row per data point (Label,Value) plus a Total row when
// the widget view shows one; stat widgets export a single metric row.
function buildExportRows(widget, payload) {
  if (!payload) return [];
  const type = widget.widget_type;
  if (payload.type === "conversion") {
    const entityLabel =
      payload.matchBy === "member" ? "members" : "organisations";
    return [
      ["Metric", "Value"],
      ["Converted", payload.convertedCount ?? 0],
      [
        "Conversion rate (%)",
        payload.conversionRate === null || payload.conversionRate === undefined
          ? ""
          : Number(payload.conversionRate).toFixed(1),
      ],
      [
        `Source ${entityLabel}`,
        payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0,
      ],
      [
        `Not converted ${entityLabel}`,
        payload.notConvertedCount ??
          Math.max(
            0,
            (payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0) -
              (payload.convertedCount ?? 0),
          ),
      ],
    ];
  }
  if (type === "stat") {
    const value =
      payload.type === "scalar" ? payload.value : payload.rows?.[0]?.value;
    const aggregator = widget.config?.measure?.aggregator || "count";
    return [
      ["Metric", "Value", "Records"],
      [aggregator, value ?? "", payload.total ?? 0],
    ];
  }
  const rows = payload.rows || [];
  const out = [["Label", "Value"]];
  rows.forEach((r) => out.push([r.key, r.value]));
  // Bar, pie and donut views display a total; line views do not.
  if (type === "bar" || type === "pie" || type === "donut") {
    const total = rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0);
    out.push(["Total", total]);
  }
  return out;
}

export default function WidgetCard({
  widget,
  canEdit = false,
  dragHandleProps = null,
  onEdit,
  onDelete,
  onDuplicate,
  onResize,
  onResizeHeight,
  palette,
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [drillingKey, setDrillingKey] = useState(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["/api/dashboard/widgets", widget.id, "data"],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard/widgets/${widget.id}/data`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      return res.json();
    },
  });

  // Click-through: enabled by the widget's clickThrough flag for
  // organisation / member sourced group-by widgets. Clicking a bar,
  // slice, legend entry or list row fetches the ids behind that bucket
  // and opens the CRM list filtered to exactly those records.
  const drillRoute = DRILL_ROUTES[widget.config?.source] || null;
  const drillEnabled =
    !!widget.config?.clickThrough &&
    !!drillRoute &&
    (!!widget.config?.groupBy || widget.config?.participation === true) &&
    data?.data?.type === "group";
  const handleDrill = async (key) => {
    if (!drillEnabled || drillingKey) return;
    setDrillingKey(key);
    try {
      const res = await fetch(`/api/dashboard/widgets/${widget.id}/drilldown`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const nonce = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(
        `widget-drill:${nonce}`,
        JSON.stringify({
          ids: body.ids || [],
          label: `${widget.title} · ${key}`,
          total: body.total ?? (body.ids || []).length,
          truncated: !!body.truncated,
        }),
      );
      navigate(`${drillRoute}?widgetDrill=${nonce}`);
    } catch (err) {
      toast({
        title: "Couldn't open records",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setDrillingKey(null);
    }
  };

  const canExport = !isLoading && !isError && !!data;
  const handleExportCsv = () => {
    if (!canExport) return;
    const exportRows = buildExportRows(widget, data.data);
    const rows = exportRows.length > 0 ? exportRows : [["Label", "Value"]];
    const filename = `${slugifyFilename(widget.title, "widget")}.csv`;
    downloadCsv(rowsToCsv(rows), filename);
    toast({
      title: "Export complete",
      description: `Downloaded ${filename}`,
    });
  };

  return (
    <Card
      data-testid={`widget-card-${widget.id}`}
      className={cn("flex h-full w-full flex-col")}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {dragHandleProps && (
            <button
              type="button"
              aria-label="Drag widget"
              data-testid={`button-drag-widget-${widget.id}`}
              className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
              {...dragHandleProps}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          <CardTitle
            className="truncate text-base"
            data-testid={`text-widget-title-${widget.id}`}
            title={widget.title}
          >
            {widget.title}
          </CardTitle>
          {!!widget.config?.helperText && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`About "${widget.title}"`}
                  data-testid={`button-widget-info-${widget.id}`}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="h-4 w-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-w-xs text-sm"
              >
                <p
                  className="whitespace-pre-wrap"
                  data-testid={`text-widget-help-${widget.id}`}
                >
                  {widget.config.helperText}
                </p>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {canEdit && (onResize || onResizeHeight) && (
          <TooltipProvider delayDuration={200}>
            <div className="flex items-center">
              {onResize && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Resize widget width (currently ${WIDTH_LABEL[widget.width] || "1/3"})`}
                      data-testid={`button-widget-resize-${widget.id}`}
                      onClick={() => onResize(widget, NEXT_WIDTH[widget.width] || "third")}
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Width · now {WIDTH_LABEL[widget.width] || "1/3"}
                  </TooltipContent>
                </Tooltip>
              )}
              {onResizeHeight && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Resize widget height (currently ${HEIGHT_LABEL[widget.height] || "Medium"})`}
                      data-testid={`button-widget-resize-height-${widget.id}`}
                      onClick={() => onResizeHeight(widget, NEXT_HEIGHT[widget.height] || "medium")}
                    >
                      <ArrowUpDown className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Height · now {HEIGHT_LABEL[widget.height] || "Medium"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Widget actions"
              data-testid={`button-widget-menu-${widget.id}`}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={handleExportCsv}
              disabled={!canExport}
              data-testid={`menuitem-export-csv-${widget.id}`}
            >
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onEdit?.(widget)}
                  data-testid={`menuitem-edit-widget-${widget.id}`}
                >
                  <PencilLine className="mr-2 h-4 w-4" />
                  Edit widget
                </DropdownMenuItem>
                {onDuplicate && (
                  <DropdownMenuItem
                    onSelect={() => onDuplicate?.(widget)}
                    data-testid={`menuitem-duplicate-widget-${widget.id}`}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate widget
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete?.(widget)}
                  className="text-destructive focus:text-destructive"
                  data-testid={`menuitem-delete-widget-${widget.id}`}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete widget
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {isLoading && (
          <div className="space-y-2" data-testid={`widget-loading-${widget.id}`}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {isError && (
          <div
            className="flex flex-1 flex-col items-start justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid={`widget-error-${widget.id}`}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              <span>Failed to load widget</span>
            </div>
            <p className="text-xs text-destructive/80">{error?.message}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              data-testid={`button-retry-widget-${widget.id}`}
            >
              Retry
            </Button>
          </div>
        )}
        {!isLoading && !isError && data && (
          <WidgetBody
            widget={widget}
            payload={data.data}
            onDrill={drillEnabled ? handleDrill : null}
            palette={palette}
          />
        )}
      </CardContent>
    </Card>
  );
}

function WidgetBody({ widget, payload, onDrill = null, palette }) {
  if (!payload) return null;
  if (payload.type === "conversion") {
    return <ConversionBody widget={widget} payload={payload} palette={palette} />;
  }
  switch (widget.widget_type) {
    case "stat":
      return <StatBody widget={widget} payload={payload} palette={palette} />;
    case "bar":
      return <BarBody payload={payload} widget={widget} onDrill={onDrill} palette={palette} />;
    case "pie":
      return <PieBody payload={payload} donut={false} widget={widget} onDrill={onDrill} palette={palette} />;
    case "donut":
      return <PieBody payload={payload} donut={true} widget={widget} onDrill={onDrill} palette={palette} />;
    case "line":
      return <LineBody payload={payload} widget={widget} palette={palette} />;
    case "list":
      return <ListBody payload={payload} widget={widget} onDrill={onDrill} palette={palette} />;
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unsupported widget type: {widget.widget_type}
        </p>
      );
  }
}

function StatBody({ widget, payload, palette }) {
  const value = payload.type === "scalar" ? payload.value : payload.rows?.[0]?.value;
  const aggregator = widget.config?.measure?.aggregator || "count";
  const minH = STAT_HEIGHT_CLASS[widget.height] || STAT_HEIGHT_CLASS.medium;
  return (
    <div className={cn("flex flex-1 flex-col justify-center gap-1", minH)}>
      <p
        className="text-3xl font-semibold tracking-tight"
      style={{ color: resolveDashboardWidgetColour(palette, widget.config?.color) }}
        data-testid={`stat-value-${widget.id}`}
      >
        {formatNumber(value, widget.config?.numberFormat)}
      </p>
      <p className="text-xs uppercase text-muted-foreground">
        {widget.config?.transition?.mode
          ? `${payload.total ?? 0} transition${payload.total === 1 ? "" : "s"}`
          : `${aggregator} · ${payload.total ?? 0} record${payload.total === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}

// Form-conversion stat card: headline = distinct entities that submitted
// BOTH forms, with the conversion % and the unique entity counts below.
// Falls back to raw submission counts for cached payloads that predate
// the entity-count fields.
function ConversionBody({ widget, payload, palette }) {
  const rate = payload.conversionRate;
  const entityLabel =
    payload.matchBy === "member" ? "members" : "organisations";
  const minH = STAT_HEIGHT_CLASS[widget.height] || STAT_HEIGHT_CLASS.medium;
  return (
    <div className={cn("flex flex-1 flex-col justify-center gap-1", minH)}>
      <p
        className="text-3xl font-semibold tracking-tight"
        style={{ color: resolveDashboardWidgetColour(palette, widget.config?.color) }}
        data-testid={`stat-value-${widget.id}`}
      >
        {formatNumber(payload.convertedCount, widget.config?.numberFormat)}
        {rate !== null && rate !== undefined && (
          <span className="ml-2 text-base font-normal text-muted-foreground">
            ({Number(rate).toFixed(1)}% converted)
          </span>
        )}
      </p>
      <p
        className="text-xs uppercase text-muted-foreground"
        data-testid={`conversion-detail-${widget.id}`}
      >
        {payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0}{" "}
        source ·{" "}
        {payload.notConvertedCount ??
          Math.max(
            0,
            (payload.sourceEntityCount ?? payload.sourceSubmissionCount ?? 0) -
              (payload.convertedCount ?? 0),
          )}{" "}
        not converted {entityLabel}
      </p>
    </div>
  );
}

function BarBody({ payload, widget, onDrill = null, palette }) {
  const rows = payload.rows || [];
  const colour = resolveDashboardWidgetColour(palette, widget?.config?.color);
  const chartColours = dashboardWidgetChartColours(palette);
  // Multi-series payloads (e.g. an "Active in period" split) carry a
  // categories list other than the single default 'value' column; render
  // one stacked <Bar> per category instead of the single-series bar.
  const categories = useMemo(() => {
    const cats = Array.isArray(payload.categories) ? payload.categories : [];
    return cats.length > 0 && !(cats.length === 1 && cats[0] === "value")
      ? cats
      : null;
  }, [payload.categories]);
  const config = useMemo(
    () =>
      categories
        ? Object.fromEntries(
            categories.map((c, i) => [
              c,
              { label: c, color: chartColours[i % chartColours.length] },
            ]),
          )
        : { value: { label: "Value", color: colour } },
    [categories, colour, chartColours],
  );
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  const heightKey = widget.height || "medium";
  const barProps = getBarHeightProps(heightKey);
  if (rows.length === 0) {
    return <EmptyChart heightClass={barProps.className} />;
  }

  if (categories) {
    return (
      <div className="flex flex-1 flex-col gap-2">
        <ChartContainer config={config} className={barProps.className}>
          <BarChart data={rows} margin={BAR_CHART_MARGIN}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="key"
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={barProps.angle}
              textAnchor="end"
              height={barProps.xAxisHeight}
            />
            <YAxis tickLine={false} axisLine={false} width={40} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {categories.map((c, i) => (
              <Bar
                key={c}
                dataKey={c}
                stackId="series"
                fill={chartColours[i % chartColours.length]}
                radius={i === categories.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                cursor={onDrill ? "pointer" : undefined}
                onClick={onDrill ? (entry) => {
                  const key = drillKeyFromChartEntry(entry);
                  if (key != null) onDrill(key);
                } : undefined}
              />
            ))}
          </BarChart>
        </ChartContainer>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {categories.map((c, i) => (
              <span key={c} className="flex items-center gap-1 text-xs text-muted-foreground">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: chartColours[i % chartColours.length] }}
                />
                {c}
              </span>
            ))}
          </div>
          <p
            className="text-right text-xs text-muted-foreground"
            data-testid={`widget-total-${widget.id}`}
          >
            Total: {formatNumber(total)}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-2">
      <ChartContainer config={config} className={barProps.className}>
        <BarChart data={rows} margin={BAR_CHART_MARGIN}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            interval={0}
            angle={barProps.angle}
            textAnchor="end"
            height={barProps.xAxisHeight}
          />
          <YAxis tickLine={false} axisLine={false} width={40} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="value"
            fill={colour}
            radius={[4, 4, 0, 0]}
            cursor={onDrill ? "pointer" : undefined}
            onClick={onDrill ? (entry) => {
              const key = drillKeyFromChartEntry(entry);
              if (key != null) onDrill(key);
            } : undefined}
          >
            <LabelList
              dataKey="value"
              position="top"
              className="fill-foreground"
              fontSize={11}
              formatter={(v) => formatNumber(v)}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <p
        className="text-right text-xs text-muted-foreground"
        data-testid={`widget-total-${widget.id}`}
      >
        Total: {formatNumber(total)}
      </p>
    </div>
  );
}

function LineBody({ payload, widget, palette }) {
  const rows = payload.rows || [];
  const colour = resolveDashboardWidgetColour(palette, widget?.config?.color);
  const config = useMemo(() => ({ value: { label: "Value", color: colour } }), [colour]);
  const lineClass = LINE_HEIGHT_CLASS[widget.height] || LINE_HEIGHT_CLASS.medium;
  if (rows.length === 0) return <EmptyChart heightClass={lineClass} />;
  return (
    <ChartContainer config={config} className={lineClass}>
      <LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="key" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          type="monotone"
          dataKey="value"
          stroke={colour}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

function PieBody({ payload, donut, widget, onDrill = null, palette }) {
  const rows = payload.rows || [];
  const chartColours = dashboardWidgetChartColours(palette);
  const config = useMemo(() => {
    const built = {};
    rows.forEach((row, idx) => {
      built[row.key] = {
        label: row.key,
        color: chartColours[idx % chartColours.length],
      };
    });
    return built;
  }, [rows, chartColours]);
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  const pieCfg = PIE_HEIGHT_CONFIG[widget.height] || PIE_HEIGHT_CONFIG.medium;
  if (rows.length === 0) return <EmptyChart heightClass={pieCfg.className} />;
  return (
    <div className="flex flex-1 flex-col gap-2">
      <ChartContainer config={config} className={pieCfg.className}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="key"
            innerRadius={donut ? pieCfg.innerRadius : 0}
            outerRadius={pieCfg.outerRadius}
            paddingAngle={donut ? 2 : 0}
            cursor={onDrill ? "pointer" : undefined}
            onClick={onDrill ? (entry) => {
              const key = drillKeyFromChartEntry(entry);
              if (key != null) onDrill(key);
            } : undefined}
          >
            {rows.map((row, idx) => (
              <Cell
                key={row.key}
                fill={chartColours[idx % chartColours.length]}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div
        className={cn(
          "grid grid-cols-1 gap-x-3 gap-y-1",
          (widget?.width === "half" || widget?.width === "full") &&
            "sm:grid-cols-2",
        )}
        data-testid={widget ? `widget-legend-${widget.id}` : undefined}
      >
        {rows.map((row, idx) => {
          const value = Number(row.value) || 0;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <div
              key={row.key}
              className={cn(
                "flex min-w-0 items-center gap-2 text-xs",
                onDrill && "cursor-pointer rounded-sm hover-elevate",
              )}
              title={row.key}
              role={onDrill ? "button" : undefined}
              tabIndex={onDrill ? 0 : undefined}
              onClick={onDrill ? () => onDrill(row.key) : undefined}
              onKeyDown={
                onDrill
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onDrill(row.key);
                      }
                    }
                  : undefined
              }
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{
                  backgroundColor: chartColours[idx % chartColours.length],
                }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {row.key}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatNumber(value)}
                <span className="ml-1 text-muted-foreground">({pct}%)</span>
              </span>
            </div>
          );
        })}
      </div>
      <p
        className="text-right text-xs text-muted-foreground"
        data-testid={widget ? `widget-total-${widget.id}` : undefined}
      >
        Total: {formatNumber(total)}
      </p>
    </div>
  );
}

function ListBody({ payload, widget, onDrill = null, palette }) {
  const rows = payload.rows || [];
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  const listH = LIST_HEIGHT_CLASS[widget.height] || LIST_HEIGHT_CLASS.medium;
  if (rows.length === 0) return <EmptyChart heightClass={listH.min} />;
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        className={cn("flex-1 overflow-y-auto rounded-md border", listH.min, listH.max)}
        data-testid={`widget-list-${widget.id}`}
      >
        {rows.map((row, idx) => (
          <div
            key={`${row.key}-${idx}`}
            className={cn(
              "flex items-center justify-between gap-3 px-3 py-1.5 text-sm",
              idx > 0 && "border-t",
              onDrill && "cursor-pointer hover-elevate",
            )}
            data-testid={`widget-list-row-${widget.id}-${idx}`}
            role={onDrill ? "button" : undefined}
            tabIndex={onDrill ? 0 : undefined}
            onClick={onDrill ? () => onDrill(row.key) : undefined}
            onKeyDown={
              onDrill
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onDrill(row.key);
                    }
                  }
                : undefined
            }
          >
            <span className="min-w-0 flex-1 truncate" title={row.key}>
              {row.key}
            </span>
            <span
              className="shrink-0 tabular-nums font-medium"
              style={{ color: resolveDashboardWidgetColour(palette, widget.config?.color) }}
            >
              {formatNumber(row.value)}
            </span>
          </div>
        ))}
      </div>
      <p
        className="text-right text-xs text-muted-foreground"
        data-testid={`widget-total-${widget.id}`}
      >
        {rows.length} group{rows.length === 1 ? "" : "s"} · Total: {formatNumber(total)}
      </p>
    </div>
  );
}

function EmptyChart({ heightClass }) {
  const cls = heightClass || STAT_HEIGHT_CLASS.medium;
  return (
    <div
      className={cn(
        "flex items-center justify-center text-sm text-muted-foreground",
        cls,
      )}
    >
      No data yet.
    </div>
  );
}

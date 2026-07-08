import { useMemo } from "react";
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
  MoreVertical,
  PencilLine,
  Trash2,
  Maximize2,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";
import { rowsToCsv, slugifyFilename, downloadCsv } from "@/lib/csvExport";

const COLOUR_MAP = {
  default: "hsl(var(--chart-1))",
  emerald: "hsl(var(--chart-2))",
  amber: "hsl(var(--chart-3))",
  violet: "hsl(var(--chart-4))",
  rose: "hsl(var(--chart-5))",
};

function pickColour(widget) {
  return COLOUR_MAP[widget?.config?.color] || COLOUR_MAP.default;
}

const CHART_COLOURS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

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

const NEXT_WIDTH = { fifth: "third", third: "half", half: "full", full: "fifth" };
const WIDTH_LABEL = { fifth: "1/5", third: "1/3", half: "1/2", full: "Full" };

// Build the rows that drive the CSV export from the already-loaded widget
// payload. Returns an array of row arrays (first row is the header). Chart
// widgets export one row per data point (Label,Value) plus a Total row when
// the widget view shows one; stat widgets export a single metric row.
function buildExportRows(widget, payload) {
  if (!payload) return [];
  const type = widget.widget_type;
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
}) {
  const { toast } = useToast();
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
        </div>
        {canEdit && onResize && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Resize widget (currently ${WIDTH_LABEL[widget.width] || "1/3"})`}
                  data-testid={`button-widget-resize-${widget.id}`}
                  onClick={() => onResize(widget, NEXT_WIDTH[widget.width] || "third")}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Resize · now {WIDTH_LABEL[widget.width] || "1/3"}
              </TooltipContent>
            </Tooltip>
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
          <WidgetBody widget={widget} payload={data.data} />
        )}
      </CardContent>
    </Card>
  );
}

function WidgetBody({ widget, payload }) {
  if (!payload) return null;
  switch (widget.widget_type) {
    case "stat":
      return <StatBody widget={widget} payload={payload} />;
    case "bar":
      return <BarBody payload={payload} widget={widget} />;
    case "pie":
      return <PieBody payload={payload} donut={false} widget={widget} />;
    case "donut":
      return <PieBody payload={payload} donut={true} widget={widget} />;
    case "line":
      return <LineBody payload={payload} widget={widget} />;
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unsupported widget type: {widget.widget_type}
        </p>
      );
  }
}

function StatBody({ widget, payload }) {
  const value = payload.type === "scalar" ? payload.value : payload.rows?.[0]?.value;
  const aggregator = widget.config?.measure?.aggregator || "count";
  return (
    <div className="flex flex-1 flex-col justify-center gap-1">
      <p
        className="text-3xl font-semibold tracking-tight"
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

function chartConfig() {
  return { value: { label: "Value", color: CHART_COLOURS[0] } };
}

function BarBody({ payload, widget }) {
  const rows = payload.rows || [];
  const colour = pickColour(widget);
  const config = useMemo(() => ({ value: { label: "Value", color: colour } }), [colour]);
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  if (rows.length === 0) {
    return <EmptyChart />;
  }
  return (
    <div className="flex flex-1 flex-col gap-2">
      <ChartContainer config={config} className="h-44 w-full">
        <BarChart data={rows} margin={{ top: 18, right: 10, left: 0, bottom: 30 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            interval={0}
            angle={-25}
            textAnchor="end"
            height={50}
          />
          <YAxis tickLine={false} axisLine={false} width={40} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" fill={colour} radius={[4, 4, 0, 0]}>
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

function LineBody({ payload, widget }) {
  const rows = payload.rows || [];
  const colour = pickColour(widget);
  const config = useMemo(() => ({ value: { label: "Value", color: colour } }), [colour]);
  if (rows.length === 0) return <EmptyChart />;
  return (
    <ChartContainer config={config} className="h-56 w-full">
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

function PieBody({ payload, donut, widget }) {
  const rows = payload.rows || [];
  const config = useMemo(() => {
    const built = {};
    rows.forEach((row, idx) => {
      built[row.key] = {
        label: row.key,
        color: CHART_COLOURS[idx % CHART_COLOURS.length],
      };
    });
    return built;
  }, [rows]);
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  if (rows.length === 0) return <EmptyChart />;
  return (
    <div className="flex flex-1 flex-col gap-2">
      <ChartContainer config={config} className="h-40 w-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="key"
            innerRadius={donut ? 50 : 0}
            outerRadius={80}
            paddingAngle={donut ? 2 : 0}
          >
            {rows.map((row, idx) => (
              <Cell
                key={row.key}
                fill={CHART_COLOURS[idx % CHART_COLOURS.length]}
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
              className="flex min-w-0 items-center gap-2 text-xs"
              title={row.key}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{
                  backgroundColor: CHART_COLOURS[idx % CHART_COLOURS.length],
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

function EmptyChart() {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      No data yet.
    </div>
  );
}

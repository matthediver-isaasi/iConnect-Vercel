import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeWidgetConfig } from "@shared/widgetDescriber.js";
import { MEMBER_GROUP_MEASURES, groupHistoryNotice } from "./memberGroupReporting";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Legend,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  GripVertical,
  Info,
  MoreVertical,
  PencilLine,
  RefreshCw,
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

/**
 * Canvas widgets intentionally use a different request URL and React Query
 * identity from the dashboard card.  The endpoint applies the presentation
 * policy server-side, and sharing the dashboard cache entry here could show
 * data fetched for the previous presentation (or identity).
 */
export function widgetRequestUrl(path, embedded = false) {
  if (!embedded) return path;
  return `${path}${path.includes("?") ? "&" : "?"}embed=canvas`;
}

export function widgetDataQueryKey(widgetId, embedded = false, queryScope = null) {
  const key = ["/api/dashboard/widgets", widgetId, "data"];
  if (!embedded) {
    return queryScope === null || queryScope === undefined || queryScope === ""
      ? key
      : [...key, "dashboard", String(queryScope)];
  }
  // A Canvas page may render the same widget more than once. Scope is also
  // rotated by the Canvas host when its auth identity changes, so an old
  // user's response cannot be painted while the new request is in flight.
  if (queryScope === null || queryScope === undefined || queryScope === "") {
    return [...key, "canvas"];
  }
  return [...key, "canvas", String(queryScope)];
}

const MAX_CACHE_POLL_ATTEMPTS = 8;
const MAX_CACHE_POLL_MS = 2 * 60 * 1000;

export function cachePollDelay(cache, pollState, now = Date.now()) {
  const outcome = cache?.refresh?.outcome;
  const requestId = cache?.requestId || "initial";
  const pending = cache?.pending === true
    || cache?.status === "pending"
    || outcome === "accepted"
    || outcome === "queued";
  if (!pending || (requestId !== "initial" && cache?.completedRequestId === requestId)) {
    pollState.requestId = null;
    pollState.startedAt = 0;
    pollState.attempts = 0;
    pollState.exhausted = false;
    pollState.notified = false;
    return false;
  }

  if (pollState.requestId !== requestId) {
    pollState.requestId = requestId;
    pollState.startedAt = now;
    pollState.attempts = 0;
    pollState.exhausted = false;
    pollState.notified = false;
  }
  if (pollState.attempts >= MAX_CACHE_POLL_ATTEMPTS
      || now - pollState.startedAt >= MAX_CACHE_POLL_MS) {
    pollState.exhausted = true;
    return false;
  }

  const retryAfter = Number(cache?.retryAfterSeconds);
  const baseMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : 1000;
  const remainingMs = Math.max(1, MAX_CACHE_POLL_MS - (now - pollState.startedAt));
  const delay = Math.min(30000, remainingMs, baseMs * (2 ** pollState.attempts));
  pollState.attempts += 1;
  return delay;
}

export function mergeWidgetResponse(previous, next) {
  if (!next || typeof next !== "object") return previous;
  if (next.data != null || previous?.data == null) return next;
  return { ...next, data: previous.data };
}

export function completedRefreshOutcome(cache, requestId) {
  if (!requestId || cache?.completedRequestId !== requestId) return null;
  return ["success", "failed"].includes(cache?.completedRequestOutcome)
    ? cache.completedRequestOutcome
    : null;
}

/**
 * Read the actual Canvas block box rather than using the dashboard's saved
 * height preset.  A zero-sized initial value is intentional: Responsive-
 * Container will settle as soon as the block has been laid out.
 */
function readElementContentSize(element) {
  if (!element) return { width: 0, height: 0 };
  return {
    // offsetWidth/offsetHeight are untransformed layout pixels, unlike
    // getBoundingClientRect (which includes editor zoom and transforms).
    width: Number(element.offsetWidth) || 0,
    height: Number(element.offsetHeight) || 0,
  };
}

function useElementSize(enabled) {
  const elementRef = useRef(null);
  const observerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useCallback((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementRef.current = node;
    if (!enabled || !node) return;
    const update = (next) => {
      const width = Number(next?.width) || 0;
      const height = Number(next?.height) || 0;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    update(readElementContentSize(node));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const contentRect = entries[0]?.contentRect;
      if (contentRect) update(contentRect);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, [enabled]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementRef.current = null;
  }, []);

  return [ref, size];
}

function embeddedChartHeight(size, reserved = 0) {
  if (!size?.height) return undefined;
  return Math.max(1, Math.floor(size.height - reserved));
}

function embeddedChartStyle(size, reserved = 0) {
  const height = embeddedChartHeight(size, reserved);
  return height ? { height: `${height}px` } : undefined;
}

function getEmbeddedBarProps(size, reserved = 28) {
  const height = embeddedChartHeight(size, reserved);
  const usableHeight = height || 176;
  const width = size?.width || 0;
  return {
    className: "h-full min-h-0 w-full",
    chartHeight: height,
    // Keep labels readable at the actual block width/height without using
    // the dashboard's persisted height option.
    xAxisHeight: Math.max(36, Math.min(110, Math.round(usableHeight * 0.3))),
    angle: width > 0 && width < 360 ? -40 : usableHeight < 150 ? -18 : -25,
  };
}

function getEmbeddedPieConfig(size) {
  const chartHeight = embeddedChartHeight(size, 52);
  const usableHeight = chartHeight || 176;
  const usableWidth = size?.width || usableHeight;
  const outerRadius = Math.max(
    16,
    Math.floor(Math.min(usableWidth, usableHeight) / 2) - 10,
  );
  return {
    className: "h-full min-h-0 w-full",
    style: chartHeight ? { height: `${chartHeight}px` } : undefined,
    outerRadius,
    innerRadius: Math.max(10, Math.floor(outerRadius * 0.58)),
  };
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
export function buildExportRows(widget, payload) {
  if (!payload) return [];
  const type = widget.widget_type;
  if (widget.config?.source === "member_group") {
    const categories = payload.categories?.length ? payload.categories : ["value"];
    const rows = payload.type === "scalar" ? [{ key: MEMBER_GROUP_MEASURES.find(m => m.field === widget.config.measure?.field)?.label || "Value", value: payload.value }] : payload.rows || [];
    return [
      ["Label", ...categories.map(c => payload.seriesLabels?.[c] || c), "Status"],
      ...rows.map(row => [row.key, ...categories.map(c => row[c] == null ? "Unavailable" : row[c]), row.available === false ? "Unavailable" : row.provisional ? "Current / provisional" : ""]),
    ];
  }
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
  embedded = false,
  queryScope = null,
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
  const queryClient = useQueryClient();
  const [drillingKey, setDrillingKey] = useState(null);
  const [refreshFeedback, setRefreshFeedback] = useState(null);
  const [activeRefreshRequestId, setActiveRefreshRequestId] = useState(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const refreshControllerRef = useRef(null);
  const requestEpochRef = useRef(0);
  const pollStateRef = useRef({
    requestId: null,
    startedAt: 0,
    attempts: 0,
    exhausted: false,
    notified: false,
  });
  const [contentRef, contentSize] = useElementSize(embedded);
  const dataQueryKey = useMemo(
    () => widgetDataQueryKey(widget.id, embedded, queryScope),
    [widget.id, embedded, queryScope],
  );
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    // Canvas and dashboard responses are deliberately never cache-compatible.
    queryKey: dataQueryKey,
    ...(embedded && {
      // Embedded cards must not leave an identity-specific response behind
      // after their Canvas instance/auth scope unmounts.
      gcTime: 0,
      staleTime: 0,
      refetchOnMount: "always",
    }),
    queryFn: async ({ signal }) => {
      const requestEpoch = requestEpochRef.current;
      const res = await fetch(
        widgetRequestUrl(`/api/dashboard/widgets/${widget.id}/data`, embedded),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body = await res.json();
      // A data request started before a manual refresh must never replace the
      // refresh response, even when a test double or transport ignores abort.
      if (requestEpoch !== requestEpochRef.current) {
        return queryClient.getQueryData(dataQueryKey);
      }
      return mergeWidgetResponse(queryClient.getQueryData(dataQueryKey), body);
    },
    refetchInterval: query => {
      const cache = query.state.data?.cache;
      const delay = cachePollDelay(cache, pollStateRef.current);
      if (delay === false
          && pollStateRef.current.exhausted
          && !pollStateRef.current.notified) {
        pollStateRef.current.notified = true;
        queueMicrotask(() => setPollTimedOut(true));
      }
      return delay;
    },
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    setRefreshFeedback(null);
    setActiveRefreshRequestId(null);
    setPollTimedOut(false);
    pollStateRef.current = {
      requestId: null,
      startedAt: 0,
      attempts: 0,
      exhausted: false,
      notified: false,
    };
    return () => {
      requestEpochRef.current += 1;
      refreshControllerRef.current?.abort();
      queryClient.cancelQueries({ queryKey: dataQueryKey, exact: true });
      if (embedded || queryScope) {
        queryClient.removeQueries({ queryKey: dataQueryKey, exact: true });
      }
    };
  }, [dataQueryKey, embedded, queryClient, queryScope]);

  const cache = data?.cache || null;
  const payload = data?.data || null;
  const cachePending = refreshFeedback?.kind === "pending"
    || cache?.pending
    || cache?.status === "pending";
  const refreshPending = cachePending && !pollTimedOut;
  const displayedRefreshFeedback = pollTimedOut
    ? {
        kind: "error",
        message: "Refresh is taking longer than expected. Try again.",
      }
    : refreshFeedback;

  useEffect(() => {
    if (!pollTimedOut) return;
    setActiveRefreshRequestId(null);
    setRefreshFeedback(null);
  }, [pollTimedOut]);

  useEffect(() => {
    if (cachePending || !pollTimedOut) return;
    setPollTimedOut(false);
  }, [cachePending, pollTimedOut]);

  const pendingRequestKey = cachePending ? (cache?.requestId || "initial") : null;
  useEffect(() => {
    if (!pendingRequestKey || pollTimedOut) return undefined;
    const startedAt = pollStateRef.current.startedAt || Date.now();
    const remainingMs = Math.max(0, MAX_CACHE_POLL_MS - (Date.now() - startedAt));
    const timeout = window.setTimeout(() => setPollTimedOut(true), remainingMs);
    return () => window.clearTimeout(timeout);
  }, [pendingRequestKey, pollTimedOut]);

  useEffect(() => {
    if (refreshFeedback?.kind !== "pending" || !activeRefreshRequestId || !cache) return;
    const refresh = cache.refresh;
    const completedOutcome = completedRefreshOutcome(cache, activeRefreshRequestId);
    if (!completedOutcome
        && cache.requestId
        && cache.requestId !== activeRefreshRequestId) return;
    if (completedOutcome === "failed" || refresh?.outcome === "failed") {
      setRefreshFeedback({
        kind: "error",
        message: cache.error || "The refresh failed. Existing data is still shown.",
      });
      setActiveRefreshRequestId(null);
    } else if (completedOutcome === "success" || refresh?.outcome === "success") {
      setRefreshFeedback({ kind: "success", message: "Widget refreshed." });
      setActiveRefreshRequestId(null);
    }
  }, [
    activeRefreshRequestId,
    cache?.completedRequestId,
    cache?.completedRequestOutcome,
    cache?.error,
    cache?.refresh?.outcome,
    cache?.requestId,
    refreshFeedback?.kind,
  ]);

  useEffect(() => {
    if (refreshFeedback?.kind !== "success") return undefined;
    const timeout = window.setTimeout(() => setRefreshFeedback(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [refreshFeedback?.kind]);

  const handleRefresh = async () => {
    if (refreshPending) return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    requestEpochRef.current += 1;
    await queryClient.cancelQueries({ queryKey: dataQueryKey, exact: true });
    pollStateRef.current = {
      requestId: null,
      startedAt: 0,
      attempts: 0,
      exhausted: false,
      notified: false,
    };
    setPollTimedOut(false);
    setActiveRefreshRequestId(null);
    setRefreshFeedback({ kind: "pending", message: "Refresh requested." });
    try {
      const res = await fetch(
        widgetRequestUrl(`/api/dashboard/widgets/${widget.id}/refresh`, embedded),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const retry = Number(body.retryAfterSeconds);
        const suffix = Number.isFinite(retry) && retry > 0
          ? ` Try again in ${Math.ceil(retry)} seconds.`
          : "";
        throw new Error(`${body.error || `Request failed (${res.status})`}${suffix}`);
      }
      const refresh = body.cache?.refresh;
      const outcome = refresh?.outcome;
      const requestId = body.cache?.requestId || null;
      // Also fence any poll which began after the initial cancellation but
      // before the refresh request completed.
      requestEpochRef.current += 1;
      queryClient.setQueryData(
        dataQueryKey,
        previous => mergeWidgetResponse(previous, body),
      );
      if (outcome === "cooldown") {
        setRefreshFeedback({
          kind: "error",
          message: "Refresh cooling down. Existing data is still shown.",
        });
      } else if (outcome === "failed"
          || body.cache?.status === "failed") {
        setRefreshFeedback({
          kind: "error",
          message: body.cache.error || "The refresh failed. Existing data is still shown.",
        });
      } else if (outcome === "success"
          || (requestId
            && body.cache?.completedRequestId === requestId
            && body.cache?.completedRequestOutcome === "success")) {
        setRefreshFeedback({ kind: "success", message: "Widget refreshed." });
      } else if ((outcome === "accepted" || outcome === "queued") && requestId) {
        setActiveRefreshRequestId(requestId);
        setRefreshFeedback({ kind: "pending", message: "Refresh requested." });
      } else {
        setRefreshFeedback({
          kind: "error",
          message: "The refresh response could not be confirmed. Existing data is still shown.",
        });
      }
    } catch (refreshError) {
      if (refreshError?.name !== "AbortError") {
        setRefreshFeedback({
          kind: "error",
          message: refreshError?.message || "Unable to refresh widget.",
        });
      }
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
      }
    }
  };

  // Click-through: enabled by the widget's clickThrough flag for
  // organisation / member sourced group-by widgets. Clicking a bar,
  // slice, legend entry or list row fetches the ids behind that bucket
  // and opens the CRM list filtered to exactly those records.
  const drillRoute = DRILL_ROUTES[widget.config?.source] || null;
  const drillEnabled =
    widget.config?.source !== "member_group" &&
    !!widget.config?.clickThrough &&
    !!drillRoute &&
    (!!widget.config?.groupBy || widget.config?.participation === true) &&
    payload?.type === "group";
  const handleDrill = async (key) => {
    if (!drillEnabled || drillingKey) return;
    setDrillingKey(key);
    try {
      const res = await fetch(
        widgetRequestUrl(
          `/api/dashboard/widgets/${widget.id}/drilldown`,
          embedded,
        ),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        },
      );
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

  const cardLoading = isLoading && !payload;
  const canExport = !!payload;
  const handleExportCsv = () => {
    if (!canExport) return;
    const exportRows = buildExportRows(widget, payload);
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
      data-embedded={embedded ? "true" : undefined}
      className={cn("flex h-full w-full flex-col", embedded && "min-h-0 overflow-hidden")}
    >
      <CardHeader
        className={cn(
          "flex flex-row items-start justify-between gap-2 space-y-0 pb-2",
          embedded && "shrink-0",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {dragHandleProps && !embedded && (
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
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label={refreshPending ? `Refreshing ${widget.title}` : `Refresh ${widget.title}`}
                aria-busy={refreshPending ? "true" : undefined}
                disabled={refreshPending}
                onClick={handleRefresh}
                data-testid={`button-refresh-widget-${widget.id}`}
              >
                <RefreshCw className={cn("h-4 w-4", refreshPending && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {refreshPending ? "Refreshing widget" : "Refresh widget data"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {!embedded && canEdit && (onResize || onResizeHeight) && (
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
        {(!embedded || canExport) && (
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
                Export displayed data (CSV)
              </DropdownMenuItem>
              {!embedded && canEdit && (
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
        )}
      </CardHeader>
      <CardContent
        ref={contentRef}
        className={cn(
          "flex flex-1 flex-col",
          embedded && "min-h-0 overflow-hidden",
        )}
      >
        <WidgetCacheStatus
          cache={cache}
          isFetching={isFetching}
          networkError={isError && payload ? error : null}
          refreshFeedback={displayedRefreshFeedback}
          pendingOverride={refreshPending}
          widgetId={widget.id}
        />
        {drillEnabled && cache?.updatedAt && (
          <p
            className="mb-2 text-xs text-muted-foreground"
            data-testid={`widget-live-drilldown-note-${widget.id}`}
          >
            Click-through opens live records, which may differ from this cached result.
          </p>
        )}
        {cardLoading && (
          <div
            className={cn(
              "space-y-2",
              embedded && "min-h-0 flex-1 overflow-hidden",
            )}
            data-testid={`widget-loading-${widget.id}`}
          >
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className={cn("h-32 w-full", embedded && "max-h-full")} />
          </div>
        )}
        {isError && !payload && (
          <div
            className={cn(
              "flex flex-1 flex-col items-start justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive",
              embedded && "min-h-0 overflow-auto",
            )}
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
        {!cardLoading && !payload && !isError && refreshPending && (
          <div
            className="flex flex-1 items-center justify-center py-8 text-sm text-muted-foreground"
            data-testid={`widget-pending-${widget.id}`}
          >
            Preparing widget data…
          </div>
        )}
        {!cardLoading && !payload && !isError && pollTimedOut && (
          <div
            className="flex flex-1 items-center justify-center py-8 text-sm text-muted-foreground"
            data-testid={`widget-pending-timeout-${widget.id}`}
          >
            Current data is taking longer than expected. Use refresh to try again.
          </div>
        )}
        {!cardLoading && payload && (
          <WidgetBody
            widget={widget}
            payload={payload}
            onDrill={drillEnabled ? handleDrill : null}
            palette={palette}
            embedded={embedded}
            containerSize={contentSize}
          />
        )}
      </CardContent>
    </Card>
  );
}

function formatCacheUpdatedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function WidgetCacheStatus({
  cache,
  isFetching = false,
  networkError = null,
  refreshFeedback = null,
  pendingOverride,
  widgetId,
}) {
  const updatedAt = formatCacheUpdatedAt(cache?.updatedAt);
  const status = cache?.status;
  const pending = pendingOverride ?? (cache?.pending || status === "pending");
  let message = updatedAt ? `Updated ${updatedAt}` : null;
  let tone = "text-muted-foreground";
  let Icon = CheckCircle2;

  if (pending) {
    message = updatedAt
      ? `Refreshing · Showing data updated ${updatedAt}`
      : "Preparing current data";
    tone = "text-blue-700";
    Icon = RefreshCw;
  } else if (status === "stale") {
    message = updatedAt
      ? `Stale · Last updated ${updatedAt}`
      : "Stale data · Update time unavailable";
    tone = "text-amber-700";
    Icon = AlertTriangle;
  } else if (status === "failed") {
    message = updatedAt
      ? `Refresh failed · Showing data updated ${updatedAt}`
      : "Refresh failed";
    tone = "text-destructive";
    Icon = AlertTriangle;
  }

  if (networkError) {
    message = `Update check failed · ${networkError.message || "Existing data is still shown"}`;
    tone = "text-destructive";
    Icon = AlertTriangle;
  }

  const feedbackMessage = refreshFeedback?.message;
  if (refreshFeedback?.kind === "error") {
    tone = "text-destructive";
    Icon = AlertTriangle;
  } else if (refreshFeedback?.kind === "success") {
    Icon = CheckCircle2;
  }
  const displayedMessage = feedbackMessage && message
    ? `${feedbackMessage} · ${message}`
    : (feedbackMessage || message || "Checking for updated data…");
  if (!message && !feedbackMessage && !isFetching) return null;

  return (
    <div
      className={cn("mb-2 flex min-h-4 items-center gap-1.5 text-xs", tone)}
      data-testid={`widget-cache-status-${widgetId}`}
      role={refreshFeedback?.kind === "error" || status === "failed" ? "alert" : "status"}
      aria-live="polite"
      aria-atomic="true"
    >
      {(message || isFetching) && (
        <Icon
          className={cn(
            "h-3 w-3 shrink-0",
            (pending || (isFetching && !message && !feedbackMessage)) && "animate-spin",
          )}
          aria-hidden="true"
        />
      )}
      <span>
        {displayedMessage}
        {status === "failed" && cache?.error ? `: ${cache.error}` : ""}
      </span>
    </div>
  );
}

export function WidgetBody(props) {
  if (props.widget.config?.source !== "member_group") return <ChartBody {...props} />;
  const { payload, widget } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="member-group-report">
      <ChartBody {...props} onDrill={null} />
      <p className="text-xs text-muted-foreground" data-testid="member-group-history">
        {groupHistoryNotice(payload)}
        {payload?.historyBaseline ? ` Reliable history starts ${payload.historyBaseline}.` : ""}
        {widget.config.measure?.field === "period_end_members" ? " Current period is provisional; gaps are unavailable, not zero." : ""}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Counting rules and eligibility · no member click-through</summary>
        <p className="mt-1">{describeWidgetConfig(widget.config, { widgetType: widget.widget_type })}</p>
      </details>
    </div>
  );
}

function ChartBody({
  widget,
  payload,
  onDrill = null,
  palette,
  embedded = false,
  containerSize,
}) {
  if (!payload) return null;
  if (payload.type === "conversion") {
    return (
      <ConversionBody
        widget={widget}
        payload={payload}
        palette={palette}
        embedded={embedded}
      />
    );
  }
  switch (widget.widget_type) {
    case "stat":
      return (
        <StatBody
          widget={widget}
          payload={payload}
          palette={palette}
          embedded={embedded}
        />
      );
    case "bar":
      return (
        <BarBody
          payload={payload}
          widget={widget}
          onDrill={onDrill}
          palette={palette}
          embedded={embedded}
          containerSize={containerSize}
        />
      );
    case "pie":
      return (
        <PieBody
          payload={payload}
          donut={false}
          widget={widget}
          onDrill={onDrill}
          palette={palette}
          embedded={embedded}
          containerSize={containerSize}
        />
      );
    case "donut":
      return (
        <PieBody
          payload={payload}
          donut={true}
          widget={widget}
          onDrill={onDrill}
          palette={palette}
          embedded={embedded}
          containerSize={containerSize}
        />
      );
    case "line":
      return (
        <LineBody
          payload={payload}
          widget={widget}
          palette={palette}
          embedded={embedded}
          containerSize={containerSize}
        />
      );
    case "list":
      return (
        <ListBody
          payload={payload}
          widget={widget}
          onDrill={onDrill}
          palette={palette}
          embedded={embedded}
        />
      );
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unsupported widget type: {widget.widget_type}
        </p>
      );
  }
}

function StatBody({ widget, payload, palette, embedded = false }) {
  const value = payload.type === "scalar"
    ? payload.value
    : widget.config?.source === "member_group"
      ? payload.type === "time" ? payload.rows?.at(-1)?.value : payload.total
      : payload.rows?.[0]?.value;
  const aggregator = widget.config?.measure?.aggregator || "count";
  const minH = embedded
    ? "h-full min-h-0"
    : STAT_HEIGHT_CLASS[widget.height] || STAT_HEIGHT_CLASS.medium;
  return (
    <div className={cn("flex flex-1 flex-col justify-center gap-1", minH)}>
      <p
        className="text-3xl font-semibold tracking-tight"
      style={{ color: resolveDashboardWidgetColour(palette, widget.config?.color) }}
        data-testid={`stat-value-${widget.id}`}
      >
        {widget.config?.source === "member_group" && value == null ? "Unavailable" : formatNumber(value, widget.config?.numberFormat)}
      </p>
      <p className="text-xs uppercase text-muted-foreground">
        {widget.config?.source === "member_group"
          ? MEMBER_GROUP_MEASURES.find(m => m.field === widget.config.measure?.field)?.label
          : widget.config?.transition?.mode
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
function ConversionBody({ widget, payload, palette, embedded = false }) {
  const rate = payload.conversionRate;
  const entityLabel =
    payload.matchBy === "member" ? "members" : "organisations";
  const minH = embedded
    ? "h-full min-h-0"
    : STAT_HEIGHT_CLASS[widget.height] || STAT_HEIGHT_CLASS.medium;
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

function BarBody({
  payload,
  widget,
  onDrill = null,
  palette,
  embedded = false,
  containerSize,
}) {
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
              { label: payload.seriesLabels?.[c] || c, color: chartColours[i % chartColours.length] },
            ]),
          )
        : { value: { label: "Value", color: colour } },
    [categories, colour, chartColours, payload.seriesLabels],
  );
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  const heightKey = widget.height || "medium";
  const barProps = embedded
    ? getEmbeddedBarProps(containerSize, categories ? 56 : 28)
    : getBarHeightProps(heightKey);
  const chartStyle = embedded
    ? embeddedChartStyle(containerSize, categories ? 56 : 28)
    : undefined;
  if (rows.length === 0) {
    return (
      <EmptyChart
        heightClass={barProps.className}
        style={chartStyle}
        embedded={embedded}
      />
    );
  }

  if (categories) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-col gap-2",
          embedded && "min-h-0 overflow-hidden",
        )}
      >
        <ChartContainer
          config={config}
          className={barProps.className}
          style={chartStyle}
        >
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
                name={payload.seriesLabels?.[c] || c}
                stackId={widget.config?.source === "member_group" ? undefined : "series"}
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
                {payload.seriesLabels?.[c] || c}
              </span>
            ))}
          </div>
          <p
            className="text-right text-xs text-muted-foreground"
            data-testid={`widget-total-${widget.id}`}
          >
            {widget.config?.source === "member_group" ? "Group counts are not an overall headcount" : `Total: ${formatNumber(total)}`}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-2",
        embedded && "min-h-0 overflow-hidden",
      )}
    >
      <ChartContainer
        config={config}
        className={barProps.className}
        style={chartStyle}
      >
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
        {widget.config?.source === "member_group" ? "Group counts are not an overall headcount" : `Total: ${formatNumber(total)}`}
      </p>
    </div>
  );
}

function LineBody({ payload, widget, palette, embedded = false, containerSize }) {
  const rows = payload.rows || [];
  const colour = resolveDashboardWidgetColour(palette, widget?.config?.color);
  const colours = dashboardWidgetChartColours(palette);
  const categories = payload.categories?.length ? payload.categories : ["value"];
  const config = Object.fromEntries(categories.map((key, i) => [key, { label: payload.seriesLabels?.[key] || key, color: categories.length === 1 ? colour : colours[i % colours.length] }]));
  const lineClass = embedded
    ? "h-full min-h-0 w-full"
    : LINE_HEIGHT_CLASS[widget.height] || LINE_HEIGHT_CLASS.medium;
  const lineStyle = embedded ? embeddedChartStyle(containerSize) : undefined;
  if (rows.length === 0) {
    return (
      <EmptyChart
        heightClass={lineClass}
        style={lineStyle}
        embedded={embedded}
      />
    );
  }
  return (
    <ChartContainer config={config} className={lineClass} style={lineStyle}>
      <LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="key" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {categories.length > 1 && <Legend />}
        {categories.map(key => <Line
          key={key}
          type="monotone"
          dataKey={key}
          name={config[key].label}
          stroke={config[key].color}
          strokeWidth={2}
          dot={false}
          connectNulls={false}
        />)}
      </LineChart>
    </ChartContainer>
  );
}

function PieBody({
  payload,
  donut,
  widget,
  onDrill = null,
  palette,
  embedded = false,
  containerSize,
}) {
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
  const pieCfg = embedded
    ? getEmbeddedPieConfig(containerSize)
    : PIE_HEIGHT_CONFIG[widget.height] || PIE_HEIGHT_CONFIG.medium;
  if (rows.length === 0) {
    return (
      <EmptyChart
        heightClass={pieCfg.className}
        style={pieCfg.style}
        embedded={embedded}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-2",
        embedded && "min-h-0 overflow-hidden",
      )}
    >
      <ChartContainer
        config={config}
        className={pieCfg.className}
        style={pieCfg.style}
      >
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
          (embedded
            ? (containerSize?.width || 0) >= 400
            : widget?.width === "half" || widget?.width === "full") &&
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
        {widget.config?.source === "member_group" ? "Group counts are not an overall headcount" : `Total: ${formatNumber(total)}`}
      </p>
    </div>
  );
}

function ListBody({ payload, widget, onDrill = null, palette, embedded = false }) {
  const rows = payload.rows || [];
  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r.value) || 0), 0),
    [rows],
  );
  const listH = embedded
    ? { min: "min-h-0", max: "max-h-full" }
    : LIST_HEIGHT_CLASS[widget.height] || LIST_HEIGHT_CLASS.medium;
  if (rows.length === 0) {
    return <EmptyChart heightClass={listH.min} embedded={embedded} />;
  }
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-2",
        embedded && "min-h-0 overflow-hidden",
      )}
    >
      <div
        className={cn(
          "flex-1 overflow-y-auto rounded-md border",
          embedded && "min-h-0",
          listH.min,
          listH.max,
        )}
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
              {widget.config?.source === "member_group" && payload.categories?.some(c => c !== "value")
                ? payload.categories.map(c => `${payload.seriesLabels?.[c] || c}: ${row[c] == null ? "Unavailable" : formatNumber(row[c])}`).join(" · ")
                : widget.config?.source === "member_group" && row.value == null ? "Unavailable" : formatNumber(row.value)}
            </span>
          </div>
        ))}
      </div>
      <p
        className="text-right text-xs text-muted-foreground"
        data-testid={`widget-total-${widget.id}`}
      >
        {rows.length} group{rows.length === 1 ? "" : "s"}
        {widget.config?.source === "member_group" ? " · Group counts are not an overall headcount" : ` · Total: ${formatNumber(total)}`}
      </p>
    </div>
  );
}

function EmptyChart({ heightClass, style, embedded = false }) {
  const cls = heightClass || STAT_HEIGHT_CLASS.medium;
  return (
    <div
      className={cn(
        "flex items-center justify-center text-sm text-muted-foreground",
        embedded &&
          "min-h-0 max-h-full flex-1 overflow-hidden",
        cls,
      )}
      style={style}
    >
      No data yet.
    </div>
  );
}

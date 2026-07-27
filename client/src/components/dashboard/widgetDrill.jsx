import { useMemo } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Dashboard widget click-through support for CRM list pages.
 *
 * A widget click stores the bucket's record ids in sessionStorage under a
 * nonce and navigates to the list page with `?widgetDrill=<nonce>`. The
 * list page reads the payload via this hook, restricts its paginated
 * query with an `ids` param, and shows a dismissible chip describing the
 * active drill filter.
 */
export function useWidgetDrill(searchParams, setSearchParams) {
  const nonce = searchParams.get("widgetDrill") || null;
  const drill = useMemo(() => {
    if (!nonce) return null;
    try {
      const raw = sessionStorage.getItem(`widget-drill:${nonce}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.ids) || parsed.ids.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }, [nonce]);

  const clear = () => {
    if (nonce) {
      try {
        sessionStorage.removeItem(`widget-drill:${nonce}`);
      } catch {
        // ignore storage errors
      }
    }
    const next = new URLSearchParams(searchParams);
    next.delete("widgetDrill");
    setSearchParams(next, { replace: true });
  };

  return {
    drill,
    drillIdsParam: drill ? drill.ids.join(",") : "",
    clearDrill: clear,
  };
}

export function WidgetDrillChip({ drill, onClear }) {
  if (!drill) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
      data-testid="chip-widget-drill"
    >
      <Badge variant="secondary" className="max-w-full">
        <span className="truncate">{drill.label || "Dashboard selection"}</span>
      </Badge>
      <span className="text-muted-foreground">
        Showing {drill.ids.length}
        {drill.truncated ? ` of ${drill.total}` : ""} record
        {drill.ids.length === 1 ? "" : "s"} from this dashboard group
        {drill.truncated ? " (list capped)" : ""}.
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Clear dashboard filter"
        data-testid="button-clear-widget-drill"
        onClick={onClear}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

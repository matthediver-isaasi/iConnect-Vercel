import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { apiRequest } from "@/lib/queryClient";
import {
  Accessibility,
  Loader2,
  Play,
  Trash2,
  Download,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

const SEVERITY_ORDER = ["critical", "serious", "moderate", "minor"];

const SEVERITY_STYLES = {
  critical: "bg-red-600 text-white",
  serious: "bg-orange-500 text-white",
  moderate: "bg-amber-400 text-black",
  minor: "bg-slate-300 text-black",
};

function SeverityBadge({ impact, count }) {
  const cls = SEVERITY_STYLES[impact] || "";
  return (
    <Badge
      className={cls}
      data-testid={`badge-severity-${impact}`}
    >
      {impact}: {count}
    </Badge>
  );
}

function SeverityRow({ audit }) {
  return (
    <div className="flex flex-wrap gap-2">
      <SeverityBadge impact="critical" count={audit.critical_count || 0} />
      <SeverityBadge impact="serious" count={audit.serious_count || 0} />
      <SeverityBadge impact="moderate" count={audit.moderate_count || 0} />
      <SeverityBadge impact="minor" count={audit.minor_count || 0} />
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function AuditDetailDialog({ audit, open, onOpenChange, onRerunUrl }) {
  const { toast } = useToast();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rerunningUrl, setRerunningUrl] = useState(null);

  const load = useCallback(async () => {
    if (!audit) return;
    setLoading(true);
    try {
      const res = await apiRequest("GET", `/api/admin/accessibility-audits/${audit.id}`);
      setDetail(res);
    } catch (err) {
      toast({
        title: "Failed to load audit",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [audit, toast]);

  const handleRerunUrl = useCallback(
    async (url) => {
      setRerunningUrl(url);
      try {
        await onRerunUrl(url);
      } finally {
        setRerunningUrl(null);
      }
    },
    [onRerunUrl],
  );

  useEffect(() => {
    if (open && audit) {
      setDetail(null);
      load();
    }
  }, [open, audit, load]);

  const results = detail?.results || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-audit-detail-title">
            Accessibility audit detail
          </DialogTitle>
          <DialogDescription>
            Run on {formatDate(audit?.created_at)} by {audit?.requested_by_name || "—"}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && detail && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <SeverityRow audit={detail.data} />
                <div className="text-sm text-muted-foreground" data-testid="text-audit-score">
                  Score: {detail.data?.score ?? "—"} · Passes: {detail.data?.pass_count ?? 0} · Violations: {detail.data?.violation_count ?? 0}
                </div>
              </CardContent>
            </Card>

            {results.map((r) => (
              <ResultBlock
                key={r.id}
                result={r}
                onRerunUrl={onRerunUrl ? handleRerunUrl : null}
                isRerunning={rerunningUrl === r.url}
                rerunDisabled={!!rerunningUrl}
              />
            ))}

            {results.length === 0 && (
              <p className="text-sm text-muted-foreground">No URL results recorded.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultBlock({ result, onRerunUrl, isRerunning, rerunDisabled }) {
  const violations = result?.axe_result?.violations || [];

  const grouped = useMemo(() => {
    const byImpact = { critical: [], serious: [], moderate: [], minor: [], other: [] };
    for (const v of violations) {
      const key = SEVERITY_ORDER.includes(v.impact) ? v.impact : "other";
      byImpact[key].push(v);
    }
    return byImpact;
  }, [violations]);

  return (
    <Card data-testid={`card-result-${result.id}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-base break-all flex items-start gap-2 min-w-0">
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline inline-flex items-center gap-1"
              data-testid={`link-result-url-${result.id}`}
            >
              {result.url}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardTitle>
          {onRerunUrl && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRerunUrl(result.url)}
              disabled={rerunDisabled}
              data-testid={`button-rerun-url-${result.id}`}
            >
              {isRerunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Re-run this URL
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {result.status === "failed" ? (
          <div className="flex items-start gap-2 text-sm text-destructive" data-testid={`text-result-error-${result.id}`}>
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{result.error_message || "Audit failed for this URL."}</span>
          </div>
        ) : (
          <>
            <SeverityRow audit={result} />
            <div className="text-sm text-muted-foreground">
              Score: {result.score ?? "—"} · Passes: {result.pass_count ?? 0} · Violations: {result.violation_count ?? 0}
            </div>

            {SEVERITY_ORDER.map((impact) =>
              grouped[impact].length > 0 ? (
                <div key={impact} className="space-y-2">
                  <h4 className="text-sm font-semibold capitalize" data-testid={`heading-impact-${impact}-${result.id}`}>
                    {impact} ({grouped[impact].length} rule{grouped[impact].length === 1 ? "" : "s"})
                  </h4>
                  <div className="space-y-2">
                    {grouped[impact].map((rule) => (
                      <RuleCard key={rule.id} rule={rule} />
                    ))}
                  </div>
                </div>
              ) : null,
            )}

            {violations.length === 0 && result.status === "complete" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4" />
                No violations detected.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RuleCard({ rule }) {
  const nodes = Array.isArray(rule.nodes) ? rule.nodes : [];
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid={`rule-${rule.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="font-medium text-sm">{rule.help || rule.id}</div>
          <div className="text-xs text-muted-foreground">{rule.description}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(rule.tags || [])
            .filter((t) => t.startsWith("wcag") || t === "best-practice")
            .map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
        </div>
      </div>
      {rule.helpUrl && (
        <a
          href={rule.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
        >
          Learn more <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {nodes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {nodes.length} affected element{nodes.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2">
            {nodes.slice(0, 20).map((n, i) => (
              <li key={i} className="rounded-sm bg-muted p-2 space-y-1">
                <code className="block break-all">{(n.target || []).join(" ")}</code>
                {n.failureSummary && (
                  <div className="text-muted-foreground whitespace-pre-wrap">{n.failureSummary}</div>
                )}
                {n.html && (
                  <pre className="overflow-x-auto bg-background p-1 rounded text-[10px]">{n.html}</pre>
                )}
              </li>
            ))}
            {nodes.length > 20 && (
              <li className="text-muted-foreground">…and {nodes.length - 20} more.</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function AccessibilityAudits() {
  const { toast } = useToast();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [urlsText, setUrlsText] = useState("");
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("page_AccessibilityAudits")) {
        window.location.href = createPageUrl("Dashboard");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const loadAudits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest("GET", "/api/admin/accessibility-audits");
      setAudits(res.data || []);
    } catch (err) {
      toast({
        title: "Failed to load audits",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (accessChecked) loadAudits();
  }, [accessChecked, loadAudits]);

  const handleRun = useCallback(
    async (urlsInput) => {
      const urls = (urlsInput ?? urlsText)
        .split(/\s+|,/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length === 0) {
        toast({
          title: "No URLs provided",
          description: "Paste one or more URLs to audit.",
          variant: "destructive",
        });
        return;
      }
      setRunning(true);
      try {
        const res = await apiRequest("POST", "/api/admin/accessibility-audits", { urls });
        toast({
          title: "Audit complete",
          description: `Scanned ${urls.length} URL${urls.length === 1 ? "" : "s"}.`,
        });
        setUrlsText("");
        await loadAudits();
        if (res?.data?.id) {
          setSelected(res.data);
        }
      } catch (err) {
        toast({
          title: "Audit failed",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setRunning(false);
      }
    },
    [urlsText, toast, loadAudits],
  );

  const handleDelete = useCallback(
    async (audit) => {
      try {
        await apiRequest("DELETE", `/api/admin/accessibility-audits/${audit.id}`);
        toast({ title: "Audit deleted" });
        setConfirmDelete(null);
        await loadAudits();
      } catch (err) {
        toast({
          title: "Failed to delete",
          description: err.message,
          variant: "destructive",
        });
      }
    },
    [toast, loadAudits],
  );

  const handleRerun = useCallback(
    async (audit) => {
      const urls = audit.urls || [];
      if (urls.length === 0) return;
      await handleRun(urls.join("\n"));
    },
    [handleRun],
  );

  const handleRerunSingleUrl = useCallback(
    async (url) => {
      try {
        await apiRequest("POST", "/api/admin/accessibility-audits", { urls: [url] });
        toast({ title: "Re-ran URL", description: url });
        await loadAudits();
      } catch (err) {
        toast({
          title: "Re-run failed",
          description: err.message,
          variant: "destructive",
        });
      }
    },
    [toast, loadAudits],
  );

  const handleExport = useCallback((audit) => {
    const url = `/api/admin/accessibility-audits/${audit.id}?format=json&download=1`;
    window.open(url, "_blank");
  }, []);

  if (!isAccessReady || !accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="heading-page-title">
            <Accessibility className="h-6 w-6" />
            Accessibility Audits
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Scan public pages with axe-core via browserless.io. Results are stored per tenant.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run a new audit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            placeholder="Paste one or more URLs (one per line or comma-separated). Max 10 per run."
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={4}
            data-testid="input-audit-urls"
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={() => handleRun()}
              disabled={running || !urlsText.trim()}
              data-testid="button-run-audit"
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Run audit
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={loadAudits}
              disabled={loading}
              data-testid="button-refresh-audits"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Past audits</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && audits.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-audits">
              No audits yet. Paste some URLs above to run your first scan.
            </p>
          )}
          <div className="space-y-2">
            {audits.map((a) => (
              <div
                key={a.id}
                className="rounded-md border p-3 hover-elevate flex flex-col gap-2"
                data-testid={`row-audit-${a.id}`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setSelected(a)}
                    className="flex-1 text-left min-w-0"
                    data-testid={`button-open-audit-${a.id}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {a.status === "failed" ? (
                        <ShieldAlert className="h-4 w-4 text-destructive" />
                      ) : (
                        <Accessibility className="h-4 w-4" />
                      )}
                      <span>{formatDate(a.created_at)}</span>
                      <Badge variant="secondary" className="text-xs">{a.status}</Badge>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {(a.urls || []).slice(0, 3).join(", ")}
                      {(a.urls || []).length > 3 && ` +${a.urls.length - 3} more`}
                    </div>
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityRow audit={a} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRerun(a)}
                    disabled={running}
                    data-testid={`button-rerun-${a.id}`}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Re-run
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleExport(a)}
                    data-testid={`button-export-${a.id}`}
                  >
                    <Download className="h-4 w-4" />
                    Export JSON
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(a)}
                    data-testid={`button-delete-${a.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <AuditDetailDialog
        audit={selected}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        onRerunUrl={handleRerunSingleUrl}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this audit?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the audit and all per-URL results. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

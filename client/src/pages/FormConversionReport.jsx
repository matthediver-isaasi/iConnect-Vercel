import { useState, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeftRight, Building2, Users, ChevronLeft, ChevronRight, Loader2, FileText, Percent, CheckCircle2, XCircle, Download } from "lucide-react";
import { format, parseISO } from "date-fns";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useSavedExportReports } from "@/hooks/useSavedExportReports";
import ExportReportSwitcher from "@/components/ExportReportSwitcher";

const PAGE_SIZE = 25;

const formatDate = (iso) => {
  try {
    return format(parseISO(iso), "d MMM yyyy");
  } catch {
    return iso;
  }
};

function DatesCell({ dates }) {
  if (!dates || dates.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const shown = dates.slice(0, 3);
  return (
    <span>
      {shown.map(formatDate).join(", ")}
      {dates.length > 3 && (
        <span className="text-muted-foreground"> +{dates.length - 3} more</span>
      )}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, loading, testId }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-muted">
            <Icon className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            {loading ? (
              <Skeleton className="h-6 w-16 mt-0.5" />
            ) : (
              <p className="text-xl font-semibold" data-testid={testId}>{value}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FormConversionReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  // Report configuration
  const [sourceFormId, setSourceFormId] = useState("");
  const [targetFormId, setTargetFormId] = useState("");
  const [matchBy, setMatchBy] = useState("organization");
  const [comparison, setComparison] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const handleExportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        sourceFormId,
        targetFormId,
        matchBy,
        comparison,
        export: "1",
      });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const res = await fetch(`/api/reports/form-conversion-report?${params}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `form-conversion-report-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("forms.conversion-report")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Reset to page 1 whenever the config changes
  useEffect(() => {
    setPage(1);
  }, [sourceFormId, targetFormId, matchBy, comparison, dateFrom, dateTo]);

  const { data: forms = [], isLoading: formsLoading } = useQuery({
    queryKey: ["forms-for-conversion-report"],
    enabled: accessChecked,
    queryFn: async () => {
      const all = await base44.entities.Form.list();
      return (all || []).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    },
    staleTime: 60 * 1000,
  });

  const configValid = !!sourceFormId && !!targetFormId && sourceFormId !== targetFormId;
  const sameFormSelected = !!sourceFormId && !!targetFormId && sourceFormId === targetFormId;

  const {
    data: report,
    isLoading: reportLoading,
    isFetching: reportFetching,
    error: reportError,
  } = useQuery({
    queryKey: [
      "form-conversion-report",
      sourceFormId,
      targetFormId,
      matchBy,
      comparison,
      dateFrom,
      dateTo,
      page,
    ],
    enabled: accessChecked && configValid,
    keepPreviousData: true,
    queryFn: async () => {
      const params = new URLSearchParams({
        sourceFormId,
        targetFormId,
        matchBy,
        comparison,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const res = await fetch(`/api/reports/form-conversion-report?${params}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      return res.json();
    },
  });

  // ---- Saved reports -------------------------------------------------------
  const savedReports = useSavedExportReports({
    settingKey: "form_conversion_reports",
    description: "Saved Form Conversion Report configurations",
    enabled: accessChecked,
  });

  const currentConfig = useMemo(
    () => ({ sourceFormId, targetFormId, matchBy, comparison, dateFrom, dateTo }),
    [sourceFormId, targetFormId, matchBy, comparison, dateFrom, dateTo]
  );

  const isDirty = useMemo(() => {
    const active = savedReports.activeReport;
    if (!active) return false;
    const c = active.config || {};
    return (
      (c.sourceFormId || "") !== sourceFormId ||
      (c.targetFormId || "") !== targetFormId ||
      (c.matchBy || "organization") !== matchBy ||
      (c.comparison || "all") !== comparison ||
      (c.dateFrom || "") !== dateFrom ||
      (c.dateTo || "") !== dateTo
    );
  }, [savedReports.activeReport, sourceFormId, targetFormId, matchBy, comparison, dateFrom, dateTo]);

  const applyReport = (r) => {
    const c = r.config || {};
    setSourceFormId(c.sourceFormId || "");
    setTargetFormId(c.targetFormId || "");
    setMatchBy(c.matchBy === "member" ? "member" : "organization");
    setComparison(["converted", "not_converted"].includes(c.comparison) ? c.comparison : "all");
    setDateFrom(c.dateFrom || "");
    setDateTo(c.dateTo || "");
    savedReports.setActiveReportId(r.id);
  };

  if (!accessChecked) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const stats = report?.stats;
  const rows = report?.rows || [];
  const pagination = report?.pagination;
  const isOrgMode = (report?.matchBy || matchBy) === "organization";
  const showLoading = configValid && (reportLoading || reportFetching);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowLeftRight className="w-6 h-6" />
            Form Conversion Report
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            See which organisations or members completed both a source and a target form.
          </p>
        </div>
        <ExportReportSwitcher
          reports={savedReports.reports}
          activeReportId={savedReports.activeReportId}
          isDirty={isDirty}
          isSaving={savedReports.isSaving}
          onApplyReport={applyReport}
          onClearReport={() => savedReports.setActiveReportId(null)}
          onCreateReport={(name) =>
            savedReports.createReport(name, currentConfig).then((r) => {
              savedReports.setActiveReportId(r.id);
            })
          }
          onUpdateReport={(r) => savedReports.updateReport(r.id, currentConfig)}
          onRenameReport={(r, name) => savedReports.renameReport(r.id, name)}
          onDeleteReport={(r) => savedReports.deleteReport(r.id)}
          testIdPrefix="conversion-report"
        />
      </div>

      {/* Config panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Report configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Source form</Label>
            <Select value={sourceFormId} onValueChange={setSourceFormId}>
              <SelectTrigger data-testid="select-source-form">
                <SelectValue placeholder={formsLoading ? "Loading..." : "Choose form"} />
              </SelectTrigger>
              <SelectContent>
                {forms.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name || "(Untitled form)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Target form</Label>
            <Select value={targetFormId} onValueChange={setTargetFormId}>
              <SelectTrigger data-testid="select-target-form">
                <SelectValue placeholder={formsLoading ? "Loading..." : "Choose form"} />
              </SelectTrigger>
              <SelectContent>
                {forms.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name || "(Untitled form)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Match by</Label>
            <Select value={matchBy} onValueChange={setMatchBy}>
              <SelectTrigger data-testid="select-match-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">Organisation</SelectItem>
                <SelectItem value="member">Member (email)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Comparison</Label>
            <Select value={comparison} onValueChange={setComparison}>
              <SelectTrigger data-testid="select-comparison">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="converted">Has received (converted)</SelectItem>
                <SelectItem value="not_converted">Has not received</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Target from</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              data-testid="input-date-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Target to</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              data-testid="input-date-to"
            />
          </div>
        </CardContent>
      </Card>

      {sameFormSelected && (
        <Card>
          <CardContent className="p-4 text-sm text-warning" data-testid="text-same-form-warning">
            Source and target forms must be different.
          </CardContent>
        </Card>
      )}

      {!configValid && !sameFormSelected ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-config-prompt">
            <FileText className="w-8 h-8 mx-auto mb-3 opacity-50" />
            Choose a source form and a target form above to run the report.
          </CardContent>
        </Card>
      ) : configValid ? (
        <>
          {/* KPI stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              icon={FileText}
              label={isOrgMode ? "Source organisations" : "Source members"}
              value={stats?.sourceEntityCount ?? "—"}
              loading={showLoading && !stats}
              testId="stat-source-entities"
            />
            <StatCard
              icon={CheckCircle2}
              label="Converted"
              value={stats?.convertedCount ?? "—"}
              loading={showLoading && !stats}
              testId="stat-converted"
            />
            <StatCard
              icon={XCircle}
              label="Not converted"
              value={
                stats
                  ? stats.notConvertedCount ??
                    (stats.sourceEntityCount != null &&
                    stats.convertedCount != null
                      ? stats.sourceEntityCount - stats.convertedCount
                      : "—")
                  : "—"
              }
              loading={showLoading && !stats}
              testId="stat-not-converted"
            />
            <StatCard
              icon={Percent}
              label="Conversion rate"
              value={
                stats
                  ? stats.conversionRate == null
                    ? "—"
                    : `${stats.conversionRate.toFixed(1)}%`
                  : "—"
              }
              loading={showLoading && !stats}
              testId="stat-conversion-rate"
            />
          </div>

          {/* Entity table */}
          <Card>
            <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base flex items-center gap-2">
                {isOrgMode ? <Building2 className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                {isOrgMode ? "Organisations" : "Members"}
                {pagination && (
                  <span className="text-sm font-normal text-muted-foreground">
                    ({pagination.totalRows})
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {reportFetching && !reportLoading && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportCsv}
                  disabled={exporting || reportLoading || !!reportError || (pagination && pagination.totalRows === 0)}
                  data-testid="button-export-csv"
                >
                  {exporting ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4 mr-1" />
                  )}
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {exportError && (
                <div className="mb-3 text-sm text-destructive" data-testid="text-export-error">
                  {exportError}
                </div>
              )}
              {reportError ? (
                <div className="p-6 text-center text-sm text-destructive" data-testid="text-report-error">
                  {reportError.message}
                </div>
              ) : reportLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground" data-testid="text-no-results">
                  No {isOrgMode ? "organisations" : "members"} match this configuration.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">
                          {isOrgMode ? "Organisation" : "Email"}
                        </th>
                        <th className="py-2 pr-4 font-medium">Source submitted</th>
                        <th className="py-2 pr-4 font-medium">Target submitted</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.key} className="border-b last:border-0" data-testid={`row-entity-${row.key}`}>
                          <td className="py-2 pr-4 font-medium" data-testid={`text-entity-name-${row.key}`}>
                            {isOrgMode ? (
                              <Link
                                to={`/organisations/${row.key}`}
                                className="hover:underline text-foreground"
                                data-testid={`link-entity-${row.key}`}
                              >
                                {row.name}
                              </Link>
                            ) : row.memberId ? (
                              <Link
                                to={`/members/${row.memberId}`}
                                className="hover:underline text-foreground"
                                data-testid={`link-entity-${row.key}`}
                              >
                                {row.name}
                              </Link>
                            ) : (
                              row.name
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            <DatesCell dates={row.sourceDates} />
                          </td>
                          <td className="py-2 pr-4">
                            <DatesCell dates={row.targetDates} />
                          </td>
                          <td className="py-2">
                            {row.converted ? (
                              <Badge variant="outline" className="gap-1" data-testid={`badge-status-${row.key}`}>
                                <CheckCircle2 className="w-3 h-3" />
                                Converted
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1" data-testid={`badge-status-${row.key}`}>
                                <XCircle className="w-3 h-3" />
                                Not converted
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {pagination && pagination.totalPages > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
                  <p className="text-xs text-muted-foreground" data-testid="text-pagination-info">
                    Page {pagination.page} of {pagination.totalPages}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pagination.page <= 1 || reportFetching}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pagination.page >= pagination.totalPages || reportFetching}
                      onClick={() => setPage((p) => p + 1)}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

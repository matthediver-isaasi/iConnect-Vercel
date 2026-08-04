// Task #3332: Survey reporting & exports — /SurveyReports.
//
// Server-side aggregation via /api/reports/survey-report. Deep-linkable:
//   /SurveyReports?formId=<survey>            per-survey report
//   /SurveyReports?formId=<s>&assignment=<a>  per-survey-per-event report
import { useState, useMemo, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as ChartTooltip, Legend,
} from "recharts";
import {
  Loader2, BarChart3, Download, HelpCircle, ChevronLeft, ChevronRight,
  Search, Table as TableIcon, AlertTriangle, Lock, ExternalLink,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";

const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 1000) / 10}%`);
const num = (v) => (v === null || v === undefined ? "—" : v);
const fmtDate = (v) => {
  if (!v) return "—";
  try { return format(parseISO(v), "d MMM yyyy"); } catch { return v; }
};

function MetricHelp({ text }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex align-middle text-muted-foreground" aria-label={`Explanation: ${text}`}>
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm">{text}</TooltipContent>
    </Tooltip>
  );
}

function SummaryCard({ title, value, help, testId }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          {title} {help && <MetricHelp text={help} />}
        </div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

// Chart wrapper with an accessible table alternative toggle.
function ChartWithTable({ title, description, children, tableHeader, tableRows, testId }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setShowTable((v) => !v)} data-testid={`${testId}-toggle-table`}>
            <TableIcon className="w-4 h-4 mr-1" />
            {showTable ? "Chart" : "Table"}
          </Button>
        </div>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent>
        {showTable ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={`${title} (data table)`}>
              <thead>
                <tr className="border-b text-left">
                  {tableHeader.map((h) => <th key={h} className="py-1.5 pr-3 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {r.map((c, j) => <td key={j} className="py-1.5 pr-3">{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div role="img" aria-label={`${title} chart. Use the Table button for a text alternative.`}>
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SurveyReports() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("forms.survey-reports")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // ---- filters --------------------------------------------------------------
  const [formId, setFormId] = useState(() => searchParams.get("formId") || "");
  const [versionNumber, setVersionNumber] = useState("all");
  const [assignmentIds, setAssignmentIds] = useState(() => {
    const a = searchParams.get("assignment");
    return a ? [a] : [];
  });
  const [eventDateFrom, setEventDateFrom] = useState("");
  const [eventDateTo, setEventDateTo] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [category, setCategory] = useState("all");
  const [identityType, setIdentityType] = useState("all");
  const [completion, setCompletion] = useState("all");
  const [dateBasis, setDateBasis] = useState("event"); // default: event date

  useEffect(() => {
    const next = new URLSearchParams();
    if (formId) next.set("formId", formId);
    if (assignmentIds.length === 1) next.set("assignment", assignmentIds[0]);
    setSearchParams(next, { replace: true });
  }, [formId, assignmentIds, setSearchParams]);

  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (formId) p.set("formId", formId);
    if (versionNumber !== "all") p.set("versionNumber", versionNumber);
    if (assignmentIds.length > 0) p.set("assignmentIds", assignmentIds.join(","));
    if (eventDateFrom) p.set("eventDateFrom", eventDateFrom);
    if (eventDateTo) p.set("eventDateTo", eventDateTo);
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);
    if (category !== "all") p.set("category", category);
    if (identityType !== "all") p.set("identityType", identityType);
    if (completion !== "all") p.set("completion", completion);
    p.set("dateBasis", dateBasis);
    return p;
  }, [formId, versionNumber, assignmentIds, eventDateFrom, eventDateTo, dateFrom, dateTo, category, identityType, completion, dateBasis]);

  const filterKey = filterParams.toString();

  const fetchJson = async (url) => {
    const res = await fetch(url, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `Request failed (${res.status})`);
      e.code = data.code;
      throw e;
    }
    return data;
  };

  const { data: filtersData } = useQuery({
    queryKey: ["survey-report-filters", formId],
    enabled: accessChecked,
    queryFn: () => fetchJson(`/api/reports/survey-report?view=filters${formId ? `&formId=${formId}` : ""}`),
  });
  const surveys = filtersData?.surveys || [];
  const detail = filtersData?.detail || null;
  const canResponseDetail = filtersData?.canResponseDetail ?? false;

  const { data: report, isLoading: reportLoading, error: reportError } = useQuery({
    queryKey: ["survey-report-summary", filterKey],
    enabled: accessChecked && !!formId,
    queryFn: () => fetchJson(`/api/reports/survey-report?view=summary&${filterKey}`),
  });

  // ---- distribution drilldown ------------------------------------------------
  const [distributionField, setDistributionField] = useState(null);
  const { data: distribution, isLoading: distLoading } = useQuery({
    queryKey: ["survey-report-distribution", filterKey, distributionField],
    enabled: !!distributionField,
    queryFn: () => fetchJson(`/api/reports/survey-report?view=distribution&fieldId=${encodeURIComponent(distributionField)}&${filterKey}`),
  });

  // ---- comments ----------------------------------------------------------------
  const [activeTab, setActiveTab] = useState("results");
  const [commentSearch, setCommentSearch] = useState("");
  const [commentField, setCommentField] = useState("all");
  const [commentPage, setCommentPage] = useState(1);
  useEffect(() => { setCommentPage(1); }, [commentSearch, commentField, filterKey]);
  const commentParams = useMemo(() => {
    const p = new URLSearchParams(filterParams);
    if (commentSearch) p.set("search", commentSearch);
    if (commentField !== "all") p.set("commentFieldId", commentField);
    p.set("page", String(commentPage));
    return p;
  }, [filterParams, commentSearch, commentField, commentPage]);
  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ["survey-report-comments", commentParams.toString()],
    enabled: accessChecked && !!formId && activeTab === "comments",
    queryFn: () => fetchJson(`/api/reports/survey-report?view=comments&${commentParams.toString()}`),
  });

  // ---- responses (permission-gated) ----------------------------------------------
  const [responsePage, setResponsePage] = useState(1);
  useEffect(() => { setResponsePage(1); }, [filterKey]);
  const { data: responsesData, isLoading: responsesLoading, error: responsesError } = useQuery({
    queryKey: ["survey-report-responses", filterKey, responsePage],
    enabled: accessChecked && !!formId && activeTab === "responses" && canResponseDetail,
    queryFn: () => fetchJson(`/api/reports/survey-report?view=responses&${filterKey}&page=${responsePage}`),
  });

  // ---- event comparison sorting ------------------------------------------------
  const [eventSort, setEventSort] = useState({ key: "eventDate", dir: "desc" });
  const sortedEvents = useMemo(() => {
    const rows = [...(report?.events || [])];
    const { key, dir } = eventSort;
    rows.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (key === "eventDate") { av = av ? new Date(av).getTime() : 0; bv = bv ? new Date(bv).getTime() : 0; }
      if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv || "") : (bv || "").localeCompare(av);
      av = av ?? -Infinity; bv = bv ?? -Infinity;
      return dir === "asc" ? av - bv : bv - av;
    });
    return rows;
  }, [report, eventSort]);
  const toggleEventSort = (key) =>
    setEventSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

  // ---- exports --------------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const runExport = async (type, format) => {
    setExporting(true);
    try {
      const res = await fetch(`/api/reports/survey-report?view=export&type=${type}&format=${format}&${filterKey}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `survey-${type}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };
  const exportCommentsCsv = () => {
    window.open(`/api/reports/survey-report?view=comments&export=csv&${commentParams.toString()}`, "_blank");
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const anonSuppressed = report?.anonymity?.suppressed;

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <BarChart3 className="w-7 h-7" /> Survey Reports
            </h1>
            <p className="text-muted-foreground mt-1">
              Aggregated survey results across events, questions and categories.
            </p>
          </div>
          {formId && report && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={exporting} data-testid="button-export">
                  {exporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => runExport("summary", "csv")} data-testid="export-summary-csv">Summary CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => runExport("summary", "xlsx")} data-testid="export-summary-xlsx">Summary XLSX</DropdownMenuItem>
                {canResponseDetail && (
                  <DropdownMenuItem onClick={() => runExport("responses", "xlsx")} data-testid="export-responses-xlsx">
                    Response-level XLSX (all sheets)
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* ---- Filter bar ---- */}
        <Card>
          <CardContent className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Survey</Label>
              <Select value={formId || "none"} onValueChange={(v) => { setFormId(v === "none" ? "" : v); setAssignmentIds([]); setVersionNumber("all"); setCategory("all"); }}>
                <SelectTrigger data-testid="select-survey"><SelectValue placeholder="Choose a survey" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Choose a survey…</SelectItem>
                  {surveys.map((s) => <SelectItem key={s.id} value={s.id}>{s.name || "Untitled survey"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Survey version</Label>
              <Select value={versionNumber} onValueChange={setVersionNumber} disabled={!detail}>
                <SelectTrigger data-testid="select-version"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All versions</SelectItem>
                  {(detail?.versions || []).map((v) => (
                    <SelectItem key={v.id} value={String(v.versionNumber)}>Version {v.versionNumber}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Event</Label>
              <Select
                value={assignmentIds.length === 1 ? assignmentIds[0] : assignmentIds.length === 0 ? "all" : "multi"}
                onValueChange={(v) => setAssignmentIds(v === "all" ? [] : [v])}
                disabled={!detail}
              >
                <SelectTrigger data-testid="select-event"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All events</SelectItem>
                  {(detail?.assignments || []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.eventTitle || "(untitled event)"}{a.eventDate ? ` — ${fmtDate(a.eventDate)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Reporting category</Label>
              <Select value={category} onValueChange={setCategory} disabled={!detail}>
                <SelectTrigger data-testid="select-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {(detail?.categories || []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Event date from</Label>
              <Input type="date" value={eventDateFrom} onChange={(e) => setEventDateFrom(e.target.value)} data-testid="input-event-date-from" />
            </div>
            <div>
              <Label className="text-xs">Event date to</Label>
              <Input type="date" value={eventDateTo} onChange={(e) => setEventDateTo(e.target.value)} data-testid="input-event-date-to" />
            </div>
            <div>
              <Label className="text-xs">Submitted from</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-date-from" />
            </div>
            <div>
              <Label className="text-xs">Submitted to</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="input-date-to" />
            </div>
            <div>
              <Label className="text-xs">Identity type</Label>
              <Select value={identityType} onValueChange={setIdentityType}>
                <SelectTrigger data-testid="select-identity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All responses</SelectItem>
                  <SelectItem value="identified">Identified</SelectItem>
                  <SelectItem value="anonymous">Anonymous</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Completion</Label>
              <Select value={completion} onValueChange={setCompletion}>
                <SelectTrigger data-testid="select-completion"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="partial">Partial</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2 pb-1">
              <div className="flex items-center gap-2">
                <Switch
                  checked={dateBasis === "submission"}
                  onCheckedChange={(v) => setDateBasis(v ? "submission" : "event")}
                  id="date-basis"
                  data-testid="switch-date-basis"
                />
                <Label htmlFor="date-basis" className="text-xs">
                  {dateBasis === "event" ? "Date basis: event date" : "Date basis: submission date"}
                </Label>
                <MetricHelp text="Trends and volume are grouped by the event's date by default. Switch to group by when responses were submitted instead." />
              </div>
            </div>
          </CardContent>
        </Card>

        {!formId && (
          <Card><CardContent className="py-12 text-center text-muted-foreground">
            Choose a survey to see its report.
          </CardContent></Card>
        )}

        {formId && reportError && (
          <Alert variant="destructive"><AlertTitle>Could not load report</AlertTitle>
            <AlertDescription>{reportError.message}</AlertDescription></Alert>
        )}

        {formId && reportLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {formId && report && (
          <>
            {report.multiVersion && (
              <Alert data-testid="alert-multi-version">
                <AlertTriangle className="w-4 h-4" />
                <AlertTitle>Results span multiple survey versions</AlertTitle>
                <AlertDescription>
                  These results include responses from versions {report.versionNumbersPresent.join(", ")}. Questions may
                  differ between versions — use the version filter to compare like for like.
                </AlertDescription>
              </Alert>
            )}
            {report.anonymity?.isAnonymous && (
              <Alert data-testid="alert-anonymous">
                <Lock className="w-4 h-4" />
                <AlertTitle>Anonymous survey</AlertTitle>
                <AlertDescription>
                  Respondent identity is never stored or shown.{" "}
                  {anonSuppressed
                    ? `Respondent-level detail is hidden until at least ${report.anonymity.threshold} responses are received.`
                    : "Individual responses use generated references only."}
                </AlertDescription>
              </Alert>
            )}

            {/* ---- Summary cards ---- */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard title="Responses" value={report.summary.responses} testId="card-responses"
                help="Total survey responses matching the current filters." />
              <SummaryCard title="Completed" value={report.summary.completed} testId="card-completed"
                help="Responses that answered every score question in their survey version (N/A counts as answered)." />
              <SummaryCard title="Partial" value={report.summary.partial} testId="card-partial"
                help="Responses that skipped one or more optional score questions." />
              <SummaryCard title="Avg weighted score" value={pct(report.summary.weightedAverage)} testId="card-weighted"
                help="Weighted overall score across all underlying answers (each answer normalised to 0–100% of its range, weighted by question weight). Never an average of averages." />
              <SummaryCard title="Avg unweighted score" value={pct(report.summary.unweightedAverage)} testId="card-unweighted"
                help="Unweighted overall score: the simple average of all normalised answers included in the overall." />
              <SummaryCard title="Total raw score" value={num(report.summary.totalRawScore)} testId="card-raw-total"
                help="Sum of all raw score values as answered, before normalisation or weighting." />
              <SummaryCard title="Events included" value={report.summary.eventsIncluded} testId="card-events"
                help="Distinct event assignments represented in the filtered responses." />
              <SummaryCard
                title="Avg responses / event"
                value={num(report.summary.avgResponsesPerEvent)}
                testId="card-avg-per-event"
                help="Responses divided by the number of events included."
              />
              {report.summary.responseRate && (
                <SummaryCard title="Response rate" value={pct(report.summary.responseRate.rate)} testId="card-response-rate"
                  help={`Responses divided by ${report.summary.responseRate.denominator} active attendee bookings across the included events. Shown only when every filtered response is tied to an event with attendee data.`} />
              )}
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="results" data-testid="tab-results">Results</TabsTrigger>
                <TabsTrigger value="charts" data-testid="tab-charts">Charts</TabsTrigger>
                <TabsTrigger value="comments" data-testid="tab-comments">Comments</TabsTrigger>
                {canResponseDetail && <TabsTrigger value="responses" data-testid="tab-responses">Responses</TabsTrigger>}
              </TabsList>

              {/* ---------------- Results ---------------- */}
              <TabsContent value="results" className="space-y-6">
                {/* Question results */}
                <Card>
                  <CardHeader><CardTitle className="text-base">Question results</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-questions">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="py-2 pr-3">Question</th>
                          <th className="py-2 pr-3">Category</th>
                          <th className="py-2 pr-3">Range</th>
                          <th className="py-2 pr-3">Valid <MetricHelp text="Answers with a real score (excludes skips and N/A)." /></th>
                          <th className="py-2 pr-3">Skipped <MetricHelp text="Responses whose survey version included this question but gave no answer." /></th>
                          <th className="py-2 pr-3">N/A <MetricHelp text="Respondent explicitly chose Not Applicable." /></th>
                          <th className="py-2 pr-3">Raw avg <MetricHelp text="Average of raw score values on the question's own scale." /></th>
                          <th className="py-2 pr-3">Normalised <MetricHelp text="Average score normalised to 0–100% of the question's range (reverse-scored questions already inverted)." /></th>
                          <th className="py-2 pr-3">Weighted <MetricHelp text="Weight-adjusted average contribution of this question (0–100%)." /></th>
                          <th className="py-2 pr-3">Min/Max</th>
                          <th className="py-2 pr-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.questions.map((q) => (
                          <tr key={q.fieldId} className="border-b last:border-0">
                            <td className="py-2 pr-3 font-medium">{q.label}</td>
                            <td className="py-2 pr-3">{q.category || "—"}</td>
                            <td className="py-2 pr-3">{q.rangeMin}–{q.rangeMax}</td>
                            <td className="py-2 pr-3">{q.validCount}</td>
                            <td className="py-2 pr-3">{q.skippedCount}</td>
                            <td className="py-2 pr-3">{q.naCount}</td>
                            <td className="py-2 pr-3">{num(q.rawAverage)}</td>
                            <td className="py-2 pr-3">{pct(q.normalisedAverage)}</td>
                            <td className="py-2 pr-3">{pct(q.weightedContribution)}</td>
                            <td className="py-2 pr-3">{q.minScore ?? "—"}/{q.maxScore ?? "—"}</td>
                            <td className="py-2 pr-3">
                              <Button variant="outline" size="sm" onClick={() => setDistributionField(q.fieldId)} data-testid={`button-distribution-${q.fieldId}`}>
                                Distribution
                              </Button>
                            </td>
                          </tr>
                        ))}
                        {report.questions.length === 0 && (
                          <tr><td colSpan={11} className="py-6 text-center text-muted-foreground">No scored answers match the current filters.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                {/* Category rollups */}
                <Card>
                  <CardHeader><CardTitle className="text-base">Category results</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-categories">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="py-2 pr-3">Category</th>
                          <th className="py-2 pr-3">Valid answers</th>
                          <th className="py-2 pr-3">N/A</th>
                          <th className="py-2 pr-3">Raw avg</th>
                          <th className="py-2 pr-3">Normalised <MetricHelp text="Average of all normalised answers in this category (computed from underlying answers)." /></th>
                          <th className="py-2 pr-3">Weighted <MetricHelp text="Weight-adjusted category average (0–100%)." /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.categories.map((c) => (
                          <tr key={c.category} className="border-b last:border-0">
                            <td className="py-2 pr-3 font-medium">{c.category}</td>
                            <td className="py-2 pr-3">{c.validCount}</td>
                            <td className="py-2 pr-3">{c.naCount}</td>
                            <td className="py-2 pr-3">{num(c.rawAverage)}</td>
                            <td className="py-2 pr-3">{pct(c.normalisedAverage)}</td>
                            <td className="py-2 pr-3">{pct(c.weightedAverage)}</td>
                          </tr>
                        ))}
                        {report.categories.length === 0 && (
                          <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No categories.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                {/* Event comparison */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Event comparison</CardTitle>
                    <p className="text-xs text-muted-foreground">Cumulative figures are computed from all underlying answers per event — never averages of averages.</p>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-events">
                      <thead>
                        <tr className="border-b text-left">
                          {[["eventTitle", "Event"], ["eventDate", "Date"], ["responses", "Responses"], ["weightedAverage", "Weighted"], ["unweightedAverage", "Unweighted"]].map(([key, label]) => (
                            <th key={key} className="py-2 pr-3">
                              <button type="button" className="font-medium hover:underline" onClick={() => toggleEventSort(key)} data-testid={`sort-${key}`}>
                                {label}{eventSort.key === key ? (eventSort.dir === "asc" ? " ▲" : " ▼") : ""}
                              </button>
                            </th>
                          ))}
                          <th className="py-2 pr-3">Best category</th>
                          <th className="py-2 pr-3">Worst category</th>
                          <th className="py-2 pr-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedEvents.map((e) => (
                          <tr key={e.assignmentId || "none"} className="border-b last:border-0">
                            <td className="py-2 pr-3 font-medium">{e.eventTitle}</td>
                            <td className="py-2 pr-3">{fmtDate(e.eventDate)}</td>
                            <td className="py-2 pr-3">{e.responses}</td>
                            <td className="py-2 pr-3">{pct(e.weightedAverage)}</td>
                            <td className="py-2 pr-3">{pct(e.unweightedAverage)}</td>
                            <td className="py-2 pr-3">{e.bestCategory ? `${e.bestCategory.category} (${pct(e.bestCategory.average)})` : "—"}</td>
                            <td className="py-2 pr-3">{e.worstCategory ? `${e.worstCategory.category} (${pct(e.worstCategory.average)})` : "—"}</td>
                            <td className="py-2 pr-3">
                              {e.assignmentId && (
                                <Button
                                  variant="ghost" size="sm"
                                  onClick={() => setAssignmentIds([e.assignmentId])}
                                  data-testid={`link-event-report-${e.assignmentId}`}
                                >
                                  <ExternalLink className="w-3.5 h-3.5 mr-1" /> Event report
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                        {sortedEvents.length === 0 && (
                          <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No events match the current filters.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ---------------- Charts ---------------- */}
              <TabsContent value="charts" className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <ChartWithTable
                    title="Overall score by event" testId="chart-score-by-event"
                    description="Weighted overall score per event (0–100%)."
                    tableHeader={["Event", "Weighted score", "Responses"]}
                    tableRows={sortedEvents.map((e) => [e.eventTitle, pct(e.weightedAverage), e.responses])}
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={sortedEvents.map((e) => ({ name: e.eventTitle, score: e.weightedAverage !== null ? Math.round(e.weightedAverage * 1000) / 10 : null }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={70} />
                        <YAxis domain={[0, 100]} unit="%" />
                        <ChartTooltip formatter={(v) => [`${v}%`, "Weighted score"]} />
                        <Bar dataKey="score" fill="#6366f1" name="Weighted score" />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartWithTable>

                  <ChartWithTable
                    title="Question comparison" testId="chart-questions"
                    description="Normalised average per question (0–100%)."
                    tableHeader={["Question", "Normalised avg", "Valid answers"]}
                    tableRows={report.questions.map((q) => [q.label, pct(q.normalisedAverage), q.validCount])}
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={report.questions.map((q) => ({ name: q.label, score: q.normalisedAverage !== null ? Math.round(q.normalisedAverage * 1000) / 10 : null }))} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" domain={[0, 100]} unit="%" />
                        <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 11 }} />
                        <ChartTooltip formatter={(v) => [`${v}%`, "Normalised average"]} />
                        <Bar dataKey="score" fill="#10b981" name="Normalised average" />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartWithTable>

                  <ChartWithTable
                    title="Category comparison" testId="chart-categories"
                    description="Weighted average per reporting category (0–100%)."
                    tableHeader={["Category", "Weighted avg", "Valid answers"]}
                    tableRows={report.categories.map((c) => [c.category, pct(c.weightedAverage), c.validCount])}
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={report.categories.map((c) => ({ name: c.category, score: c.weightedAverage !== null ? Math.round(c.weightedAverage * 1000) / 10 : null }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis domain={[0, 100]} unit="%" />
                        <ChartTooltip formatter={(v) => [`${v}%`, "Weighted average"]} />
                        <Bar dataKey="score" fill="#f59e0b" name="Weighted average" />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartWithTable>

                  <ChartWithTable
                    title="Score trend by event date" testId="chart-trend"
                    description="Weighted overall score for each event, in event-date order."
                    tableHeader={["Event", "Date", "Weighted score"]}
                    tableRows={[...sortedEvents].filter((e) => e.eventDate).sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate)).map((e) => [e.eventTitle, fmtDate(e.eventDate), pct(e.weightedAverage)])}
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={[...sortedEvents].filter((e) => e.eventDate).sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate)).map((e) => ({ name: fmtDate(e.eventDate), score: e.weightedAverage !== null ? Math.round(e.weightedAverage * 1000) / 10 : null }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis domain={[0, 100]} unit="%" />
                        <ChartTooltip formatter={(v) => [`${v}%`, "Weighted score"]} />
                        <Legend />
                        <Line type="monotone" dataKey="score" stroke="#6366f1" name="Weighted score" connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartWithTable>

                  <ChartWithTable
                    title="Response volume" testId="chart-volume"
                    description={`Responses per month (${report.dateBasis === "event" ? "by event date" : "by submission date"}).`}
                    tableHeader={["Month", "Responses"]}
                    tableRows={(report.volume || []).map((v) => [v.month, v.count])}
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={report.volume || []}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                        <YAxis allowDecimals={false} />
                        <ChartTooltip />
                        <Bar dataKey="count" fill="#0ea5e9" name="Responses" />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartWithTable>
                </div>
                <p className="text-xs text-muted-foreground">
                  Question distribution charts open from the “Distribution” button in the Results tab.
                </p>
              </TabsContent>

              {/* ---------------- Comments ---------------- */}
              <TabsContent value="comments" className="space-y-4">
                <Card>
                  <CardContent className="pt-4 space-y-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex-1 min-w-52">
                        <Label className="text-xs">Search comments</Label>
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input className="pl-8" value={commentSearch} onChange={(e) => setCommentSearch(e.target.value)} placeholder="Search text…" data-testid="input-comment-search" />
                        </div>
                      </div>
                      <div className="min-w-52">
                        <Label className="text-xs">Question</Label>
                        <Select value={commentField} onValueChange={setCommentField}>
                          <SelectTrigger data-testid="select-comment-question"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All questions</SelectItem>
                            {(commentsData?.commentQuestions || []).map((q) => (
                              <SelectItem key={q.fieldId} value={q.fieldId}>{q.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="outline" onClick={exportCommentsCsv} disabled={commentsData?.suppressed} data-testid="button-export-comments">
                        <Download className="w-4 h-4 mr-2" /> Export CSV
                      </Button>
                    </div>

                    {commentsLoading ? (
                      <div className="py-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>
                    ) : commentsData?.suppressed ? (
                      <Alert>
                        <Lock className="w-4 h-4" />
                        <AlertTitle>Comments hidden</AlertTitle>
                        <AlertDescription>
                          This is an anonymous survey — comments are hidden until at least {commentsData.threshold} responses are received.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        <div className="space-y-3" data-testid="list-comments">
                          {(commentsData?.comments || []).map((c, i) => (
                            <div key={`${c.reference}-${c.fieldId}-${i}`} className="border rounded-md p-3">
                              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mb-1">
                                <Badge variant="outline">{c.reference}</Badge>
                                <span>{fmtDate(c.date)}</span>
                                {c.eventTitle && <span>· {c.eventTitle}</span>}
                                <span>· {c.question}</span>
                              </div>
                              <p className="text-sm whitespace-pre-wrap">{c.text}</p>
                            </div>
                          ))}
                          {(commentsData?.comments || []).length === 0 && (
                            <p className="py-8 text-center text-muted-foreground text-sm">No comments match the current filters.</p>
                          )}
                        </div>
                        {commentsData?.pagination && commentsData.pagination.totalPages > 1 && (
                          <div className="flex items-center justify-between text-sm">
                            <span>Page {commentsData.pagination.page} of {commentsData.pagination.totalPages} ({commentsData.pagination.totalRows} comments)</span>
                            <div className="flex gap-2">
                              <Button variant="outline" size="sm" disabled={commentPage <= 1} onClick={() => setCommentPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
                              <Button variant="outline" size="sm" disabled={commentPage >= commentsData.pagination.totalPages} onClick={() => setCommentPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ---------------- Responses ---------------- */}
              {canResponseDetail && (
                <TabsContent value="responses" className="space-y-4">
                  <Card>
                    <CardContent className="pt-4">
                      {responsesLoading ? (
                        <div className="py-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>
                      ) : responsesError ? (
                        <Alert variant="destructive"><AlertDescription>{responsesError.message}</AlertDescription></Alert>
                      ) : responsesData?.suppressed ? (
                        <Alert>
                          <Lock className="w-4 h-4" />
                          <AlertTitle>Responses hidden</AlertTitle>
                          <AlertDescription>
                            This is an anonymous survey — individual responses are hidden until at least {responsesData.threshold} responses are received.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm" data-testid="table-responses">
                              <thead>
                                <tr className="border-b text-left">
                                  <th className="py-2 pr-3">Reference</th>
                                  {!responsesData?.anonymous && <th className="py-2 pr-3">Respondent</th>}
                                  <th className="py-2 pr-3">Event</th>
                                  <th className="py-2 pr-3">Date</th>
                                  <th className="py-2 pr-3">Version</th>
                                  <th className="py-2 pr-3">Completion</th>
                                  <th className="py-2 pr-3">Weighted</th>
                                  <th className="py-2 pr-3">Unweighted</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(responsesData?.rows || []).map((r) => (
                                  <tr key={r.reference} className="border-b last:border-0">
                                    <td className="py-2 pr-3">
                                      {r.submissionId ? (
                                        <Link className="text-primary hover:underline" to={`${createPageUrl("FormSubmissionView")}?id=${r.submissionId}`}>{r.reference}</Link>
                                      ) : r.reference}
                                    </td>
                                    {!responsesData?.anonymous && (
                                      <td className="py-2 pr-3">{r.respondentName || r.respondentEmail || "—"}</td>
                                    )}
                                    <td className="py-2 pr-3">{r.eventTitle || "—"}</td>
                                    <td className="py-2 pr-3">{fmtDate(r.date)}</td>
                                    <td className="py-2 pr-3">{r.versionNumber ?? "—"}</td>
                                    <td className="py-2 pr-3">
                                      <Badge variant={r.complete ? "secondary" : "outline"}>{r.complete ? "Completed" : "Partial"}</Badge>
                                    </td>
                                    <td className="py-2 pr-3">{pct(r.weightedScore)}</td>
                                    <td className="py-2 pr-3">{pct(r.unweightedScore)}</td>
                                  </tr>
                                ))}
                                {(responsesData?.rows || []).length === 0 && (
                                  <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No responses match the current filters.</td></tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                          {responsesData?.pagination && responsesData.pagination.totalPages > 1 && (
                            <div className="flex items-center justify-between text-sm mt-3">
                              <span>Page {responsesData.pagination.page} of {responsesData.pagination.totalPages} ({responsesData.pagination.totalRows} responses)</span>
                              <div className="flex gap-2">
                                <Button variant="outline" size="sm" disabled={responsePage <= 1} onClick={() => setResponsePage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
                                <Button variant="outline" size="sm" disabled={responsePage >= responsesData.pagination.totalPages} onClick={() => setResponsePage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              )}
            </Tabs>
          </>
        )}

        {/* ---- Distribution dialog (loads on demand) ---- */}
        <Dialog open={!!distributionField} onOpenChange={(o) => { if (!o) setDistributionField(null); }}>
          <DialogContent className="max-w-lg" data-testid="dialog-distribution">
            <DialogHeader>
              <DialogTitle>Response distribution</DialogTitle>
              <DialogDescription>{distribution?.label || ""}</DialogDescription>
            </DialogHeader>
            {distLoading ? (
              <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>
            ) : distribution ? (
              <div className="space-y-3">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={distribution.distribution}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="score" />
                    <YAxis allowDecimals={false} />
                    <ChartTooltip />
                    <Bar dataKey="count" fill="#6366f1" name="Answers" />
                  </BarChart>
                </ResponsiveContainer>
                <table className="w-full text-sm" aria-label="Response distribution (data table)">
                  <thead><tr className="border-b text-left"><th className="py-1 pr-3">Score</th><th className="py-1 pr-3">Answers</th></tr></thead>
                  <tbody>
                    {distribution.distribution.map((d) => (
                      <tr key={d.score} className="border-b last:border-0"><td className="py-1 pr-3">{d.score}</td><td className="py-1 pr-3">{d.count}</td></tr>
                    ))}
                    <tr><td className="py-1 pr-3 text-muted-foreground">N/A</td><td className="py-1 pr-3">{distribution.naCount}</td></tr>
                  </tbody>
                </table>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

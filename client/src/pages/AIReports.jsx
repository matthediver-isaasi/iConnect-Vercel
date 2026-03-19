import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Send,
  Download,
  Loader2,
  BarChart3,
  TrendingUp,
  Hash,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  RefreshCw,
  Table2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--primary))',
];

const EXAMPLE_PROMPTS = [
  "Member count by role",
  "Event bookings this month with event names",
  "Organisation engagement summary",
  "New members over the last 6 months",
  "Top 10 organisations by booking count",
  "Bookings by event type and organisation",
  "Support tickets by status",
];

function SummaryStatCard({ label, value }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground" data-testid={`label-stat-${label}`}>{label}</p>
        <p className="text-2xl font-bold mt-1" data-testid={`text-stat-${label}`}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </p>
      </CardContent>
    </Card>
  );
}

function computeSummaryStats(data, summaryStats) {
  if (!data || data.length === 0 || !summaryStats || summaryStats.length === 0) return [];

  return summaryStats.map((stat) => {
    let filteredData = data;
    if (stat.filter) {
      filteredData = data.filter((row) => {
        for (const [key, val] of Object.entries(stat.filter)) {
          if (row[key] !== val) return false;
        }
        return true;
      });
    }

    let value = 0;
    const col = stat.column;

    switch (stat.type) {
      case 'count':
        value = filteredData.length;
        break;
      case 'sum':
        value = filteredData.reduce((acc, row) => acc + (parseFloat(row[col]) || 0), 0);
        break;
      case 'avg':
        if (filteredData.length > 0) {
          value = filteredData.reduce((acc, row) => acc + (parseFloat(row[col]) || 0), 0) / filteredData.length;
          value = Math.round(value * 100) / 100;
        }
        break;
      case 'max':
        value = Math.max(...filteredData.map((row) => parseFloat(row[col]) || 0));
        break;
      case 'min':
        value = Math.min(...filteredData.map((row) => parseFloat(row[col]) || 0));
        break;
      case 'distinct':
        value = new Set(filteredData.map((row) => row[col])).size;
        break;
      default:
        value = filteredData.length;
    }

    return { label: stat.label, value };
  });
}

function prepareChartData(data, visualization) {
  if (!data || data.length === 0 || !visualization) return [];

  const { xAxis, yAxis, groupBy, aggregation, aggregationColumn } = visualization;

  if (!xAxis?.key) return data.slice(0, 50);

  if (aggregation && aggregation !== 'none') {
    const grouped = {};
    for (const row of data) {
      const xVal = row[xAxis.key] ?? 'Unknown';
      const xKey = xVal instanceof Date ? xVal.toISOString().split('T')[0] : String(xVal);

      if (!grouped[xKey]) {
        grouped[xKey] = { [xAxis.key]: xKey, _items: [] };
      }

      if (groupBy && row[groupBy]) {
        const groupVal = String(row[groupBy]);
        if (!grouped[xKey][groupVal]) {
          grouped[xKey][groupVal] = 0;
          grouped[xKey]._items.push({ group: groupVal });
        }
        const numVal = aggregationColumn ? (parseFloat(row[aggregationColumn]) || 0) : 1;
        if (aggregation === 'count') {
          grouped[xKey][groupVal] += 1;
        } else if (aggregation === 'sum') {
          grouped[xKey][groupVal] += numVal;
        }
      } else {
        const aggCol = aggregationColumn || yAxis?.key;
        const numVal = aggCol ? (parseFloat(row[aggCol]) || 0) : 1;
        if (aggregation === 'count') {
          grouped[xKey].value = (grouped[xKey].value || 0) + 1;
        } else if (aggregation === 'sum') {
          grouped[xKey].value = (grouped[xKey].value || 0) + numVal;
        } else if (aggregation === 'avg') {
          grouped[xKey]._items.push(numVal);
        }
      }
    }

    const result = Object.values(grouped).map((entry) => {
      if (aggregation === 'avg' && !groupBy) {
        const items = entry._items || [];
        entry.value = items.length > 0 ? Math.round((items.reduce((a, b) => a + b, 0) / items.length) * 100) / 100 : 0;
      }
      delete entry._items;
      return entry;
    });

    return result.slice(0, 50);
  }

  return data.slice(0, 50).map((row) => {
    const entry = {};
    entry[xAxis.key] = row[xAxis.key];
    if (yAxis?.key) {
      entry[yAxis.key] = parseFloat(row[yAxis.key]) || row[yAxis.key];
    }
    return entry;
  });
}

function getChartValueKey(visualization, chartData) {
  if (!visualization) return 'value';
  if (visualization.groupBy && chartData.length > 0) {
    const sample = chartData[0];
    const keys = Object.keys(sample).filter(
      (k) => k !== visualization.xAxis?.key && k !== '_items'
    );
    return keys;
  }
  if (visualization.yAxis?.key && !visualization.aggregation) return visualization.yAxis.key;
  return 'value';
}

function ReportChart({ data, visualization }) {
  const chartData = useMemo(() => prepareChartData(data, visualization), [data, visualization]);
  const valueKeys = useMemo(() => getChartValueKey(visualization, chartData), [visualization, chartData]);

  if (!chartData || chartData.length === 0) return null;

  const xKey = visualization?.xAxis?.key || Object.keys(chartData[0])[0];
  const xLabel = visualization?.xAxis?.label || xKey;
  const yLabel = visualization?.yAxis?.label || '';

  const isMultiSeries = Array.isArray(valueKeys);

  if (visualization?.chartType === 'pie') {
    const pieKey = isMultiSeries ? valueKeys[0] : (typeof valueKeys === 'string' ? valueKeys : 'value');
    return (
      <div className="h-80" data-testid="container-chart-pie">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey={pieKey}
              nameKey={xKey}
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
            >
              {chartData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (visualization?.chartType === 'line') {
    return (
      <div className="h-80" data-testid="container-chart-line">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey={xKey} label={{ value: xLabel, position: 'insideBottom', offset: -5 }} tick={{ fontSize: 12 }} />
            <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft' }} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {isMultiSeries
              ? valueKeys.map((key, i) => (
                  <Line key={key} type="monotone" dataKey={key} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
                ))
              : <Line type="monotone" dataKey={typeof valueKeys === 'string' ? valueKeys : 'value'} stroke={CHART_COLORS[0]} strokeWidth={2} dot={{ r: 3 }} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (visualization?.chartType === 'area') {
    return (
      <div className="h-80" data-testid="container-chart-area">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              {(isMultiSeries ? valueKeys : [typeof valueKeys === 'string' ? valueKeys : 'value']).map((key, i) => (
                <linearGradient key={key} id={`gradient-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey={xKey} label={{ value: xLabel, position: 'insideBottom', offset: -5 }} tick={{ fontSize: 12 }} />
            <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft' }} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {isMultiSeries
              ? valueKeys.map((key, i) => (
                  <Area key={key} type="monotone" dataKey={key} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={`url(#gradient-${i})`} strokeWidth={2} />
                ))
              : <Area type="monotone" dataKey={typeof valueKeys === 'string' ? valueKeys : 'value'} stroke={CHART_COLORS[0]} fill="url(#gradient-0)" strokeWidth={2} />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-80" data-testid="container-chart-bar">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
          <XAxis dataKey={xKey} label={{ value: xLabel, position: 'insideBottom', offset: -5 }} tick={{ fontSize: 12 }} angle={chartData.length > 8 ? -45 : 0} textAnchor={chartData.length > 8 ? 'end' : 'middle'} height={chartData.length > 8 ? 80 : 40} />
          <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft' }} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          {isMultiSeries
            ? valueKeys.map((key, i) => (
                <Bar key={key} dataKey={key} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
              ))
            : <Bar dataKey={typeof valueKeys === 'string' ? valueKeys : 'value'} fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DataTable({ data, columns }) {
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');
  const [showAll, setShowAll] = useState(false);

  const tableColumns = useMemo(() => {
    if (columns && columns.length > 0) return columns;
    if (!data || data.length === 0) return [];
    return Object.keys(data[0]).map((key) => ({
      key,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      format: 'text',
    }));
  }, [data, columns]);

  const sortedData = useMemo(() => {
    if (!data) return [];
    let sorted = [...data];
    if (sortColumn) {
      sorted.sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        const aStr = String(aVal);
        const bStr = String(bVal);
        return sortDirection === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
      });
    }
    return sorted;
  }, [data, sortColumn, sortDirection]);

  const displayData = showAll ? sortedData : sortedData.slice(0, 20);

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const formatValue = (value, format) => {
    if (value == null) return '—';
    switch (format) {
      case 'number':
        return typeof value === 'number' ? value.toLocaleString() : value;
      case 'currency':
        return typeof value === 'number'
          ? `£${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : value;
      case 'date':
        try {
          return new Date(value).toLocaleDateString();
        } catch {
          return value;
        }
      default:
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
  };

  if (!data || data.length === 0) return null;

  return (
    <div data-testid="container-data-table">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              {tableColumns.map((col) => (
                <th
                  key={col.key}
                  className="px-4 py-3 text-left font-medium text-muted-foreground cursor-pointer hover-elevate select-none"
                  onClick={() => handleSort(col.key)}
                  data-testid={`th-${col.key}`}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {sortColumn === col.key ? (
                      sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-30" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayData.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b last:border-b-0 hover-elevate">
                {tableColumns.map((col) => (
                  <td key={col.key} className="px-4 py-3" data-testid={`td-${col.key}-${rowIdx}`}>
                    {formatValue(row[col.key], col.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sortedData.length > 20 && (
        <div className="flex justify-center py-3 border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            data-testid="button-toggle-rows"
          >
            {showAll ? (
              <>
                <ChevronUp className="w-4 h-4 mr-1" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4 mr-1" /> Show all {sortedData.length} rows
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function flattenRow(row) {
  const flat = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [subKey, subVal] of Object.entries(value)) {
        flat[`${key}_${subKey}`] = subVal;
      }
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

function flattenData(data) {
  if (!Array.isArray(data) || data.length === 0) return data;
  const hasNested = data.some((row) =>
    Object.values(row).some((v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date))
  );
  if (!hasNested) return data;
  return data.map(flattenRow);
}

export default function AIReports() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const textareaRef = useRef(null);
  const resultsRef = useRef(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_AIReports')) {
        window.location.href = createPageUrl('Dashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const handleGenerate = useCallback(async (overridePrompt) => {
    const userPrompt = overridePrompt || prompt;
    if (!userPrompt.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await apiRequest('POST', '/api/ai-reports/generate', {
        prompt: userPrompt.trim(),
        conversationHistory,
      });

      if (result.error) {
        setError(result.error);
        setReport(null);
      } else {
        if (result.data) {
          result.data = flattenData(result.data);
        }
        setReport(result);
        setError(null);
        setConversationHistory((prev) => [
          ...prev,
          { role: 'user', content: userPrompt.trim() },
          { role: 'assistant', content: JSON.stringify({ title: result.title, description: result.description }) },
        ]);
        setTimeout(() => {
          resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    } catch (err) {
      setError(err.message || 'Failed to generate report. Please try again.');
      setReport(null);
    } finally {
      setIsLoading(false);
      setPrompt('');
    }
  }, [prompt, conversationHistory]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleExportCSV = useCallback(() => {
    if (!report?.data || report.data.length === 0) return;

    const columns = report.columns && report.columns.length > 0
      ? report.columns
      : Object.keys(report.data[0]).map((key) => ({ key, label: key }));

    const headers = columns.map((c) => c.label || c.key);
    const rows = report.data.map((row) =>
      columns.map((c) => {
        const val = row[c.key];
        if (val == null) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      })
    );

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(report.title || 'report').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  }, [report]);

  const handleNewReport = () => {
    setReport(null);
    setError(null);
    setPrompt('');
    setConversationHistory([]);
    textareaRef.current?.focus();
  };

  const summaryValues = useMemo(() => {
    if (!report) return [];
    return computeSummaryStats(report.data, report.summaryStats);
  }, [report]);

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Sparkles className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">AI Report Generator</h1>
            <p className="text-sm text-muted-foreground" data-testid="text-page-description">
              Describe the report you need in plain English
            </p>
          </div>
        </div>
        {report && (
          <Button variant="outline" onClick={handleNewReport} data-testid="button-new-report">
            <RefreshCw className="w-4 h-4 mr-2" />
            New Report
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex gap-2">
            <Textarea
              ref={textareaRef}
              placeholder={report ? "Refine this report... (e.g. 'Break it down by month' or 'Only show active members')" : "Describe the report you want... (e.g. 'Show me member count by organisation type')"}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              className="resize-none min-h-[60px]"
              disabled={isLoading}
              data-testid="input-prompt"
            />
            <Button
              onClick={() => handleGenerate()}
              disabled={isLoading || !prompt.trim()}
              data-testid="button-generate"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>

          {!report && !isLoading && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium">Try these examples:</p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_PROMPTS.map((ep) => (
                  <Badge
                    key={ep}
                    variant="secondary"
                    className="cursor-pointer"
                    onClick={() => {
                      setPrompt(ep);
                      handleGenerate(ep);
                    }}
                    data-testid={`chip-example-${ep.replace(/\s+/g, '-').toLowerCase()}`}
                  >
                    {ep}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center gap-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <div className="text-center">
              <p className="font-medium" data-testid="text-loading">Generating your report...</p>
              <p className="text-sm text-muted-foreground">Analysing your request and querying the database</p>
            </div>
          </CardContent>
        </Card>
      )}

      {error && !isLoading && (
        <Card className="border-destructive/50">
          <CardContent className="p-6 flex items-start gap-4">
            <AlertCircle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive" data-testid="text-error-title">Could not generate report</p>
              <p className="text-sm text-muted-foreground mt-1" data-testid="text-error-message">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {report && !isLoading && (
        <div ref={resultsRef} className="space-y-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-xl font-bold" data-testid="text-report-title">{report.title}</h2>
              {report.description && (
                <p className="text-sm text-muted-foreground mt-1" data-testid="text-report-description">{report.description}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <Table2 className="w-3 h-3" />
                {report.rowCount} rows
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportCSV}
                disabled={!report.data || report.data.length === 0}
                data-testid="button-export-csv"
              >
                <Download className="w-4 h-4 mr-1" />
                Export CSV
              </Button>
            </div>
          </div>

          {summaryValues.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="container-summary-stats">
              {summaryValues.map((stat, i) => (
                <SummaryStatCard key={i} label={stat.label} value={stat.value} />
              ))}
            </div>
          )}

          {report.visualization && report.data && report.data.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" />
                  {report.visualization.chartType === 'bar' && 'Bar Chart'}
                  {report.visualization.chartType === 'line' && 'Line Chart'}
                  {report.visualization.chartType === 'pie' && 'Pie Chart'}
                  {report.visualization.chartType === 'area' && 'Area Chart'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ReportChart data={report.data} visualization={report.visualization} />
              </CardContent>
            </Card>
          )}

          {report.data && report.data.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Table2 className="w-4 h-4" />
                  Data Table
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <DataTable data={report.data} columns={report.columns} />
              </CardContent>
            </Card>
          )}

          {report.data && report.data.length === 0 && (
            <Card>
              <CardContent className="p-12 text-center">
                <Hash className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="font-medium" data-testid="text-no-data">No data found</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Try adjusting your request or using different criteria
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

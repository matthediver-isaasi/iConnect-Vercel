import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useDecisionRounds } from './useAwardDecisions';
import { fetchAwardReportExport, REPORT_COLUMNS, REPORT_LABELS, useAwardReport } from './useAwardReport';
import ReportTable from './ReportTable';
import ReportAssessmentHistory from './ReportAssessmentHistory';
import './awards.css';

export default function ReportingPanel(props) {
  if (!props.canReport) return null;
  return <AwardReporting key={`${props.tenant.scopeKey}:${props.award.id}`} {...props} />;
}

function AwardReporting({ award, tenant }) {
  const rounds = useDecisionRounds(award.id, tenant);
  const [roundId, setRoundId] = useState('');
  const selected = rounds.data?.find(round => round.id === roundId);
  return <Card className="awards-workspace mt-6 min-w-0 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Submitted evidence & assignment status · round-local aliases</p><CardTitle className="text-xl">Reporting & exports</CardTitle><p className="awards-help">Read-only reporting access, independent of approval authority. Judge aliases use the server’s eight-uppercase-hex round-local identifiers; they must not be matched across rounds. Answers and scores are submitted evidence only. Workload shows assignment status and ranking-score availability, never draft answers or draft scores.</p></CardHeader>
    <CardContent className="pt-5 space-y-5">
      <div className="awards-field"><div className="flex justify-between items-center gap-3"><Label htmlFor="award-report-round">Report round</Label><Button type="button" size="sm" variant="outline" disabled={rounds.isFetching} onClick={() => rounds.refetch()}>Reload round list</Button></div>
        {rounds.isLoading ? <Skeleton className="h-10 w-full" /> : rounds.isError ? <p role="alert" className="text-sm text-red-800">{rounds.error.message} Complete round-list access is required for reporting; approval permission is not a substitute.</p> : <select id="award-report-round" className="awards-select" value={roundId} disabled={rounds.isFetching} onChange={event => setRoundId(event.target.value)}><option value="">Choose a round</option>{roundId && !selected && <option value={roundId} disabled>Selected round is no longer available ({roundId})</option>}{rounds.data?.map(round => <option key={round.id} value={round.id}>{round.name}</option>)}</select>}
        {rounds.isSuccess && !rounds.data?.length && <p className="awards-help">No rounds have been configured for this award.</p>}
      </div>
      {selected && rounds.isSuccess ? <RoundReport key={`${tenant.scopeKey}:${selected.id}`} roundId={selected.id} tenant={tenant} />
        : !roundId && <div className="rounded-lg border p-5"><h3 className="text-sm font-semibold">Choose a round to inspect its submitted evidence</h3><p className="awards-help mt-1">Application summaries, judge scores and criterion responses are reported separately. No approval or publication action is available here.</p></div>}
    </CardContent>
  </Card>;
}

function RoundReport({ roundId, tenant }) {
  const query = useAwardReport(roundId, tenant);
  const [section, setSection] = useState('summaries');
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [discrepancyOnly, setDiscrepancyOnly] = useState(false);
  const [workloadState, setWorkloadState] = useState('');
  const [workloadIncluded, setWorkloadIncluded] = useState('');
  const [workloadScored, setWorkloadScored] = useState('');
  const [application, setApplication] = useState('');
  const [criterion, setCriterion] = useState('');
  const [exportFormat, setExportFormat] = useState('csv');
  const [exportSection, setExportSection] = useState('summaries');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true), pending = useRef(null), urls = useRef(new Map());
  useEffect(() => {
    active.current = true;
    const ownedUrls = urls.current;
    return () => {
      active.current = false; pending.current?.abort();
      for (const [url, timer] of ownedUrls) { window.clearTimeout(timer); URL.revokeObjectURL(url); }
      ownedUrls.clear();
    };
  }, []);
  const filtered = useMemo(() => {
    const data = query.data;
    if (!data) return { summaries: [], matrix: [], criteria: [], workload: [], workloadStates: [], applications: [], criteriaOptions: [] };
    const summaries = data.summaries.filter(row => (!incompleteOnly || row.Complete === 'No') && (!discrepancyOnly || row.Discrepancy === 'Yes'));
    const allowed = new Set(summaries.map(row => row.Application));
    const matrix = data.matrix.filter(row => allowed.has(row.Application));
    const criteriaRows = data.criteria.filter(row => allowed.has(row.Application) && row.Application === application);
    const workload = data.workload.filter(row => allowed.has(row.Application));
    return {
      summaries, matrix,
      workload: workload.filter(row => (!workloadState || row.State === workloadState)
        && (!workloadIncluded || row.Included === workloadIncluded) && (!workloadScored || row['Ranking score available'] === workloadScored)),
      workloadStates: [...new Set(data.workload.map(row => row.State))].sort(),
      criteria: application && criterion ? criteriaRows.filter(row => String(row.Criterion) === criterion) : [],
      applications: [...new Set(summaries.map(row => row.Application))],
      criteriaOptions: [...new Set(criteriaRows.map(row => String(row.Criterion)))],
    };
  }, [query.data, incompleteOnly, discrepancyOnly, application, criterion, workloadState, workloadIncluded, workloadScored]);
  const ready = query.isSuccess && !query.isFetching;
  const totals = query.data ? {
    applications: query.data.summaries.length,
    complete: query.data.summaries.filter(row => row.Complete === 'Yes').length,
    incomplete: query.data.summaries.filter(row => row.Complete === 'No').length,
    discrepancies: query.data.summaries.filter(row => row.Discrepancy === 'Yes').length,
    submitted: query.data.matrix.length,
    workload: query.data.workload.length,
  } : null;
  return <div className="space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-3"><div><h3 className="font-semibold">{query.data?.round.name || 'Round report'}</h3><p className="awards-help mt-1">The server reads the complete paged source. Included/excluded flags and scores are shown as reported, not recalculated here.</p></div><Button type="button" variant="outline" size="sm" disabled={query.isFetching || exporting} onClick={() => query.refetch()}>Reload complete report</Button></div>
    {query.isLoading && <div className="space-y-3" aria-label="Loading complete round report"><Skeleton className="h-16 w-full" /><Skeleton className="h-48 w-full" /></div>}
    {query.isError && <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-800">{query.error.message} No partial report or client-generated export is used. Retry “Reload complete report”.</div>}
    {query.isSuccess && <>
      {totals && <dl className="flex flex-wrap gap-x-8 gap-y-4 rounded-lg border bg-[var(--awards-tint)] px-5 py-4">
        {[['Applications', totals.applications], ['Complete', totals.complete], ['Incomplete', totals.incomplete], ['Discrepancy flags', totals.discrepancies], ['Submitted assessment rows', totals.submitted], ['Assignment workload rows', totals.workload]].map(([label, value]) => <div key={label}><dt className="awards-help">{label}</dt><dd className="font-semibold text-xl tabular-nums mt-1">{value}</dd></div>)}
      </dl>}
      <fieldset className="space-y-3 rounded-lg border p-4"><legend className="text-sm font-medium px-1">Local application filters</legend><div className="flex flex-wrap gap-x-6 gap-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={incompleteOnly} onChange={event => setIncompleteOnly(event.target.checked)} />Incomplete only</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={discrepancyOnly} onChange={event => setDiscrepancyOnly(event.target.checked)} />Discrepancy flagged only</label><Button type="button" size="sm" variant="outline" disabled={!incompleteOnly && !discrepancyOnly} onClick={() => { setIncompleteOnly(false); setDiscrepancyOnly(false); }}>Clear application filters</Button></div><p className="awards-help">{filtered.summaries.length} of {totals.applications} applications match. Both filters apply together across all four views. Counts above describe the full report; downloads ignore all local display filters.</p></fieldset>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Round report sections">{Object.entries(REPORT_LABELS).map(([value, label]) => <Button type="button" key={value} size="sm" variant={section === value ? 'default' : 'outline'} aria-pressed={section === value} onClick={() => setSection(value)}>{label}</Button>)}</div>
      {section === 'workload' && <fieldset className="rounded-lg border p-4 space-y-4"><legend className="px-1 text-sm font-semibold">Workload status filters</legend><p className="awards-help">Assignment states are exactly those reported by the server, including assignments without submitted assessments. “Ranking score available” is a server flag, not a draft score or a promise that this assignment contributes to the official score. Inclusion and state are separate fields. No draft answers or draft scores are exposed.</p>
        <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="report-workload-state">Assignment state</Label><select id="report-workload-state" className="awards-select" value={workloadState} onChange={event => setWorkloadState(event.target.value)}><option value="">All reported states</option>{workloadState && !filtered.workloadStates.includes(workloadState) && <option value={workloadState} disabled>Previously selected state (not in current snapshot)</option>}{filtered.workloadStates.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
          <div className="awards-field"><Label htmlFor="report-workload-included">Assignment inclusion</Label><select id="report-workload-included" className="awards-select" value={workloadIncluded} onChange={event => setWorkloadIncluded(event.target.value)}><option value="">Included and excluded</option><option value="Yes">Included</option><option value="No">Excluded</option></select></div>
          <div className="awards-field"><Label htmlFor="report-workload-scored">Ranking score available</Label><select id="report-workload-scored" className="awards-select" value={workloadScored} onChange={event => setWorkloadScored(event.target.value)}><option value="">Available and unavailable</option><option value="Yes">Yes — server reports available</option><option value="No">No — server reports unavailable</option></select></div></div>
        <Button type="button" size="sm" variant="outline" disabled={!workloadState && !workloadIncluded && !workloadScored} onClick={() => { setWorkloadState(''); setWorkloadIncluded(''); setWorkloadScored(''); }}>Clear workload filters</Button><p className="awards-help">{filtered.workload.length} of {totals.workload} workload rows match the application and workload display filters. These filters affect only this view; exports remain server-complete.</p>
      </fieldset>}
      {section === 'criteria' && <div className="rounded-lg border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Inspect submitted criterion responses</h4>
        <div className="awards-field"><Label htmlFor="report-application">Application reference</Label><select id="report-application" className="awards-select" value={application} onChange={event => { setApplication(event.target.value); setCriterion(''); }}><option value="">Select an application</option>{application && !filtered.applications.includes(application) && <option value={application} disabled>Selected application is outside the display filters</option>}{filtered.applications.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="awards-field"><Label htmlFor="report-criterion">Reported criterion</Label><select id="report-criterion" className="awards-select" value={criterion} disabled={!application || !filtered.criteriaOptions.length} onChange={event => setCriterion(event.target.value)}><option value="">Select a criterion</option>{criterion && !filtered.criteriaOptions.includes(criterion) && <option value={criterion} disabled>Selected criterion is outside the current view</option>}{filtered.criteriaOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
        <p className="awards-help">Criterion IDs/labels and judge aliases are exactly those supplied by the report. Comments are plain text. No draft answers or inferred identities are added.</p>
        {application && !filtered.criteriaOptions.length && <p className="awards-help">No submitted criterion responses match this application and the current display filters.</p>}
      </div>}
      {section !== 'criteria' || (application && criterion) ? <ReportTable key={`${section}:${incompleteOnly}:${discrepancyOnly}:${application}:${criterion}:${workloadState}:${workloadIncluded}:${workloadScored}`} section={section} rows={filtered[section]} columns={REPORT_COLUMNS[section]} title={REPORT_LABELS[section]} emptyMessage={section === 'summaries' ? 'No applications match these display filters. Clear them to inspect the full report.' : section === 'matrix' ? 'No submitted assessment rows match these application filters. Draft assessments are not shown.' : section === 'workload' ? 'No assignment workload rows match these filters. Clear filters or reload the complete server report; no unreturned assignments or draft activity are inferred.' : 'No submitted responses match the selected application, criterion and display filters.'} />
        : <p className="awards-help rounded-lg border p-5">Select an application and criterion to view its submitted judge responses and criteria-version references.</p>}
    </>}
    {ready && <ReportAssessmentHistory key={`${tenant.scopeKey}:${roundId}:${query.dataUpdatedAt}`} tenant={tenant} roundId={roundId} applications={query.data.applications} />}
    <section className="rounded-lg border p-4 space-y-4">
      <h3 className="font-semibold">Download the complete server report</h3>
      <p className="awards-help">CSV and PDF export the complete chosen section, not the current page or filtered rows. Excel always includes all four sheets: application summaries, submitted judge matrix, criterion responses and assignment workload status. A new server snapshot is generated for every download and may differ from the displayed snapshot.</p>
      <fieldset disabled={!ready || exporting} className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="award-report-format">File format</Label><select id="award-report-format" className="awards-select" value={exportFormat} onChange={event => { setExportFormat(event.target.value); setExportError(''); setNotice(''); }}><option value="csv">CSV — one complete section</option><option value="xlsx">Excel — all four sheets</option><option value="pdf">PDF — one complete section</option></select></div>
          {exportFormat !== 'xlsx' && <div className="awards-field"><Label htmlFor="award-report-export-section">Complete section to export</Label><select id="award-report-export-section" className="awards-select" value={exportSection} onChange={event => { setExportSection(event.target.value); setExportError(''); setNotice(''); }}>{Object.entries(REPORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
        </div>
        <Button type="button" onClick={async () => {
          if (pending.current || !ready) return;
          const controller = new AbortController(); pending.current = controller; setExporting(true); setExportError(''); setNotice('');
          let url;
          try {
            const file = await fetchAwardReportExport({ roundId, format: exportFormat, section: exportSection, tenant, signal: controller.signal });
            tenant.assertCurrent();
            if (!active.current || controller.signal.aborted) return;
            url = URL.createObjectURL(file.blob);
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
            try { document.body.appendChild(anchor); anchor.click(); } finally { anchor.remove(); }
            const ownedUrl = url;
            const timer = window.setTimeout(() => { URL.revokeObjectURL(ownedUrl); urls.current.delete(ownedUrl); }, 1000);
            urls.current.set(url, timer); url = null;
            setNotice('Verified server-generated report handed to your browser for download. No filtered or partial fallback was generated.');
          } catch (failure) {
            if (active.current && failure.name !== 'AbortError') setExportError(`${failure.message}${exportFormat === 'pdf' ? ' If the PDF font cannot represent the text, choose CSV or Excel to preserve all characters.' : ''}`);
          } finally {
            if (url) URL.revokeObjectURL(url);
            if (pending.current === controller) pending.current = null;
            if (active.current) setExporting(false);
          }
        }}>{exporting ? 'Generating complete server export…' : exportFormat === 'xlsx' ? 'Download complete Excel workbook' : `Download complete ${exportFormat.toUpperCase()} section`}</Button>
      </fieldset>
      <p className="awards-help">PDF may decline unsupported characters; CSV and Excel preserve the report text. Changing rounds cancels an in-progress download. Export URLs and filenames contain only the canonical round UUID and format/section, never answers, aliases or application references.</p>
      {exportError && <p role="alert" className="text-sm text-red-800">{exportError}</p>}
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    </section>
  </div>;
}

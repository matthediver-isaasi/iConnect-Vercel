import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Award, ChevronLeft, ChevronRight, Download, Loader2, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CertificatePdfCanvasPreview } from "@/components/events/AttendeeCpdCertificateDialog";
import MemberCpdPointsLedger from "@/components/MemberCpdPointsLedger";

const PAGE_SIZE = 20;

async function fetchHistory(memberId, page) {
  const response = await fetch(`/api/members/${memberId}/cpd-points?page=${page}&pageSize=${PAGE_SIZE}`, {
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to load CPD points history");
  return data;
}

async function fetchCertificateMetadata(memberId, ids) {
  const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/cpd-certificate?ledger_entry_ids=${ids.map(encodeURIComponent).join(",")}`, {
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to load certificate availability");
  return data.certificates || {};
}

async function fetchCertificatePdf(memberId, id, signal) {
  const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/cpd-certificate?ledger_entry_id=${encodeURIComponent(id)}&format=pdf`, {
    credentials: "include", signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not load the certificate PDF");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) {
    throw new Error("The certificate response was not a PDF");
  }
  return new Uint8Array(await response.arrayBuffer());
}

function formatPoints(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(number);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function triggerLabel(item) {
  if (item.entry_kind === "manual_adjustment") return "Adjustment";
  if (item.entry_kind === "imported_award") return "Historical import";
  if (item.entry_kind === "reversal") return "Reversal";
  return item.award_trigger === "attendance" ? "Attendance" : "Registration";
}

export function MemberCpdPointsHistoryView({ data = {}, page, setPage, isFetching = false, renderActions, correctionStatus, renderCertificate }) {
  const items = data.items || [];
  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.pageSize || PAGE_SIZE)));
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5 text-amber-600" />CPD points</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Current balance</p>
          <p className="text-4xl font-semibold tabular-nums" data-testid="member-cpd-points-balance">{formatPoints(data.balance)}</p>
          <p className="mt-2 text-sm text-muted-foreground">Calculated from all awards and reversals in the audit ledger.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Points history</CardTitle>
          <p className="text-sm text-muted-foreground">A chronological record of awarded and reversed points.</p>
          {correctionStatus && <p role="status" className="text-sm text-muted-foreground">{correctionStatus}</p>}
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground" data-testid="member-cpd-points-empty">
              <Award className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No CPD points recorded yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table aria-label="CPD points history">
                <TableHeader><TableRow>
                  <TableHead>Event or activity</TableHead><TableHead>Ticket</TableHead>
                  <TableHead>Trigger</TableHead><TableHead>Evidence date</TableHead>
                   <TableHead>Status</TableHead><TableHead className="text-right">Points</TableHead>
                   {renderCertificate && <TableHead>Certificate</TableHead>}
                   {renderActions && <TableHead>Corrections</TableHead>}
                </TableRow></TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-52">
                        <p className="font-medium">{item.event_name}</p>
                        {item.activity_description && <p className="text-xs text-muted-foreground mt-1">{item.activity_description}</p>}
                      </TableCell>
                      <TableCell>{item.ticket_name_snapshot || "—"}</TableCell>
                      <TableCell>{triggerLabel(item)}</TableCell>
                      <TableCell>{formatDate(item.evidence_date)}</TableCell>
                      <TableCell>
                        {item.entry_kind === "manual_adjustment"
                          ? <Badge variant="secondary">Adjustment</Badge>
                          : item.entry_kind === "reversal"
                          ? <Badge variant="destructive">Reversal</Badge>
                          : item.is_reversed
                            ? <Badge variant="secondary">Reversed</Badge>
                            : <Badge variant="default">Awarded</Badge>}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {Number(item.points_value) > 0 ? "+" : ""}{formatPoints(item.points_value)}
                      </TableCell>
                       {renderCertificate && <TableCell>{renderCertificate(item)}</TableCell>}
                       {renderActions && <TableCell>{renderActions(item)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {Number(data.total || 0) > PAGE_SIZE && (
            <nav className="mt-4 flex items-center justify-between" aria-label="CPD points history pagination">
              <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage(value => value - 1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" />Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage(value => value + 1)}>
                  Next<ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </nav>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MemberCpdPointsTab({ memberId, enabled = true, canCorrect = false, certificates = false, pdfEngine }) {
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [pdfError, setPdfError] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const requestRef = useRef(null);
  const urlsRef = useRef(new Set());
  const query = useQuery({
    queryKey: ["member-cpd-points", memberId, page],
    enabled: enabled && !!memberId,
    queryFn: () => fetchHistory(memberId, page),
    placeholderData: (previous) => previous,
  });
  const certificateIds = enabled && certificates && !query.isPlaceholderData
    ? (query.data?.items || []).filter(item => ["event_award", "imported_award"].includes(item.entry_kind) && Number(item.points_value) > 0 && !item.is_reversed)
      .slice(0, PAGE_SIZE).map(item => String(item.id))
    : [];
  const certificateQuery = useQuery({
    queryKey: ["member-cpd-certificates", memberId, certificateIds],
    enabled: enabled && certificates && !!memberId && certificateIds.length > 0,
    queryFn: () => fetchCertificateMetadata(memberId, certificateIds),
  });

  useEffect(() => () => {
    requestRef.current?.abort();
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);
  useEffect(() => {
    requestRef.current?.abort();
    setPdfBusy(false);
    setPreview(null);
    setPdfError("");
  }, [memberId, page, enabled]);

  async function openCertificate(item, download = false) {
    if (pdfBusy) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setPdfBusy(true);
    setPdfError("");
    if (!download) setPreview({ item, bytes: null });
    try {
      const bytes = await fetchCertificatePdf(memberId, item.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!download) {
        setPreview({ item, bytes });
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        urlsRef.current.add(url);
        const link = document.createElement("a");
        link.href = url;
        link.download = certificateQuery.data?.[item.id]?.filename || "cpd-certificate.pdf";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          urlsRef.current.delete(url);
        }, 1000);
      }
    } catch (error) {
      if (!controller.signal.aborted) setPdfError(error.message || "Could not load the certificate PDF");
    } finally {
      if (!controller.signal.aborted) setPdfBusy(false);
    }
  }

  function closePreview() {
    requestRef.current?.abort();
    setPdfBusy(false);
    setPdfError("");
    setPreview(null);
  }

  function renderCertificate(item) {
    if (!["event_award", "imported_award"].includes(item.entry_kind) || !(Number(item.points_value) > 0) || item.is_reversed) return <span className="text-muted-foreground">—</span>;
    if (certificateQuery.isPending || certificateQuery.isFetching || query.isPlaceholderData) return <span role="status" className="text-sm text-muted-foreground">Checking…</span>;
    if (certificateQuery.isError) return (
      <div className="space-y-1 text-sm">
        <p className="text-destructive">Could not check certificates</p>
        <Button size="sm" variant="outline" onClick={() => certificateQuery.refetch()}>Retry certificates</Button>
      </div>
    );
    const status = certificateQuery.data?.[item.id];
    if (!status) return (
      <div className="space-y-1 text-sm">
        <p className="text-destructive">Certificate status could not be checked</p>
        <Button size="sm" variant="outline" onClick={() => certificateQuery.refetch()}>Retry certificates</Button>
      </div>
    );
    if (!status.available) return (
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{status.reason || "Certificate unavailable"}</p>
        {status.retryable && <Button size="sm" variant="outline" onClick={() => certificateQuery.refetch()}>Retry certificates</Button>}
      </div>
    );
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pdfBusy} onClick={() => openCertificate(item)}>View certificate</Button>
        <Button size="sm" variant="outline" disabled={pdfBusy} onClick={() => openCertificate(item, true)}><Download className="h-4 w-4 mr-1" />Download PDF</Button>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="flex justify-center py-16" aria-label="Loading CPD points history"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (query.isError) {
    return (
      <Card><CardContent className="py-16 text-center text-muted-foreground">
        <ShieldX className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">Couldn&apos;t load CPD points history</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button>
      </CardContent></Card>
    );
  }
  return (
    <>
      {certificates && pdfError && !preview && <p role="alert" className="text-sm text-destructive">
        {pdfError} <Button variant="outline" size="sm" onClick={() => setPdfError("")}>Dismiss</Button>
      </p>}
      <MemberCpdPointsLedger memberId={memberId} enabled={enabled} canCorrect={canCorrect}>
        {(corrections) => <MemberCpdPointsHistoryView data={query.data} page={page} setPage={setPage}
          isFetching={query.isFetching} renderCertificate={certificates ? renderCertificate : undefined} {...corrections} />}
      </MemberCpdPointsLedger>
      {certificates && <Dialog open={!!preview} onOpenChange={open => { if (!open) closePreview(); }}>
        <DialogContent className="w-[95vw] max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>CPD certificate — {preview?.item?.event_name}</DialogTitle>
            <DialogDescription>Preview the certificate and download the PDF.</DialogDescription>
          </DialogHeader>
          {pdfBusy && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading certificate…</p>}
          {pdfError && <p role="alert" className="text-sm text-destructive">{pdfError}</p>}
          {preview?.bytes && <CertificatePdfCanvasPreview bytes={preview.bytes} pdfEngine={pdfEngine} />}
          <DialogFooter>
            {pdfError && <Button variant="outline" onClick={() => openCertificate(preview.item)}>Retry PDF</Button>}
            <Button variant="outline" onClick={closePreview}>Close</Button>
            {preview?.bytes && <Button onClick={() => openCertificate(preview.item, true)} disabled={pdfBusy}><Download className="h-4 w-4 mr-1" />Download PDF</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>}
    </>
  );
}
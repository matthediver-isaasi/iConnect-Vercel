import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Award, ChevronLeft, ChevronRight, Download, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

async function loadHistory(endpoint, page) {
  const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}&page_size=${PAGE_SIZE}`, {
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Could not load speaker awards (${response.status})`);
  return body;
}

async function openPrivateFile(url, filename, download) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Award file unavailable (${response.status})`);
  }
  const blob = await response.blob();
  if (filename.endsWith(".pdf") && !blob.type.toLowerCase().includes("application/pdf")) {
    throw new Error("Certificate response was not a PDF");
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  if (download) link.download = filename;
  else link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the navigation/download before revoking.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function SpeakerAwardsHistoryView({ data, page, setPage, isFetching, onFile, error, member = false }) {
  const records = data?.awards || [];
  const total = Number(data?.pagination?.total || 0);
  const totalPages = Math.max(1, Number(data?.pagination?.total_pages || 1));
  if (member && total === 0) return null;
  return (
    <Card data-testid={member ? "member-speaker-awards" : "speaker-awards-history"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Award className="w-5 h-5" />Speaker Awards</CardTitle>
        <p className="text-sm text-muted-foreground">
          {member ? "Recognition earned as a speaker. This is separate from your CPD points and attendee certificates." : "Awards recorded for this speaker across events."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {!records.length ? (
          <p className="text-sm text-muted-foreground">No speaker awards recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {records.map(record => (
              <div key={record.id} className="rounded-md border p-3 space-y-2" data-testid={`speaker-award-${record.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{record.event_title || "Event unavailable"}</p>
                  <time className="text-sm text-muted-foreground" dateTime={record.awarded_at || undefined}>{formatDate(record.awarded_at)}</time>
                </div>
                <p className="text-sm text-muted-foreground">Status: {record.status || "Unavailable"}</p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Badge: {record.badge?.name || "None"}{record.badge?.status ? ` · ${record.badge.status}` : ""}{record.badge?.evidence ? ` · ${record.badge.evidence}` : ""}</span>
                  {record.badge?.image_url && record.badge.status !== "revoked" && (
                    <Button variant="outline" size="sm" onClick={() => onFile(record.badge.image_url, `speaker-badge-${record.id}`, false)}>
                      <Eye className="h-4 w-4 mr-1" />View artwork
                    </Button>
                  )}
                  {record.badge?.name && <span className="text-xs text-muted-foreground">Artwork is not a verifiable credential.</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Certificate: {record.certificate?.status || "Not issued"}{record.certificate?.error ? ` · ${record.certificate.error}` : ""}</span>
                  {record.certificate?.available && record.certificate.status !== "revoked" && record.status !== "revoked" && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => onFile(`/api/speaker-awards/certificate?id=${encodeURIComponent(record.id)}`, `speaker-certificate-${record.id}.pdf`, false)}>
                        <Eye className="h-4 w-4 mr-1" />Preview
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => onFile(`/api/speaker-awards/certificate?id=${encodeURIComponent(record.id)}&download=1`, `speaker-certificate-${record.id}.pdf`, true)}>
                        <Download className="h-4 w-4 mr-1" />Download
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {totalPages > 1 && (
          <nav className="flex items-center justify-between" aria-label="Speaker awards pagination">
            <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage(page - 1)}><ChevronLeft className="w-4 h-4" />Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage(page + 1)}>Next<ChevronRight className="w-4 h-4" /></Button>
            </div>
          </nav>
        )}
      </CardContent>
    </Card>
  );
}

export default function SpeakerAwardsHistory({ endpoint, member = false }) {
  const [page, setPage] = useState(1);
  const [fileError, setFileError] = useState("");
  const query = useQuery({
    queryKey: ["speaker-awards-history", endpoint, page],
    queryFn: () => loadHistory(endpoint, page),
    enabled: !!endpoint,
    placeholderData: previous => previous,
  });
  if (query.isLoading) return member ? null : <p role="status" className="text-sm text-muted-foreground">Loading speaker awards…</p>;
  if (query.isError) return (
    <Card><CardContent className="py-6">
      <p role="alert" className="text-sm text-red-600">{query.error.message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button>
    </CardContent></Card>
  );
  return <SpeakerAwardsHistoryView data={query.data} page={page} setPage={setPage} isFetching={query.isFetching}
    member={member} error={fileError} onFile={async (...args) => {
      setFileError("");
      try { await openPrivateFile(...args); } catch (err) { setFileError(err.message); }
    }} />;
}
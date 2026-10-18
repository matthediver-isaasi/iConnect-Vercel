import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AgreementSignatureRequests({ quoteId, request, requestedId, onSign }) {
  const open = useRef(onSign);
  open.current = onSign;
  const opened = useRef("");
  const query = useQuery({
    queryKey: ["quote-signing-requests", quoteId],
    queryFn: () => request(`/api/sales/quotes/${encodeURIComponent(quoteId)}?action=signing-requests`, { credentials: "include" }),
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!requestedId || requestedId === opened.current) return;
    const item = query.data?.items?.find(row => row.id === requestedId);
    if (item?.canSign) { opened.current = requestedId; open.current(item); }
  }, [query.data, requestedId]);
  return <Card><CardHeader className="pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle className="text-base">Internal signature requests</CardTitle><Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh requests</Button></div></CardHeader><CardContent>
    {query.isPending ? <div role="status" className="h-12 animate-pulse rounded bg-muted" /> : query.error ? <p role="alert" className="text-sm text-destructive">{query.error.message} Use Refresh requests to retry.</p> : !query.data?.items?.length ? <p className="text-sm text-muted-foreground">No internal requests. Use Send and select a colleague to request their signature.</p> : <ul className="divide-y">{query.data.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 text-sm"><p className="font-medium">{item.senderName || item.senderEmail} · Version {item.version}</p><p className="break-words text-xs text-muted-foreground">{item.status} · Notification {item.notificationStatus} · {item.draft?.recipient}</p>{item.notificationStatus === "failed" && <p className="mt-1 text-xs text-destructive">Notification failed. Wait at least 60 seconds, then request again through Send.</p>}{requestedId === item.id && !item.canSign && <p className="mt-1 text-xs text-muted-foreground">Only the selected colleague can sign a pending request for the current version. Sign in with their account or contact the sender.</p>}</div>{item.canSign && <Button type="button" size="sm" onClick={() => open.current(item)}>Review, sign and send</Button>}</li>)}</ul>}
    {!query.isPending && requestedId && !query.data?.items?.some(item => item.id === requestedId) && <p role="alert" className="mt-3 text-sm text-muted-foreground">This signing request was not found. Refresh the list or contact the requester.</p>}
  </CardContent></Card>;
}

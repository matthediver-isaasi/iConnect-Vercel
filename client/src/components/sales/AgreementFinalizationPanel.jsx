import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AgreementFinalizationPanel({ agreement, onFinalize, onDownload, onRefresh }) {
  const retry = useMutation({ mutationFn: onFinalize, onSuccess: () => onRefresh?.() });
  const notices = agreement?.completionNotifications;
  const retryNotices = notices && Object.values(notices).some(status => status !== "sent");
  return <Card><CardHeader><CardTitle className="text-base">Signed agreement PDF</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">Acceptance is recorded. {agreement?.downloadAvailable ? "The final signed document is ready." : agreement?.finalizationStatus === "failed" ? "PDF preparation failed. Retry without asking either party to sign again." : "The final signed document is being prepared."}</p>
    {notices && <p className="text-xs text-muted-foreground">Completion email: sender {notices.sender || "pending"} · customer {notices.customer || "pending"}. Failed emails can be retried after 60 seconds without signing again.</p>}
    {agreement?.downloadAvailable && <Button type="button" variant="outline" onClick={onDownload}>Download signed agreement</Button>}
    {(!agreement?.downloadAvailable || retryNotices) && <Button type="button" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "Preparing signed PDF / emails…" : agreement?.downloadAvailable ? "Retry completion emails" : "Retry / check signed PDF"}</Button>}
    {retry.error && <p role="alert" className="text-sm text-destructive">{retry.error.message}</p>}
  </CardContent></Card>;
}

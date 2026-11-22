import { useState } from "react";
import { Archive, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PolicyEditor from "@/components/member-lifecycle/PolicyEditor";
import ImpactPreview from "@/components/member-lifecycle/ImpactPreview";
import MemberReviewDialog from "@/components/member-lifecycle/MemberReviewDialog";
import OperationsHistory from "@/components/member-lifecycle/OperationsHistory";
import CleanupReview from "@/components/member-lifecycle/CleanupReview";
import { EvidenceValue, ErrorRetry, Loading, Notice, Panel, RecordTable } from "@/components/member-lifecycle/LifecycleUI";
import { useMemberLifecycle } from "@/components/member-lifecycle/useMemberLifecycle";
import "@/components/member-lifecycle/member-lifecycle.css";

export default function MemberLifecycle() {
  const lifecycle = useMemberLifecycle();
  const { config, review, detail, preview, pending, feedback } = lifecycle;
  const [selectedId, setSelectedId] = useState(null);
  const [dirtyRevision, setDirtyRevision] = useState(null);
  const data = config.data;
  const reviewReady = data?.reviewReady === true || data?.executionReady === true;
  const dirty = !!data && dirtyRevision === data.revision;
  const select = memberId => { if (!reviewReady) return; setSelectedId(memberId); void lifecycle.loadDetail(memberId); };
  const close = () => { if (!pending) { setSelectedId(null); void lifecycle.loadDetail(null); } };
  const save = policy => lifecycle.mutate("save", { policy, expectedRevision: data.revision }, "PUT");
  const approve = confirmed => {
    if (confirmed !== true || !data?.permissions.configure || data.executionReady !== true || dirty || preview?.complete !== true
      || preview.nextCursor || !preview.previewId || preview.revision !== data.revision) return;
    void lifecycle.mutate("approve", { action: "approve", confirmed: true, previewId: preview.previewId, expectedRevision: data.revision });
  };

  return <main className="member-lifecycle min-h-[100dvh] space-y-6" aria-label="Member lifecycle administration">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="ml-step mb-2">Membership administration</p><h1 className="flex items-center gap-3 text-3xl font-semibold"><Archive className="h-7 w-7 shrink-0" aria-hidden="true" />Member lifecycle</h1>
        <p className="ml-muted mt-2 max-w-2xl text-sm">Understand why a record is retained, held or ready for review. Every decision starts with evidence.</p></div>
      <div className="flex items-center gap-3">
        {data?.permissions.view === true && <Badge variant="outline">{!data.executionReady ? data.reviewReady === true ? "Review only · execution unavailable" : "Preparation only" : data.enabled ? "Automation enabled" : "Automation paused"}</Badge>}
        <Button variant="outline" disabled={!!pending || config.loading} onClick={() => { if (!dirty || window.confirm("Reload authoritative state? Unsaved policy changes remain until discarded or the revision changes.")) void lifecycle.reload(); }}><RefreshCw className="h-4 w-4" aria-hidden="true" />{config.loading ? "Reloading…" : "Reload"}</Button>
      </div>
    </header>
    {feedback && <Notice tone={feedback.tone}>{feedback.message}</Notice>}
    {config.loading && <Loading label="Verifying policy and permissions…" />}
    {config.error && <ErrorRetry message={config.error} onRetry={lifecycle.reload} disabled={!!pending || config.loading} />}
    {data?.permissions.view !== true && data && <Notice tone="warning" title="Access restricted">Your current permissions do not allow member lifecycle review. Ask a tenant administrator for the appropriate access.</Notice>}
    {data?.permissions.view === true && <>
      {(!data.executionReady || data.readinessIssues.length > 0) && <Notice tone="warning" title={data.executionReady ? "Readiness issues reported" : "Execution blocked — not ready"}>
        <p className="mb-2">{data.executionReady ? "Review the server-reported issues before taking action." : "Rules cannot be approved while execution is unavailable. A preview is not permission to process live records."}</p>
        {data.readinessIssues.length > 0 ? <EvidenceValue value={data.readinessIssues} /> : <p>The server has not supplied a readiness explanation. Ask an administrator to investigate; approval remains disabled.</p>}
      </Notice>}
      <section className="rounded-xl border border-[#c2d5db] bg-[#edf5f8] p-5" aria-labelledby="lifecycle-safeguards">
        <h2 id="lifecycle-safeguards" className="font-semibold">Archive first. Review disposal separately.</h2>
        <p className="mt-2 max-w-5xl text-sm leading-relaxed">Archiving is reversible before minimisation: member access stops, personal data stays. Minimisation is separately reviewed and cannot restore removed data. Permanent deletion requires one authorised administrator, not two; financial, legal and unresolved-evidence blockers still apply.</p>
        <p className="ml-muted mt-2 text-xs">Unknown history or missing reliable activity dates creates an evidence-review hold. Eligibility never automatically deletes or minimises data. Historical membership, CPD, attendance and protected financial records remain subject to retention safeguards.</p>
      </section>
      <div className="ml-grid">
        <PolicyEditor key={data.revision} config={data} pending={pending || (config.loading ? "reload" : null)} onSave={save} onDirty={value => setDirtyRevision(value ? data.revision : null)} />
        <ImpactPreview config={data} preview={preview} pending={pending || (config.loading ? "reload" : null)} dirty={dirty} onPreview={lifecycle.runPreview} onApprove={approve} onPause={() => lifecycle.mutate("pause", { action: "pause", expectedRevision: data.revision })} onSelect={select} />
      </div>
      <Panel step="03 / Decide" title="Archive review" description="Inspect evidence, dates, obligations and audit history for each member. Retain creates a durable hold; extensions set a future review date.">
        {!reviewReady && <div className="ml-panel-body"><Notice tone="warning" title="Member review is unavailable">The server has not confirmed review readiness. No member decisions are available.</Notice></div>}
        {reviewReady && !data.executionReady && <div className="ml-panel-body"><Notice>Non-destructive decisions are available: retain, extend and exempt. Automatic transitions and disposal remain blocked.</Notice></div>}
        {reviewReady && review.loading && !review.data && <Loading />}
        {reviewReady && review.error && <ErrorRetry message={review.error} onRetry={() => lifecycle.loadReview()} disabled={!!pending || review.loading} />}
        {reviewReady && review.data && <>
          {review.data.items.length > 0
            ? <RecordTable items={review.data.items} onSelect={select} disabled={!!pending || review.loading || config.loading} />
            : <div className="ml-empty"><h3 className="font-semibold">No records on this review page</h3><p className="ml-muted mx-auto mt-2 max-w-xl text-sm">The server returned no review items for this page. This is not an impact preview or evidence that all member records are eligible, retained or reviewed.</p></div>}
          <div className="ml-panel-body flex flex-wrap items-center justify-between gap-3 border-t">
            <p className="ml-muted text-xs">{review.data.items.length} review rows loaded · {review.data.nextCursor ? "More records available" : "End of available pages"}</p>
            {review.data.nextCursor && <Button variant="outline" onClick={() => lifecycle.loadReview(review.data.nextCursor)} disabled={!!pending || review.loading}>{review.loading ? "Loading records…" : "Load more review records"}</Button>}
          </div>
        </>}
      </Panel>
      <OperationsHistory resource={lifecycle.operations} pending={pending || config.loading} onLoad={lifecycle.loadOperations}
        permissions={data.permissions} executionReady={data.executionReady} onAction={lifecycle.mutate} />
      {(data.permissions.minimise === true || data.permissions.delete === true) && <CleanupReview resource={lifecycle.cleanup} executionReady={data.executionReady}
        pending={pending || config.loading} onLoad={lifecycle.loadCleanup} onAction={lifecycle.mutate} />}
      {selectedId && reviewReady && <MemberReviewDialog key={selectedId} memberId={selectedId} resource={detail} permissions={data.permissions} executionReady={data.executionReady} reviewReady={reviewReady}
        pending={pending || (config.loading ? "reload" : null)} feedback={feedback} timezone={data.policy.timezone} onClose={close} onRetry={() => lifecycle.loadDetail(selectedId)} onAction={lifecycle.mutate} />}
    </>}
  </main>;
}
